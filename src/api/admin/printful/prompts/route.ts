import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { summarizeProductDesign } from "../../../../utils/design"
import {
  buildProductPrompts,
  PROMPT_STYLES,
  type PromptStyle,
} from "../../../../utils/prompt"

/**
 * Mockup prompts per product.
 *
 * A pure read of the database plus string assembly — no Printful call, and no
 * image generation. The plugin writes prompts; generation happens wherever you
 * paste them, which is what keeps API keys, rate-limit queues and file storage
 * out of this repo.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productModule = req.scope.resolve(Modules.PRODUCT)
  const query = req.query as Record<string, unknown>

  // An unrecognized style falls back to the first preset rather than
  // erroring: a mistyped query parameter should still produce prompts.
  const requested = typeof query.style === "string" ? query.style : undefined
  const style = PROMPT_STYLES.some((s) => s.id === requested)
    ? (requested as PromptStyle)
    : undefined

  const artwork =
    typeof query.artwork === "string" && query.artwork.trim()
      ? query.artwork.trim()
      : undefined

  const products = await productModule.listProducts(
    {},
    { relations: ["variants"], take: 100 }
  )

  const items = products
    .map((product) => {
      const summary = summarizeProductDesign(product.variants ?? [])
      if (!summary) {
        // Never enriched by a sync. Omitted rather than listed with no
        // prompts, which would read as "this product cannot be prompted for".
        return null
      }

      const prompts = buildProductPrompts({ design: summary, style, artwork })
      if (prompts.length === 0) {
        return null
      }

      return {
        product_id: product.id,
        title: product.title,
        product_class: summary.product_class,
        prompts,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)

  res.status(200).json({
    products: items,
    styles: PROMPT_STYLES.map((s) => ({ id: s.id, label: s.label })),
    style: style ?? PROMPT_STYLES[0].id,
    artwork,
  })
}
