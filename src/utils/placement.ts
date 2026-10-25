/**
 * Where a newly imported product lives in Medusa: which sales channels sell it
 * and which shipping profile ships it.
 *
 * Both are required for a product to be buyable, and neither is implied by
 * creating it. The Store API only lists products in the publishable key's
 * sales channel, so a product with no channel is invisible on the storefront.
 * And cart shipping options are filtered by the items' shipping profiles, so a
 * product with no profile can be added to a cart but never shipped.
 *
 * Explicit plugin options win. Otherwise the store's defaults are used — the
 * same channel and profile the Medusa admin preselects when a person creates a
 * product by hand.
 */
export type ProductPlacement = {
  salesChannelIds: string[]
  shippingProfileId?: string
  /** What could not be resolved, for one warning per sync rather than none. */
  warnings: string[]
}

export async function resolveProductPlacement(input: {
  salesChannelIds?: string[] | null
  shippingProfileId?: string | null
  getDefaultSalesChannelId: () => Promise<string | null | undefined>
  getDefaultShippingProfileId: () => Promise<string | null | undefined>
}): Promise<ProductPlacement> {
  const warnings: string[] = []

  let salesChannelIds = (input.salesChannelIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.trim() !== ""
  )
  if (!salesChannelIds.length) {
    const fallback = await input.getDefaultSalesChannelId().catch(() => null)
    if (fallback) {
      salesChannelIds = [fallback]
    } else {
      warnings.push(
        "No sales channel for imported products: set the salesChannelIds " +
          "option or a default sales channel on the store. New products will " +
          "not appear on the storefront until one is assigned."
      )
    }
  }

  let shippingProfileId =
    typeof input.shippingProfileId === "string" &&
    input.shippingProfileId.trim()
      ? input.shippingProfileId
      : undefined
  if (!shippingProfileId) {
    const fallback = await input.getDefaultShippingProfileId().catch(() => null)
    if (fallback) {
      shippingProfileId = fallback
    } else {
      warnings.push(
        "No shipping profile for imported products: set the " +
          "shippingProfileId option or create a default shipping profile. " +
          "New products cannot be shipped until one is assigned."
      )
    }
  }

  return { salesChannelIds, shippingProfileId, warnings }
}
