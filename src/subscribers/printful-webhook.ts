import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import applyOrderStatusWorkflow from "../workflows/apply-order-status"
import { PRINTFUL_WEBHOOK_RECEIVED } from "../utils/webhook-events"

export default async function printfulWebhookReceivedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ event_row_id: string }>) {
  const logger = container.resolve("logger")
  try {
    await applyOrderStatusWorkflow(container).run({
      input: { event_row_id: data.event_row_id },
    })
  } catch (err) {
    logger.error(
      `Printful: apply failed for event_row_id ${data.event_row_id}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    throw err
  }
}

export const config: SubscriberConfig = {
  event: PRINTFUL_WEBHOOK_RECEIVED,
}
