import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import { classifyPendingClaim } from "../utils/order-idempotency"
import createPrintfulOrderWorkflow from "../workflows/create-printful-order"

/** Claims settled per sweep. */
const BATCH_SIZE = 25

/**
 * Settles order claims whose create never reached a known outcome.
 *
 * Order creation is triggered once, by `payment.captured` (or `order.placed`).
 * When that one attempt times out and the follow-up lookup fails too, the
 * claim is deliberately held — a stalled order is better than a duplicate —
 * but nothing ever came back for it. Same for a process that died between
 * writing the claim and calling Printful. This sweep is that second look.
 *
 * It re-runs the ordinary create workflow, which already knows how to
 * recover: it looks the order up by `external_id`, adopts it if Printful has
 * it, and creates it only once Printful has confirmed it does not exist.
 * Claims young enough to belong to a create still running are left alone.
 */
export default async function retryPrintfulOrders(container: MedusaContainer) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const logger: { info: (m: string) => void; error: (m: string) => void } =
    container.resolve(ContainerRegistrationKeys.LOGGER)

  const pending = await printful.listUnresolvedOrderLinks(BATCH_SIZE)
  const due = pending.filter((link) => classifyPendingClaim(link) === "settle")
  if (!due.length) {
    return
  }

  logger.info(`Printful: settling ${due.length} unresolved order claim(s)`)

  for (const link of due) {
    try {
      const { result } = await createPrintfulOrderWorkflow(container).run({
        input: { order_id: link.medusa_order_id },
      })
      if (!result.skipped) {
        logger.info(
          `Printful: order ${link.medusa_order_id} settled as Printful order ${result.printful_order_id}`
        )
      }
    } catch (err) {
      // One order's failure must not stop the others; the claim stays and the
      // next sweep tries again.
      logger.error(
        `Printful: could not settle order ${link.medusa_order_id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

export const config = {
  name: "printful-retry-orders",
  schedule: "*/15 * * * *",
}
