import { medusaLineIdFor } from "./bundle"

/** What Medusa still has open on one order line. */
export type OpenOrderLine = {
  id: string
  quantity: number
  fulfilled_quantity?: number
}

/** A Printful order item, as GET /orders/{id} reports it. */
export type PrintfulOrderLine = {
  id: number | string
  external_id?: string | null
  quantity: number
}

/** One Printful parcel, in the order Printful lists them. */
export type ParcelInput = {
  printful_shipment_id: string
  /** Undefined when Printful omitted the per-parcel breakdown. */
  items?: Array<{ item_id: number; quantity: number }>
}

export type ParcelItems = { id: string; quantity: number }[]

/**
 * Which Medusa line quantities each not-yet-recorded parcel fulfils.
 *
 * Ordinary lines are simple: a parcel carrying two shirts fulfils two units of
 * the shirt's line. Bundles are not. A bundle line stands for several Printful
 * items, and Printful may ship them in different parcels. Mapping each member
 * straight onto the bundle line — what this replaced — closed the whole
 * bundle with the first parcel that held any of it, so the customer was told
 * their order had shipped while most of it was still being printed.
 *
 * Here a bundle unit counts as fulfilled only once every member of it has
 * shipped. Shipped member quantities are accumulated across *all* parcels in
 * Printful's order, recorded ones included, so the parcel that carries the
 * last member is the one that fulfils the bundle.
 *
 * Every request is clamped to what Medusa still has open: Printful can report
 * more than is outstanding (a reshipment, a partial cancel), and over-asking
 * makes Medusa throw "Cannot fulfill more items than what was ordered".
 *
 * A parcel without a breakdown falls back to every *Printful* line in full,
 * still clamped. Lines with no Printful item behind them — the other half of a
 * mixed cart — are never fulfilled by a Printful parcel.
 */
export function planParcelItems(input: {
  orderLines: OpenOrderLine[]
  printfulItems: PrintfulOrderLine[]
  parcels: ParcelInput[]
  recorded: Set<string>
}): Map<string, ParcelItems> {
  const lineQuantity = new Map<string, number>()
  const remaining = new Map<string, number>()
  for (const line of input.orderLines) {
    const quantity = Number(line.quantity)
    lineQuantity.set(line.id, quantity)
    remaining.set(
      line.id,
      Math.max(0, quantity - Number(line.fulfilled_quantity ?? 0))
    )
  }

  // Printful item id → the Medusa line it belongs to, and, for a bundle
  // member, its own external id (the member's identity within the bundle).
  const byItemId = new Map<string, { lineId: string; member?: string }>()
  // Bundle line → member external id → total units Printful was asked for.
  const bundleMembers = new Map<string, Map<string, number>>()
  const printfulLines = new Set<string>()

  for (const item of input.printfulItems) {
    if (!item.external_id) {
      continue
    }
    const lineId = medusaLineIdFor(item.external_id)
    printfulLines.add(lineId)
    const isMember = lineId !== item.external_id
    byItemId.set(String(item.id), {
      lineId,
      ...(isMember ? { member: item.external_id } : {}),
    })
    if (isMember) {
      const members = bundleMembers.get(lineId) ?? new Map<string, number>()
      members.set(
        item.external_id,
        (members.get(item.external_id) ?? 0) + Number(item.quantity)
      )
      bundleMembers.set(lineId, members)
    }
  }

  const shippedMember = new Map<string, number>()

  /** Whole bundle units on a line whose every member has shipped. */
  const completeBundles = (lineId: string): number => {
    const units = lineQuantity.get(lineId) ?? 0
    const members = bundleMembers.get(lineId)
    if (!members || units <= 0) {
      return 0
    }
    let complete = units
    for (const [member, total] of members) {
      const perBundle = total / units
      const shipped = shippedMember.get(member) ?? 0
      complete = Math.min(
        complete,
        perBundle > 0 ? Math.floor(shipped / perBundle + 1e-9) : units
      )
    }
    return complete
  }

  const result = new Map<string, ParcelItems>()

  for (const parcel of input.parcels) {
    const before = new Map(
      [...bundleMembers.keys()].map((lineId) => [
        lineId,
        completeBundles(lineId),
      ])
    )
    const requested = new Map<string, number>()
    const add = (lineId: string, quantity: number) => {
      if (quantity > 0) {
        requested.set(lineId, (requested.get(lineId) ?? 0) + quantity)
      }
    }

    if (parcel.items === undefined) {
      // No breakdown: assume it completes everything Printful holds for us.
      for (const [member, total] of [...bundleMembers.values()].flatMap((m) => [
        ...m,
      ])) {
        shippedMember.set(member, total)
      }
      for (const lineId of printfulLines) {
        if (!bundleMembers.has(lineId)) {
          add(lineId, lineQuantity.get(lineId) ?? 0)
        }
      }
    } else {
      for (const entry of parcel.items) {
        const target = byItemId.get(String(entry.item_id))
        if (!target) {
          continue
        }
        if (target.member) {
          shippedMember.set(
            target.member,
            (shippedMember.get(target.member) ?? 0) + Number(entry.quantity)
          )
        } else {
          add(target.lineId, Number(entry.quantity))
        }
      }
    }

    for (const [lineId, completedBefore] of before) {
      add(lineId, completeBundles(lineId) - completedBefore)
    }

    // A recorded parcel already has its fulfillment, and its quantities are
    // already in `fulfilled_quantity`. It is walked only so bundle progress
    // accumulates in the right order.
    if (input.recorded.has(parcel.printful_shipment_id)) {
      continue
    }

    const items: ParcelItems = []
    for (const [lineId, quantity] of requested) {
      const open = remaining.get(lineId) ?? 0
      const take = Math.min(quantity, open)
      if (take > 0) {
        items.push({ id: lineId, quantity: take })
        remaining.set(lineId, open - take)
      }
    }
    result.set(parcel.printful_shipment_id, items)
  }

  return result
}
