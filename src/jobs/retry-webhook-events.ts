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
/** Events drained per sweep. */
const BATCH_SIZE = 50

/**
 * Consecutive failures before the sweep gives up for this run. A database or
 * Printful outage fails every event identically, and grinding through the whole
 * batch each tick buys nothing — the remaining events keep their backoff and
 * are picked up by the next sweep.
 */
const CONSECUTIVE_FAILURE_LIMIT = 5

export default async function retryPrintfulWebhookEvents(
  container: MedusaContainer
) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const logger: { info: (m: string) => void; error: (m: string) => void } =
    container.resolve(ContainerRegistrationKeys.LOGGER)

  const due = await printful.listDueWebhookEvents(BATCH_SIZE)
  if (!due.length) {
    return
  }

  logger.info(`Printful: retrying ${due.length} webhook event(s)`)

  if (due.length === BATCH_SIZE) {
    // A full batch means the backlog may exceed what one sweep can drain.
    logger.info(
      `Printful: retry batch is full (${BATCH_SIZE}); backlog may be growing`
    )
  }

  let consecutiveFailures = 0

  for (const event of due) {
    try {
      await applyOrderStatusWorkflow(container).run({
        input: { event_row_id: event.id },
      })
      consecutiveFailures = 0
    } catch (err) {
      // The workflow records its own failure state; a throw here means the
      // sweep should continue rather than abandon the remaining events.
      consecutiveFailures += 1
      logger.error(
        `Printful: retry failed for event ${event.event_id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        logger.error(
          `Printful: aborting retry sweep after ${consecutiveFailures} consecutive failures`
        )
        return
      }
    }
  }
}

export const config = {
  name: "printful-retry-webhook-events",
  schedule: "*/5 * * * *",
}
