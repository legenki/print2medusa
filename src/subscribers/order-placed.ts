import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import createPrintfulOrderWorkflow from "../workflows/create-printful-order"

/**
 * Optional path for capture-on-place stores.
 * Enabled when plugin option createOnOrderPlaced is true.
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
