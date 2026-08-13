import { model } from "@medusajs/framework/utils"

const PrintfulOrderLink = model.define("printful_order_link", {
  id: model.id().primaryKey(),
  medusa_order_id: model.text(),
  printful_order_id: model.text(),
  external_id: model.text(),
  status: model.text().default("created"),
  /**
   * Why a row is still holding a claim without a real Printful order id.
   *
   * Set when a create attempt ended with an outcome we could not determine —
   * the POST may or may not have reached Printful — and the reconcile lookup
   * could not settle it either. The row is deliberately left in place: a
   * duplicate order is printed and shipped, while a held claim is a visible,
   * recoverable stall.
   */
  error_message: model.text().nullable(),
  /** When that unresolved attempt happened, so a stalled row is findable. */
  last_attempt_at: model.dateTime().nullable(),
})

export default PrintfulOrderLink
