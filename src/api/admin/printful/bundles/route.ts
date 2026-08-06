import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import {
  bundleMembersOf,
  planBundleAvailability,
} from "../../../../utils/bundle"

/**
 * Bundles and whether each can currently be sold.
 *
 * A pure read of the database — no Printful call. Availability comes from the
 * `printful_availability_status` the sync already stamped on every member
 * variant, which is the same source the sync's own bundle pass decides on. A
 * live lookup here could disagree with the status the catalogue was last
 * published against, and show the owner a bundle as sellable that the next
 * sync is about to draft.
 *
 * Every member is listed, available or not, because the question the owner has
 * when a bundle goes off sale is *which* member ran out.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productModule = req.scope.resolve(Modules.PRODUCT)

  const products = await productModule.listProducts(
    {},
    { relations: ["variants"], take: 1000 }
  )

  // Members are variant ids on other products, so the whole catalogue has to
  // be indexed before any bundle can be resolved.
  const variantIndex = new Map<
    string,
    { title: string; product_title: string; status: string }
  >()
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const metadata = (variant.metadata ?? {}) as Record<string, unknown>
      variantIndex.set(variant.id, {
        title: variant.title ?? variant.id,
        product_title: product.title,
        status:
          typeof metadata.printful_availability_status === "string"
            ? metadata.printful_availability_status
            : "unknown",
      })
    }
  }

  const bundles: Array<Record<string, unknown>> = []
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const members = bundleMembersOf({
        id: variant.id,
        quantity: 1,
        metadata: (variant.metadata ?? {}) as Record<string, unknown>,
      })
      if (!members.length) {
        continue
      }

      const resolved = members.map((member) => {
        const found = variantIndex.get(member.variant_id)
        return {
          variant_id: member.variant_id,
          quantity: member.quantity ?? 1,
          // A member whose variant no longer exists is reported as such rather
          // than hidden: it is the likeliest reason a bundle fails at Printful,
          // and it is invisible everywhere else in the admin.
          title: found?.title ?? null,
          product_title: found?.product_title ?? null,
          status: found?.status ?? "missing",
        }
      })

      const availability = planBundleAvailability(
        resolved
          .filter((m) => m.status !== "missing")
          .map((m) => ({ printful_availability_status: m.status }))
      )

      bundles.push({
        product_id: product.id,
        variant_id: variant.id,
        title: product.title,
        variant_title: variant.title,
        status: product.status,
        available: availability.available,
        member_count: resolved.length,
        missing_count: resolved.filter((m) => m.status === "missing").length,
        members: resolved,
      })
    }
  }

  res.status(200).json({ bundles })
}
