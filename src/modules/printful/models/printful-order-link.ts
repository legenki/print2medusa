import { model } from "@medusajs/framework/utils"

const PrintfulOrderLink = model.define("printful_order_link", {
  id: model.id().primaryKey(),
  medusa_order_id: model.text(),
  printful_order_id: model.text(),
  external_id: model.text(),
  status: model.text().default("created"),
})

export default PrintfulOrderLink
