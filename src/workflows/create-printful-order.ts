import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import type {
  PrintfulCreateOrderInput,
  PrintfulOrderItemInput,
  PrintfulRecipient,
} from "../utils/types"
import { resolveStateCode } from "../utils/mappers"
import { planCreatedOrderMetadata } from "../utils/costs"
import { shippingOverrideFor } from "../utils/shipping-rates"

export type CreatePrintfulOrderInput = {
  order_id: string
}

type CreateResult =
  | {
      skipped: true
      reason: string
      printful_order_id?: string
    }
  | {
      skipped: false
      printful_order_id: string
      status: string
    }

const createPrintfulOrderStep = createStep(
  "printful-create-order",
  async (input: CreatePrintfulOrderInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const orderModule = container.resolve(Modules.ORDER)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const options = await printful.getOptions()
    const client = await printful.getClient()

    const existing = await printful.findOrderLink(input.order_id)
    if (existing) {
      return new StepResponse<CreateResult>({
        skipped: true,
        reason: "already_linked",
        printful_order_id: existing.printful_order_id,
      })
    }

    const order = await orderModule.retrieveOrder(input.order_id, {
      // `shipping_methods` carries the `data` blob `validateFulfillmentData`
      // recorded at selection, which is the only evidence on the order that
      // Printful confirmed the method the customer paid for.
      relations: ["items", "shipping_address", "shipping_methods"],
    })

    const items: PrintfulOrderItemInput[] = []
    const unresolved: string[] = []

    for (const item of order.items ?? []) {
      const variantId = item.variant_id
      if (!variantId) {
        unresolved.push(item.id)
        continue
      }

      let syncVariantId: string | undefined

      const link = await printful.findVariantLinkByMedusaId(variantId)
      if (link) {
        syncVariantId = link.printful_sync_variant_id
      } else {
        const meta = (item.metadata || {}) as Record<string, unknown>
        if (meta.printful_sync_variant_id) {
          syncVariantId = String(meta.printful_sync_variant_id)
        }
      }

      if (!syncVariantId) {
        unresolved.push(item.title || item.id)
        continue
      }

      items.push({
        sync_variant_id: Number(syncVariantId),
        quantity: Number(item.quantity),
        name: item.title,
        external_id: item.id,
      })
    }

    if (!items.length) {
      return new StepResponse<CreateResult>({
        skipped: true,
        reason: "no_printful_items",
      })
    }

    if (unresolved.length && !options.allowPartialOrders) {
      throw new Error(
        `Order ${input.order_id} has non-Printful items: ${unresolved.join(", ")}`
      )
    }

    const addr = order.shipping_address
    if (!addr) {
      throw new Error(`Order ${input.order_id} has no shipping address`)
    }

    const countryCode = (addr.country_code || "").toUpperCase()
    const recipient: PrintfulRecipient = {
      name:
        [addr.first_name, addr.last_name].filter(Boolean).join(" ") ||
        "Customer",
      address1: addr.address_1 || "",
      address2: addr.address_2 || undefined,
      city: addr.city || "",
      state_code: resolveStateCode(addr.province, countryCode),
      country_code: countryCode,
      zip: addr.postal_code || "",
      phone: addr.phone || undefined,
      email: order.email || undefined,
    }

    // Insert-first: atomically claim the order before hitting the Printful API.
    // Two concurrent payment.captured events cannot both pass this point — the
    // unique index on medusa_order_id makes the loser return null → skip,
    // preventing a duplicate Printful order.
    const claim = await printful.claimOrderLink(order.id)
    if (!claim) {
      return new StepResponse<CreateResult>({
        skipped: true,
        reason: "already_linked",
      })
    }

    // A pure read of what was recorded at selection — no Printful call on the
    // order path. Omitted unless Printful itself confirmed the method for this
    // cart, in which case Printful picks the method as it does today.
    const shipping = shippingOverrideFor(order.shipping_methods)

    const payload: PrintfulCreateOrderInput = {
      external_id: order.id,
      recipient,
      ...(shipping ? { shipping } : {}),
      items,
      confirm: options.autoSubmitOrders !== false,
    }

    let pfOrder
    try {
      pfOrder = await client.createOrder(payload)
    } catch (err) {
      // Printful failed after we claimed the order — release the placeholder so
      // a later retry (or manual re-fire) can create the order instead of being
      // permanently blocked by a "pending" link.
      await printful.deletePrintfulOrderLinks(claim.id)
      throw err
    }

    await printful.updatePrintfulOrderLinks({
      id: claim.id,
      printful_order_id: String(pfOrder.id),
      status: pfOrder.status || "created",
    })

    // Printful returns the real costs with the created order, so no separate
    // estimate call is needed. The identity keys ride along unconditionally —
    // the admin widget gates on `printful_order_id`, so a costless order that
    // wrote only costs would stay invisible until the first webhook.
    //
    // Written best-effort: the order exists in Printful either way, and losing
    // the margin figure must never fail the workflow and roll back a real
    // order. Both the Printful order and the link row exist by this point, so
    // failing the step would trigger compensation and release the link for an
    // order Printful is already fulfilling.
    const orderMetadata = planCreatedOrderMetadata(pfOrder)
    try {
      // Under the same advisory lock the webhook path takes. Both do a
      // read-modify-write of `metadata`, and the link became resolvable a few
      // lines above — so a webhook arriving in that window could re-read the
      // order, write a newer `printful_status`, and have this write clobber it
      // back to the status captured at creation. Serializing the two makes the
      // last writer win on a value it actually read.
      await printful.withOrderLock(String(pfOrder.id), async () => {
        // `orderRow` rather than `existing` — that name is taken by the
        // order-link lookup earlier in this step.
        const orderRow = await orderModule.retrieveOrder(input.order_id, {
          select: ["id", "metadata"],
        })
        await orderModule.updateOrders(input.order_id, {
          metadata: { ...(orderRow.metadata ?? {}), ...orderMetadata },
        })
      })
    } catch (err) {
      logger.error(
        `Printful order ${pfOrder.id}: could not store order metadata: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    return new StepResponse<CreateResult>({
      skipped: false,
      printful_order_id: String(pfOrder.id),
      status: pfOrder.status,
    })
  }
)

export const createPrintfulOrderWorkflow = createWorkflow(
  "printful-create-order",
  (input: CreatePrintfulOrderInput) => {
    const result = createPrintfulOrderStep(input)
    return new WorkflowResponse(result)
  }
)

export default createPrintfulOrderWorkflow
