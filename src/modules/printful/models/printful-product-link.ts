import { model } from "@medusajs/framework/utils"

const PrintfulProductLink = model.define("printful_product_link", {
  id: model.id().primaryKey(),
  printful_store_id: model.text(),
  printful_sync_product_id: model.text(),
  medusa_product_id: model.text(),
  last_synced_at: model.dateTime().nullable(),
  sync_hash: model.text().nullable(),
})

export default PrintfulProductLink
