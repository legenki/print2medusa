import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../../modules/printful"
import type PrintfulModuleService from "../../../../../modules/printful/service"
import { printfulOrderIdFrom } from "../../../../../utils/order-metadata"

/**
 * Whether this Medusa order really has a Printful order, from the link table.
 *
 * The order widget reads everything else from order metadata, but metadata
 * alone cannot answer this: Medusa copies the customer's cart metadata onto
 * the order, so `printful_order_id` there may be one the customer typed. The
 * link row is written only by this plugin, after Printful created the order.
 *
 * A claim still holding the `pending` sentinel answers null — no Printful
 * order exists for it yet.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)

  const link = await printful.findOrderLink(req.params.id)

  res.status(200).json({
    printful_order_id: printfulOrderIdFrom(link),
    status: link?.status ?? null,
  })
}
