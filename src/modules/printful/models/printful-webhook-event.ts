import { model } from "@medusajs/framework/utils"

const PrintfulWebhookEvent = model.define("printful_webhook_event", {
  id: model.id().primaryKey(),
  event_id: model.text().unique(),
  type: model.text(),
  printful_order_id: model.text(),
  printful_shipment_id: model.text().nullable(),
  payload: model.json(),
  status: model.text().default("received"),
  attempts: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),
  processed_at: model.dateTime().nullable(),
  error_message: model.text().nullable(),
})

export default PrintfulWebhookEvent
