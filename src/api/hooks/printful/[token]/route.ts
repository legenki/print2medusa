import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import {
  deriveEventId,
  extractOrderId,
  extractShipmentId,
  PRINTFUL_WEBHOOK_TYPES,
  verifyWebhookToken,
  type PrintfulWebhookPayload,
} from "../../../../utils/webhook-events"
import applyOrderStatusWorkflow from "../../../../workflows/apply-order-status"

/**
 * Public Printful webhook endpoint.
 *
 * The payload is a trigger, not a source of truth: we persist it, answer 200,
 * and let the workflow re-read GET /orders/{id} for the real state. Never log
 * the request URL or token.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const logger: { error: (msg: string) => void } = req.scope.resolve(
    ContainerRegistrationKeys.LOGGER
  )
  const options = await printful.getOptions()

  const provided = req.params.token
  if (!verifyWebhookToken(options.webhookSecret, provided)) {
    // 404, not 401: do not confirm that this path exists.
    res.status(404).json({ message: "Not found" })
    return
  }

  const payload = (req.body ?? {}) as PrintfulWebhookPayload
  const type = payload.type ?? "unknown"
  const printfulOrderId = extractOrderId(payload)

  if (!printfulOrderId) {
    res.status(200).json({ received: true, ignored: "no_order_id" })
    return
  }

  let eventId: string
  try {
    eventId = deriveEventId(payload)
  } catch {
    // Malformed or hostile payload — refuse it without a 5xx, which would make
    // Printful retry something that can never succeed.
    res.status(400).json({ message: "Malformed payload" })
    return
  }

  const handled = (PRINTFUL_WEBHOOK_TYPES as readonly string[]).includes(type)

  let event
  try {
    event = await printful.recordWebhookEvent({
      event_id: eventId,
      type,
      printful_order_id: printfulOrderId,
      printful_shipment_id: extractShipmentId(payload),
      payload: payload as unknown as Record<string, unknown>,
      status: handled ? "received" : "ignored",
    })
  } catch (err) {
    // Only storage failures reach here. 500 is correct: we want Printful to retry.
    logger.error(
      `Printful: failed to store webhook event ${eventId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    res.status(500).json({ message: "Failed to store event" })
    return
  }

  // Redelivery of an event we already hold: absorb it.
  if (!event) {
    res.status(200).json({ received: true, event_id: eventId, duplicate: true })
    return
  }

  res.status(200).json({ received: true, event_id: eventId })

  if (handled) {
    // Fire-and-forget: the durable row plus the retry job (once it lands) are
    // the intended safety net, so losing this in-process attempt costs at most
    // one retry interval.
    void applyOrderStatusWorkflow(req.scope)
      .run({ input: { event_row_id: event.id } })
      .catch((err) => {
        logger.error(
          `Printful: apply failed for event ${eventId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
  }
}
