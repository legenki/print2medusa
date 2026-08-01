import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from "@medusajs/medusa/core-flows"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import {
  MAX_WEBHOOK_ATTEMPTS,
  nextRetryDelayMs,
} from "../modules/printful/service"
import { planOrderStateActions } from "../utils/order-state"

export type ApplyOrderStatusInput = {
  /** Row id in printful_webhook_event. */
  event_row_id: string
}

type ApplyResult = {
  status: "processed" | "deferred" | "failed"
  reason?: string
  shipments_created: number
}

/** Fulfillment metadata key that ties a Medusa fulfillment to a Printful parcel. */
const SHIPMENT_ID_KEY = "printful_shipment_id"

const applyStep = createStep(
  "apply-printful-order-status",
  async (input: ApplyOrderStatusInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const orderModule = container.resolve(Modules.ORDER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const [event] = await printful.listPrintfulWebhookEvents({
      id: input.event_row_id,
    })
    if (!event || event.status === "processed") {
      return new StepResponse<ApplyResult>({
        status: "processed",
        reason: "already_processed",
        shipments_created: 0,
      })
    }

    // Claim the attempt before any risky work: a crash mid-attempt must not
    // leave the row immediately due again, or the retry job spins.
    const attempts = (event.attempts ?? 0) + 1
    await printful.updatePrintfulWebhookEvents({
      id: event.id,
      attempts,
      next_retry_at: new Date(Date.now() + nextRetryDelayMs(attempts)),
    })

    const link = await printful.findOrderLinkByPrintfulId(
      event.printful_order_id
    )
    if (!link) {
      // Order links are written on payment.captured; a webhook can beat it.
      const status = attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred"
      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status,
        error_message: "No printful_order_link for this Printful order yet",
      })
      return new StepResponse<ApplyResult>({
        status,
        reason: "link_missing",
        shipments_created: 0,
      })
    }

    return await printful.withOrderLock(event.printful_order_id, async () => {
      const client = await printful.getClient()
      // The payload is untrusted — Printful API v1 does not sign webhooks. It
      // only names which order to inspect; every decision below comes from this
      // authoritative re-fetch.
      const pfOrder = await client.getOrder(event.printful_order_id)

      // Fulfillments are not an Order-module relation: they live in the
      // Fulfillment module and are reachable only across the module link, so
      // they must be read through Query rather than retrieveOrder().
      const { data: orderRows } = await query.graph({
        entity: "order",
        fields: [
          "id",
          "metadata",
          "items.id",
          "items.quantity",
          "fulfillments.id",
          "fulfillments.metadata",
        ],
        filters: { id: link.medusa_order_id },
      })

      const orderRow = (Array.isArray(orderRows) ? orderRows[0] : orderRows) as
        | {
            id: string
            metadata?: Record<string, unknown> | null
            items?: Array<{ id: string; quantity: number }> | null
            fulfillments?: Array<{
              id: string
              metadata?: Record<string, unknown> | null
            }> | null
          }
        | undefined

      if (!orderRow) {
        const status = attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred"
        await printful.updatePrintfulWebhookEvents({
          id: event.id,
          status,
          error_message: `Medusa order ${link.medusa_order_id} not found`,
        })
        return new StepResponse<ApplyResult>({
          status,
          reason: "order_missing",
          shipments_created: 0,
        })
      }

      // Read back the Printful shipment id we stamped on previous fulfillments.
      // This is how an already-recorded parcel is detected, so a redelivered or
      // duplicated event cannot produce a second fulfillment for it.
      const recorded = (orderRow.fulfillments ?? [])
        .map((f) => f.metadata?.[SHIPMENT_ID_KEY])
        .filter((v): v is string => typeof v === "string")

      const plan = planOrderStateActions(pfOrder, recorded)

      await orderModule.updateOrders(link.medusa_order_id, {
        metadata: { ...(orderRow.metadata ?? {}), ...plan.metadata },
      })

      // Every unshipped item is attributed to the parcel. Printful's order
      // endpoint does not break shipments down per line item, so we cannot
      // split quantities per parcel; each fulfillment covers the order's items
      // and the parcel identity is carried in metadata.
      const items = (orderRow.items ?? []).map((item) => ({
        id: item.id,
        quantity: item.quantity,
      }))

      let created = 0
      for (const shipment of plan.shipments) {
        const labels = shipment.tracking_number
          ? [
              {
                tracking_number: shipment.tracking_number,
                tracking_url: shipment.tracking_url ?? "",
                label_url: shipment.tracking_url ?? "",
              },
            ]
          : []

        // Each unrecorded Printful shipment gets its OWN fulfillment: Printful
        // splits orders across facilities, so one fulfillment must never close
        // the whole order.
        const { result: fulfillment } = await createOrderFulfillmentWorkflow(
          container
        ).run({
          input: {
            order_id: link.medusa_order_id,
            items,
            labels,
            metadata: {
              printful_order_id: String(event.printful_order_id),
              [SHIPMENT_ID_KEY]: shipment.printful_shipment_id,
              printful_carrier: shipment.carrier ?? null,
              printful_service: shipment.service ?? null,
            },
          },
        })

        await createOrderShipmentWorkflow(container).run({
          input: {
            order_id: link.medusa_order_id,
            fulfillment_id: fulfillment.id,
            items,
            labels,
          },
        })
        created += 1
      }

      // Negative states (failed/canceled/onhold) are recorded for a human to
      // review — never auto-canceled or auto-refunded here.
      await printful.updatePrintfulOrderLinks({
        id: link.id,
        status: pfOrder.status,
      })

      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status: "processed",
        processed_at: new Date(),
        error_message: null,
      })

      return new StepResponse<ApplyResult>({
        status: "processed",
        shipments_created: created,
      })
    })
  }
)

export const applyOrderStatusWorkflow = createWorkflow(
  "apply-printful-order-status",
  (input: ApplyOrderStatusInput) => {
    return new WorkflowResponse(applyStep(input))
  }
)

export default applyOrderStatusWorkflow
