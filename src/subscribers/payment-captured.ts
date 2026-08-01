import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import createPrintfulOrderWorkflow from "../workflows/create-printful-order"

/**
 * Primary path: create Printful order when payment is captured.
 * Event payload is `{ id: payment_id }` — resolve order via payment collection.
 * Idempotent via PrintfulOrderLink.
 */
export default async function paymentCapturedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const paymentId = data.id
  if (!paymentId) {
    return
  }

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    error: (msg: string) => void
    info: (msg: string) => void
  }

  try {
    const orderId = await resolveOrderIdFromPayment(container, paymentId)
    if (!orderId) {
      logger.error(`Printful: could not resolve order for payment ${paymentId}`)
      return
    }

    await createPrintfulOrderWorkflow(container).run({
      input: { order_id: orderId },
    })
  } catch (err) {
    logger.error(
      `Printful: failed to create order for payment ${paymentId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

async function resolveOrderIdFromPayment(
  container: MedusaContainer,
  paymentId: string
): Promise<string | null> {
  const paymentModule = container.resolve(Modules.PAYMENT)
  const payment = await paymentModule.retrievePayment(paymentId)
  const collectionId = payment.payment_collection_id as string | undefined
  if (!collectionId) {
    return null
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id", "order.id"],
    filters: {
      payment_collection_id: collectionId,
    },
  })

  const row = Array.isArray(data) ? data[0] : data
  if (!row) {
    return null
  }

  return (
    (row as { order_id?: string; order?: { id?: string } }).order_id ||
    (row as { order?: { id?: string } }).order?.id ||
    null
  )
}

export const config: SubscriberConfig = {
  event: "payment.captured",
}
