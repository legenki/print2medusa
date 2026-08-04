import { STOCK_MARKER_KEY } from "./stock"

/**
 * What to do with a Medusa product whose Printful sync product is no longer
 * in the store catalogue.
 *
 * `unpublish` (default) sets the product to draft and marks it so restock /
 * re-add can republish. `ignore` leaves Medusa alone — useful when the
 * merchant manages publication by hand for a subset of the catalogue.
 *
 * Deletion is deliberately not offered: the plugin never deletes a merchant's
 * products.
 */
export type OnRemovedFromPrintful = "unpublish" | "ignore"

/** Set when the plugin unpublished a product because it vanished from Printful. */
export const REMOVED_MARKER_KEY = "printful_removed"

export type RemovedProductPlan = {
  action: "none" | "unpublish"
  status: "published" | "draft"
  metadata: Record<string, unknown>
}

/**
 * Decide what to write for a linked product that no longer appears in Printful.
 *
 * Pure: the caller applies the result. Same ownership rules as stock —
 * we only claim an unpublish we perform. A product the merchant already
 * drafted without our marker is left alone.
 */
export function planRemovedProductWrite(input: {
  policy: OnRemovedFromPrintful
  currentStatus: "published" | "draft"
  currentMetadata: Record<string, unknown>
}): RemovedProductPlan {
  const { policy, currentStatus, currentMetadata } = input
  const metadata = { ...currentMetadata }

  if (policy === "ignore") {
    return { action: "none", status: currentStatus, metadata }
  }

  // Already draft without a plugin marker — merchant owns it.
  if (currentStatus === "draft") {
    const alreadyOurs =
      metadata[STOCK_MARKER_KEY] === "unavailable" ||
      metadata[REMOVED_MARKER_KEY] === true
    if (!alreadyOurs) {
      return { action: "none", status: "draft", metadata }
    }
    // Keep markers consistent if we already unpublished for stock/removal.
    metadata[STOCK_MARKER_KEY] = "unavailable"
    metadata[REMOVED_MARKER_KEY] = true
    return { action: "none", status: "draft", metadata }
  }

  metadata[STOCK_MARKER_KEY] = "unavailable"
  metadata[REMOVED_MARKER_KEY] = true
  return { action: "unpublish", status: "draft", metadata }
}

/**
 * Whether this sync run may take products down.
 *
 * A partial run — `limit` set, for a smoke test or a manual spot-check — sees
 * only the first N products, so every product past the limit looks removed.
 * Acting on that would unpublish most of the catalogue from a run the merchant
 * expected to touch a handful of items.
 *
 * `"ignore"` turns the pass off entirely for merchants who curate publication
 * by hand.
 */
export function shouldRunRemovalPass(input: {
  policy: OnRemovedFromPrintful
  limit?: number
}): boolean {
  return input.limit == null && input.policy !== "ignore"
}

/**
 * Which linked products are missing from a full Printful listing.
 *
 * `seenSyncProductIds` is the set of Printful sync product ids returned by
 * the full list endpoint (including ignored ones — ignored still "exists").
 * Only a full catalogue pass may call this: a partial sync (`limit`) would
 * otherwise treat every product beyond the limit as removed.
 */
export function findMissingSyncProductLinks<
  T extends { printful_sync_product_id: string; medusa_product_id: string },
>(links: T[], seenSyncProductIds: Iterable<string>): T[] {
  const seen = new Set(
    [...seenSyncProductIds].map((id) => String(id).trim()).filter(Boolean)
  )
  return links.filter(
    (link) => !seen.has(String(link.printful_sync_product_id).trim())
  )
}

/**
 * Clear removal markers when a product is seen again on a later sync.
 * Stock publication may still keep the product draft if variants are OOS.
 */
export function clearRemovedMarker(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (metadata[REMOVED_MARKER_KEY] === undefined) {
    return metadata
  }
  const next = { ...metadata }
  delete next[REMOVED_MARKER_KEY]
  return next
}
