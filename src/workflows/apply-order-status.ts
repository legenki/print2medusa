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

    try {
      // The lint rule cannot see through the withOrderLock closure, but every
      // return inside it is a `new StepResponse(...)` — as are the two early
      // returns above.
      // eslint-disable-next-line @medusajs/step-must-return-step-response
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
            // Remaining unfulfilled quantity is validated by the order module
            // (utils/actions/fulfill-item.js: "Cannot fulfill more items than
            // what was ordered"), so we must clamp against it before asking.
            "items.detail.fulfilled_quantity",
            "fulfillments.id",
            "fulfillments.metadata",
          ],
          filters: { id: link.medusa_order_id },
        })

        const orderRow = (
          Array.isArray(orderRows) ? orderRows[0] : orderRows
        ) as
          | {
              id: string
              metadata?: Record<string, unknown> | null
              items?: Array<{
                id: string
                quantity: number
                detail?: { fulfilled_quantity?: number } | null
              }> | null
              fulfillments?: Array<{
                id: string
                metadata?: Record<string, unknown> | null
              }> | null
            }
          | undefined

        if (!orderRow) {
          const status =
            attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred"
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

        // Printful's Shipment.items gives a per-parcel breakdown keyed by its own
        // line item id. create-printful-order.ts stamps external_id with the
        // Medusa line item id on every item it sends, so this map joins a parcel's
        // contents back to Medusa line items.
        const printfulItemToMedusaItem = new Map<number, string>()
        for (const pfItem of pfOrder.items ?? []) {
          if (pfItem.external_id) {
            printfulItemToMedusaItem.set(Number(pfItem.id), pfItem.external_id)
          }
        }

        // Remaining unfulfilled quantity per Medusa line item. Decremented as we
        // go so two parcels in one pass cannot jointly over-fulfill a line.
        const remaining = new Map<string, number>()
        for (const item of orderRow.items ?? []) {
          const fulfilled = Number(item.detail?.fulfilled_quantity ?? 0)
          remaining.set(item.id, Math.max(0, Number(item.quantity) - fulfilled))
        }

        /**
         * Items to fulfill for one parcel, clamped to what Medusa still has open.
         *
         * Clamping is load-bearing: Printful can report more than Medusa has
         * outstanding — after a partial cancel, or on a reshipment, where the same
         * units ship twice and must not be counted twice. Over-asking throws
         * "Cannot fulfill more items than what was ordered", which would strand
         * the event permanently.
         */
        const itemsForParcel = (shipment: (typeof plan.shipments)[number]) => {
          // No breakdown (older or partial payloads): fall back to the whole
          // order, still clamped, rather than crashing.
          const requested =
            shipment.items === undefined
              ? (orderRow.items ?? []).map((i) => ({
                  id: i.id,
                  quantity: Number(i.quantity),
                }))
              : shipment.items.flatMap((pi) => {
                  const medusaId = printfulItemToMedusaItem.get(pi.item_id)
                  return medusaId
                    ? [{ id: medusaId, quantity: Number(pi.quantity) }]
                    : []
                })

          const clamped: Array<{ id: string; quantity: number }> = []
          for (const req of requested) {
            const open = remaining.get(req.id) ?? 0
            const quantity = Math.min(req.quantity, open)
            if (quantity > 0) {
              clamped.push({ id: req.id, quantity })
              remaining.set(req.id, open - quantity)
            }
          }
          return clamped
        }

        let created = 0
        const skipped: string[] = []
        for (const shipment of plan.shipments) {
          const items = itemsForParcel(shipment)

          // Nothing left open for this parcel — a reshipment, or units already
          // fulfilled. Record it and move on instead of throwing.
          if (!items.length) {
            skipped.push(shipment.printful_shipment_id)
            continue
          }

          const labels = shipment.tracking_number
            ? [
                {
                  tracking_number: shipment.tracking_number,
                  tracking_url: shipment.tracking_url ?? "",
                  // Printful's v1 Shipment schema exposes no customer-facing
                  // label URL. Empty beats a plausible-looking wrong link.
                  label_url: "",
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
                printful_reshipment: shipment.reshipment ?? false,
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

        // Skipped parcels are not an error, but they are worth surfacing: a
        // reshipment or a post-cancel shipment leaves a visible breadcrumb rather
        // than silently producing fewer fulfillments than parcels.
        await printful.updatePrintfulWebhookEvents({
          id: event.id,
          status: "processed",
          processed_at: new Date(),
          error_message: skipped.length
            ? `No unfulfilled quantity remaining for shipment(s): ${skipped.join(", ")}`
            : null,
        })

        return new StepResponse<ApplyResult>({
          status: "processed",
          shipments_created: created,
        })
      })
    } catch (err) {
      // Outside the lock deliberately: a write inside would roll back with it,
      // losing the only record of why this failed. Without this, an event that
      // throws its way to MAX_WEBHOOK_ATTEMPTS stops matching
      // listDueWebhookEvents while still marked received/deferred — invisible to
      // the retry job and indistinguishable from a fresh event.
      const status = attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred"
      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status,
        error_message: (err instanceof Error ? err.message : String(err)).slice(
          0,
          1000
        ),
      })
      throw err
    }
  }
)

export const applyOrderStatusWorkflow = createWorkflow(
  "apply-printful-order-status",
  (input: ApplyOrderStatusInput) => {
    return new WorkflowResponse(applyStep(input))
  }
)

export default applyOrderStatusWorkflow
