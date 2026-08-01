import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import applyOrderStatusWorkflow from "../workflows/apply-order-status"

/**
 * Drains webhook events that were stored but not applied — most often because
 * the order link had not been written yet when the webhook landed, or because
 * the process died between storing the event and applying it.
 *
 * This is the safety net the webhook route's fire-and-forget dispatch relies on:
 * the route's in-process attempt is only an optimization to avoid waiting a
 * retry interval in the common case.
 */
export default async function retryPrintfulWebhookEvents(
  container: MedusaContainer
) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const logger: { info: (m: string) => void; error: (m: string) => void } =
    container.resolve(ContainerRegistrationKeys.LOGGER)

  const due = await printful.listDueWebhookEvents(50)
  if (!due.length) {
    return
  }

  logger.info(`Printful: retrying ${due.length} webhook event(s)`)

  for (const event of due) {
    try {
      await applyOrderStatusWorkflow(container).run({
        input: { event_row_id: event.id },
      })
    } catch (err) {
      // The workflow records its own failure state; a throw here means the
      // sweep should continue rather than abandon the remaining events.
      logger.error(
        `Printful: retry failed for event ${event.event_id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

export const config = {
  name: "printful-retry-webhook-events",
  schedule: "*/5 * * * *",
}
