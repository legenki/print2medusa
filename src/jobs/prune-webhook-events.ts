import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import { WEBHOOK_EVENT_RETENTION_DAYS } from "../modules/printful/service"
import { WEBHOOK_HEALTH_WINDOW } from "../utils/webhook-health"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Removes settled webhook events once they are WEBHOOK_EVENT_RETENTION_DAYS
 * old, so the table does not grow for the life of the store. Events still in
 * flight, failed events and the newest rows the health panel reads are kept —
 * see pruneWebhookEvents.
 *
 * A failure is left to the scheduler, which logs it; the next day's run
 * deletes the same rows.
 */
export default async function prunePrintfulWebhookEvents(
  container: MedusaContainer
) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const logger: { info: (m: string) => void } = container.resolve(
    ContainerRegistrationKeys.LOGGER
  )

  const cutoff = new Date(Date.now() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS)
  const removed = await printful.pruneWebhookEvents(
    cutoff,
    WEBHOOK_HEALTH_WINDOW
  )

  if (removed > 0) {
    logger.info(
      `Printful: removed ${removed} settled webhook event(s) older than ${WEBHOOK_EVENT_RETENTION_DAYS} days`
    )
  }
}

export const config = {
  name: "printful-prune-webhook-events",
  // Daily, on a minute the 5-minute retry sweeps never start on.
  schedule: "17 4 * * *",
}
