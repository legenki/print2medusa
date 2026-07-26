import { model } from "@medusajs/framework/utils"

const PrintfulSyncLog = model.define("printful_sync_log", {
  id: model.id().primaryKey(),
  status: model.text().default("running"),
  started_at: model.dateTime(),
  finished_at: model.dateTime().nullable(),
  products_created: model.number().default(0),
  products_updated: model.number().default(0),
  products_failed: model.number().default(0),
  error_message: model.text().nullable(),
})

export default PrintfulSyncLog
