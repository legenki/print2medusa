import { clearRemovedMarker } from "./removed"
import type { PrintfulSyncVariant, StockPlan } from "./types"

/** Statuses that mean a variant cannot currently be ordered. */
const UNAVAILABLE = new Set([
  "out_of_stock",
  "temporary_out_of_stock",
  "discontinued",
])

/**
 * Decide what a product's stock state means for its publication.
 *
 * Pure: returns intent, performs nothing. The caller applies the marker rules
 * that keep this from overriding a merchant's own draft.
 *
 * An unrecognized or missing status counts as available. Printful can add a
 * status at any time, and treating the unknown as sold out would hide a
 * catalog on a value we simply have not seen before.
 */
export function planStockActions(
  variants: Array<Pick<PrintfulSyncVariant, "id" | "availability_status">>
): StockPlan {
  const variantAvailability: Record<string, string> = {}
  let anyAvailable = false
  let hasDiscontinued = false

  for (const v of variants) {
    const status = v.availability_status ?? "active"
    variantAvailability[String(v.id)] = status

    if (status === "discontinued") {
      hasDiscontinued = true
    }
    if (!UNAVAILABLE.has(status)) {
      anyAvailable = true
    }
  }

  // No variants at all is a data oddity, not evidence of a sellout.
  const allUnavailable = variants.length > 0 && !anyAvailable

  return {
    status: allUnavailable ? "draft" : "published",
    allUnavailable,
    hasDiscontinued,
    variantAvailability,
  }
}

/** Marks a product the plugin unpublished because Printful ran out of it. */
export const STOCK_MARKER_KEY = "printful_stock_status"

/** Set when Printful reports a variant as discontinued. Informational only. */
export const DISCONTINUED_MARKER_KEY = "printful_discontinued"

export type PublicationInput = {
  plan: StockPlan
  currentStatus: "published" | "draft"
  currentMetadata: Record<string, unknown>
}

export type PublicationResult = {
  status: "published" | "draft"
  metadata: Record<string, unknown>
  /** False when nothing needs writing, so the caller can skip the update. */
  changed: boolean
}

/**
 * Apply the stock plan without overriding the merchant.
 *
 * The plugin owns only the transitions it caused: it marks a product when it
 * unpublishes one for being sold out, and re-publishes only a product carrying
 * that marker. A product the merchant drafted themselves — no marker — is left
 * exactly as they left it, however available Printful says it is.
 */
export function resolvePublication(input: PublicationInput): PublicationResult {
  const { plan, currentStatus, currentMetadata } = input
  const metadata = { ...currentMetadata }
  const marked = currentMetadata[STOCK_MARKER_KEY] === "unavailable"

  if (plan.allUnavailable) {
    // Only claim ownership of an unpublish we are actually performing. A
    // product already drafted without our marker was drafted by the merchant,
    // and marking it would make us republish their draft on restock.
    if (currentStatus === "draft") {
      return { status: "draft", metadata, changed: false }
    }
    metadata[STOCK_MARKER_KEY] = "unavailable"
    return { status: "draft", metadata, changed: true }
  }

  // Available again. Only undo an unpublish we performed.
  if (currentStatus === "draft") {
    if (!marked) {
      return { status: "draft", metadata, changed: false }
    }
    delete metadata[STOCK_MARKER_KEY]
    return { status: "published", metadata, changed: true }
  }

  if (marked) {
    delete metadata[STOCK_MARKER_KEY]
    return { status: "published", metadata, changed: true }
  }

  return { status: "published", metadata, changed: false }
}

export type ProductSyncPublication = {
  status: "published" | "draft"
  metadata: Record<string, unknown>
}

/**
 * Decide the status and metadata to write for a product that already exists in
 * Medusa. The mapper's `status` is what Printful stock alone would imply; this
 * reconciles it with what the merchant has since done to the product.
 *
 * The mapper's raw status is deliberately never returned. Writing it directly
 * is what republished merchant drafts on every sync: it is derived from stock
 * with no knowledge of who drafted the product or why.
 */
export function resolveExistingProductWrite(input: {
  plan: StockPlan
  currentStatus: "published" | "draft"
  currentMetadata: Record<string, unknown>
  mappedMetadata: Record<string, unknown>
}): ProductSyncPublication {
  const { plan, currentStatus, currentMetadata, mappedMetadata } = input

  const publication = resolvePublication({
    plan,
    currentStatus,
    currentMetadata,
  })

  // Printful-derived keys win over the stored copies of themselves, but the
  // marker decision is made against the *current* metadata and must survive
  // the merge — the mapper never writes STOCK_MARKER_KEY.
  let metadata: Record<string, unknown> = {
    ...publication.metadata,
    ...mappedMetadata,
  }

  if (publication.metadata[STOCK_MARKER_KEY] === undefined) {
    delete metadata[STOCK_MARKER_KEY]
  } else {
    metadata[STOCK_MARKER_KEY] = publication.metadata[STOCK_MARKER_KEY]
  }

  // Seen again on Printful — drop the removal flag even if stock still keeps
  // the product draft (all variants out of stock).
  metadata = clearRemovedMarker(metadata)

  return { status: publication.status, metadata }
}
