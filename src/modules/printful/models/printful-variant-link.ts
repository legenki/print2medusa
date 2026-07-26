import { model } from "@medusajs/framework/utils"

const PrintfulVariantLink = model.define("printful_variant_link", {
  id: model.id().primaryKey(),
  printful_store_id: model.text(),
  printful_sync_product_id: model.text(),
  printful_sync_variant_id: model.text(),
  medusa_variant_id: model.text(),
  last_synced_at: model.dateTime().nullable(),
})

export default PrintfulVariantLink
