import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import createPrintfulOrderWorkflow from "../workflows/create-printful-order"
import {
  isFullyCaptured,
  type PaymentCollectionForCapture,
} from "../utils/payment-status"

/**
 * Optional path for capture-on-place stores.
 * Enabled when plugin option createOnOrderPlaced is true, and acts only on an
 * order whose payment is already captured in full.
 */
export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()

  if (!options.createOnOrderPlaced) {
    return
  }

  const orderId = data.id
  if (!orderId) {
    return
  }

  try {
    // `order.placed` fires whether or not the money was taken. On a store
    // that only authorizes at checkout this option would otherwise send an
    // unpaid order to print — and, with autoSubmitOrders, confirm it, which
    // bills the merchant. Such orders still go out on `payment.captured`.
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: rows } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "payment_collections.status",
        "payment_collections.amount",
        "payment_collections.captured_amount",
      ],
      filters: { id: orderId },
    })
    const row = (Array.isArray(rows) ? rows[0] : rows) as
      { payment_collections?: PaymentCollectionForCapture[] | null } | undefined
    if (!isFullyCaptured(row?.payment_collections)) {
      container
        .resolve<{ warn: (msg: string) => void }>(
          ContainerRegistrationKeys.LOGGER
        )
        .warn(
          `Printful: order ${orderId} is not fully captured at order.placed; ` +
            "waiting for payment.captured before creating the Printful order."
        )
      return
    }

    await createPrintfulOrderWorkflow(container).run({
      input: { order_id: orderId },
    })
  } catch (err) {
    const logger = container.resolve("logger") as {
      error: (msg: string) => void
    }
    logger.error(
      `Printful: failed to create order on place for ${orderId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
