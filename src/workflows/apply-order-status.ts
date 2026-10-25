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
import {
  allPlannedShipments,
  labelsFor,
  planOrderStateActions,
  planShipmentRepairs,
  recordedShipmentIds,
  SHIPMENT_ID_KEY,
  type RecordedFulfillment,
} from "../utils/order-state"
import { planParcelItems } from "../utils/parcel-items"

export type ApplyOrderStatusInput = {
  /** Row id in printful_webhook_event. */
  event_row_id: string
}

type ApplyResult = {
  status: "processed" | "deferred" | "failed"
  reason?: string
  shipments_created: number
  /** Parcels whose fulfillment existed but had never been marked shipped. */
  shipments_repaired?: number
}

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
            "fulfillments.shipped_at",
            "fulfillments.canceled_at",
            "fulfillments.items.line_item_id",
            "fulfillments.items.quantity",
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
              fulfillments?: RecordedFulfillment[] | null
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
        const fulfillments = orderRow.fulfillments ?? []
        const recorded = recordedShipmentIds(fulfillments)

        const plan = planOrderStateActions(pfOrder, recorded)
        const parcels = allPlannedShipments(pfOrder)

        await orderModule.updateOrders(link.medusa_order_id, {
          metadata: { ...(orderRow.metadata ?? {}), ...plan.metadata },
        })

        // A parcel whose fulfillment exists but whose shipment step never ran
        // — the two are separate workflows. Finish it before anything new, or
        // it stays "recorded" and unshipped forever.
        let repaired = 0
        for (const repair of planShipmentRepairs(fulfillments, parcels)) {
          await createOrderShipmentWorkflow(container).run({
            input: {
              order_id: link.medusa_order_id,
              fulfillment_id: repair.fulfillment_id,
              items: repair.items,
              labels: repair.labels,
            },
          })
          repaired += 1
        }

        // Which Medusa line quantities each new parcel fulfils. Joins
        // Printful's per-parcel breakdown back to Medusa lines through the
        // external_id create-printful-order stamps on every item, counts a
        // bundle as shipped only once all its members have, and clamps to what
        // Medusa still has open — see planParcelItems.
        const parcelItems = planParcelItems({
          orderLines: (orderRow.items ?? []).map((item) => ({
            id: item.id,
            quantity: Number(item.quantity),
            fulfilled_quantity: Number(item.detail?.fulfilled_quantity ?? 0),
          })),
          printfulItems: (pfOrder.items ?? []).map((item) => ({
            id: item.id as number,
            external_id: item.external_id,
            quantity: Number(item.quantity),
          })),
          parcels,
          recorded: new Set(recorded),
        })

        let created = 0
        const skipped: string[] = []
        for (const shipment of plan.shipments) {
          const items = parcelItems.get(shipment.printful_shipment_id) ?? []

          // Nothing left open for this parcel — a reshipment, units already
          // fulfilled, or part of a bundle still waiting on other members.
          // Record it and move on instead of throwing.
          if (!items.length) {
            skipped.push(shipment.printful_shipment_id)
            continue
          }

          const labels = labelsFor(shipment)

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
          shipments_repaired: repaired,
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
