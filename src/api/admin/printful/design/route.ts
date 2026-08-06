import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { summarizeProductDesign } from "../../../../utils/design"

/**
 * Design parameters per product, read from the variant metadata the sync
 * stamped.
 *
 * A pure read of the database — no Printful call. The sync already paid for
 * the catalog lookups, and this page is opened far more often than the
 * catalogue changes.
 *
 * Products whose variants carry no design metadata are omitted rather than
 * listed empty: one was never enriched, the other has nothing to show, and
 * rendering them the same way tells the owner something false.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productModule = req.scope.resolve(Modules.PRODUCT)

  const products = await productModule.listProducts(
    {},
    { relations: ["variants"], take: 100 }
  )

  const designs = products
    .map((product) => {
      const summary = summarizeProductDesign(product.variants ?? [])
      if (!summary) {
        return null
      }
      return {
        product_id: product.id,
        title: product.title,
        status: product.status,
        variant_count: (product.variants ?? []).length,
        ...summary,
      }
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)

  res.status(200).json({ designs })
}
