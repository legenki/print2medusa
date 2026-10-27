/**
 * Order metadata the plugin owns, and how much of it to believe.
 *
 * Medusa copies `cart.metadata` onto the order at checkout
 * (core-flows complete-cart.js), and the Store API lets a customer write cart
 * metadata freely. So a `printful_*` key on an order is not, by itself,
 * evidence that this plugin wrote it — it may be a fake Printful order id,
 * status, parcel list or tracking link planted for the admin widget to show.
 *
 * Imported by the admin widget, so nothing here may reach a server package.
 */

/** Every order metadata key this plugin writes starts with this. */
export const PRINTFUL_METADATA_PREFIX = "printful_"

/**
 * Metadata with every plugin-owned key removed.
 *
 * Applied before the plugin's first write to an order: at that moment any
 * `printful_*` key present came from the customer's cart, and merging over it
 * would leave whatever the plugin does not overwrite in place.
 */
export function withoutPrintfulKeys(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !key.startsWith(PRINTFUL_METADATA_PREFIX)
    )
  )
}

/**
 * The Printful order id on a record, or null when it is absent or is not one.
 *
 * Printful order ids are positive integers. The `pending` claim sentinel is
 * not, and neither is anything a customer could have written to reach a
 * different endpoint once it is used as a path segment.
 */
export function printfulOrderIdFrom(
  record: { printful_order_id?: unknown } | null | undefined
): string | null {
  const raw = record?.printful_order_id
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null
  }
  const id = String(raw)
  return /^[1-9]\d*$/.test(id) ? id : null
}

/**
 * A tracking URL fit for an `href`, or null.
 *
 * Only http(s). React 18 renders a `javascript:` href as given, so a planted
 * parcel would otherwise run script in the admin when its link is clicked.
 */
export function safeTrackingUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) {
    return null
  }
  try {
    const { protocol } = new URL(url)
    return protocol === "https:" || protocol === "http:" ? url : null
  } catch {
    return null
  }
}
