/**
 * Merch bundles: one Medusa product that stands for several Printful ones.
 *
 * Printful has no notion of a bundle — it fulfils individual items. So a
 * bundle is a Medusa product whose variant records which member variants it
 * contains, and order creation expands it back into those members.
 *
 * **Why expansion is mandatory rather than a nicety.** `create-printful-order`
 * resolves one order line to one Printful item via `item.variant_id`. A bundle
 * left unexpanded therefore ships a single thing where the customer bought
 * three — or, if the bundle variant has no Printful link at all, the order is
 * skipped as `no_printful_items` and nothing ships.
 */

/** Where a bundle's composition lives, on the variant and on the order line. */
export const BUNDLE_MEMBERS_KEY = "printful_bundle_members"

/** One product inside a bundle. */
export type BundleMember = {
  variant_id: string
  /** How many of this member per bundle. Defaults to one. */
  quantity?: number
}

/** The shape order expansion needs from a line. Narrower than Medusa's type. */
export type OrderLineForBundles = {
  id: string
  variant_id?: string | null
  title?: string | null
  quantity: number
  metadata?: Record<string, unknown> | null
}

export type ExpandedOrderLine = OrderLineForBundles & {
  /**
   * The bundle line this came from, when it came from one.
   *
   * Printful reports failures per item. Without this a merchant sees a failed
   * sticker with no way to tell which bundle sold it.
   */
  bundle_line_id?: string
}

/**
 * The members recorded on a line, or nothing.
 *
 * Metadata is free-form JSON, so this validates rather than trusts: something
 * else writing a string to this key must not crash order creation.
 */
export function bundleMembersOf(
  line: OrderLineForBundles | null | undefined
): BundleMember[] {
  const raw = (line?.metadata ?? {})[BUNDLE_MEMBERS_KEY]
  if (!Array.isArray(raw)) {
    return []
  }

  const members: BundleMember[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue
    }
    const variantId = (entry as BundleMember).variant_id
    if (typeof variantId !== "string" || !variantId.trim()) {
      continue
    }
    const quantity = Number((entry as BundleMember).quantity ?? 1)
    members.push({
      variant_id: variantId,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    })
  }

  return members
}

/**
 * Whether a line stands for several products.
 *
 * A line whose member list is empty is *not* a bundle. Treating it as one
 * would expand it to nothing, and an order of nothing looks identical to an
 * order Printful was never asked about. Left alone, it flows through the
 * ordinary unresolved-variant path, which reports it.
 */
export function isBundleLine(
  line: OrderLineForBundles | null | undefined
): boolean {
  return bundleMembersOf(line).length > 0
}

/**
 * Replace every bundle line with the lines it stands for.
 *
 * Composition is read from the line's own metadata, captured when the customer
 * bought — never looked up live. A merchant who edits a bundle after a sale
 * must not change what an already-placed order ships.
 *
 * Ordinary lines pass through untouched and keep their position, so a cart
 * mixing bundles and singles reaches Printful in the order it was built.
 */
export function expandOrderLines(
  lines: OrderLineForBundles[]
): ExpandedOrderLine[] {
  const out: ExpandedOrderLine[] = []

  for (const line of lines) {
    const members = bundleMembersOf(line)
    if (members.length === 0) {
      out.push(line)
      continue
    }

    for (const member of members) {
      out.push({
        // Synthesised, but stable and traceable: two bundles in one cart
        // cannot collide, and the id says where the line came from.
        id: `${line.id}::${member.variant_id}`,
        variant_id: member.variant_id,
        title: line.title,
        // Two bundles each holding two stickers is four stickers. Dropping
        // this multiplication ships a customer half their order.
        quantity: (member.quantity ?? 1) * Number(line.quantity || 1),
        metadata: {},
        bundle_line_id: line.id,
      })
    }
  }

  return out
}

/** Separates the bundle line id from the member variant id in a synthetic id. */
const SYNTHETIC_SEPARATOR = "::"

/**
 * The Medusa line an `external_id` from Printful refers to.
 *
 * Expansion sends synthetic ids like `ordli_abc::variant_tee` as `external_id`,
 * because Printful needs each item distinguishable and two members of one
 * bundle would otherwise share the bundle line's id.
 *
 * Fulfillment reads those ids back to decide which Medusa line a parcel filled.
 * Without this, a bundle's items resolve to an id no Medusa line has, every
 * parcel clamps to zero open quantity, and the order is never marked shipped.
 *
 * A member id maps back to the *bundle* line, since that is the line the
 * customer bought and the only one Medusa can fulfil.
 */
export function medusaLineIdFor(externalId: string): string {
  const at = externalId.indexOf(SYNTHETIC_SEPARATOR)
  return at === -1 ? externalId : externalId.slice(0, at)
}

/** Statuses meaning a variant cannot be ordered. Mirrors `stock.ts`. */
const UNAVAILABLE = new Set([
  "out_of_stock",
  "temporary_out_of_stock",
  "discontinued",
])

export type BundleAvailability = {
  available: boolean
  memberCount: number
  unavailableCount: number
}

/**
 * Whether a bundle can be sold, from the availability of its members.
 *
 * A bundle is a promise to ship all of it, so one sold-out member makes the
 * promise unkeepable however available the rest are.
 *
 * Reads `printful_availability_status`, which the sync already writes — no new
 * source of truth, and no second place to keep in step with Printful.
 *
 * An unknown status counts as available, matching `planStockActions`: the
 * unavailable set is a closed list, and a bundle must not be stricter about a
 * status than the member product itself is.
 */
export function planBundleAvailability(
  members: Array<Record<string, unknown> | null | undefined>
): BundleAvailability {
  let unavailable = 0

  for (const member of members) {
    const status = member?.printful_availability_status
    if (typeof status === "string" && UNAVAILABLE.has(status)) {
      unavailable += 1
    }
  }

  return {
    // An empty bundle is unavailable rather than vacuously available: there is
    // nothing to ship, which is not the same as everything being in stock.
    available: members.length > 0 && unavailable === 0,
    memberCount: members.length,
    unavailableCount: unavailable,
  }
}
