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
  PRINTFUL_WEBHOOK_RECEIVED,
  type PrintfulWebhookPayload,
} from "../../../../utils/webhook-events"
import { Modules } from "@medusajs/framework/utils"
import type { IEventBusModuleService } from "@medusajs/framework/types"

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

  if (handled) {
    // Emitted before the response, not after. Emitting afterwards means a
    // failure here — an unresolvable Event Bus, a broken transport — throws
    // with the 200 already sent: an unhandled rejection Printful reads as
    // success, and the event waits for the retry job with nothing logged.
    //
    // Failing to emit is not failing the webhook, though. The durable row is
    // already written and the retry job picks it up, so this logs and still
    // answers 200 rather than asking Printful to redeliver an event we hold.
    try {
      const eventBus: IEventBusModuleService = req.scope.resolve(
        Modules.EVENT_BUS
      )
      await eventBus.emit({
        name: PRINTFUL_WEBHOOK_RECEIVED,
        data: { event_row_id: event.id },
      })
    } catch (err) {
      logger.error(
        `Printful: could not emit ${PRINTFUL_WEBHOOK_RECEIVED} for event ${eventId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  res.status(200).json({ received: true, event_id: eventId })
}
