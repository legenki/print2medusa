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
