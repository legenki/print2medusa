import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import { PENDING_PRINTFUL_ORDER_ID } from "../modules/printful/service"
import type {
  PrintfulCreateOrderInput,
  PrintfulOrder,
  PrintfulOrderItemInput,
  PrintfulRecipient,
} from "../utils/types"
import { PrintfulApiError } from "../utils/errors"
import {
  assertUsableExternalId,
  classifyCreateFailure,
  isUnresolvedLink,
} from "../utils/order-idempotency"
import { resolveStateCode } from "../utils/mappers"
import { planCreatedOrderMetadata } from "../utils/costs"
import { shippingOverrideFor } from "../utils/shipping-rates"
import { expandOrderLines } from "../utils/bundle"

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

/**
 * What asking Printful about an outstanding claim established.
 *
 * - `found`    — the order exists; the claim now carries its real id.
 * - `released` — Printful says no such order; the claim is gone and a retry
 *                may create it.
 * - `held`     — still unknown; the claim is kept so nothing can duplicate it.
 */
export type ReconcileOutcome =
  | { status: "found"; order: PrintfulOrder }
  | { status: "released" }
  | { status: "held" }

/**
 * Settle a claim whose create attempt ended with an unknown outcome.
 *
 * `external_id` is the idempotency key: it is stamped on every order we
 * create, and Printful guarantees it unique per store, so looking it up is the
 * one way to learn whether an order exists without risking a second one.
 *
 * Idempotent by construction — two concurrent recoveries read the same order
 * and write the same id onto the same row.
 */
export async function reconcileClaim(args: {
  printful: PrintfulModuleService
  client: Awaited<ReturnType<PrintfulModuleService["getClient"]>>
  logger: { info: (m: string) => void; error: (m: string) => void }
  medusaOrderId: string
  claimId: string
  cause: unknown
}): Promise<ReconcileOutcome> {
  const { printful, client, logger, medusaOrderId, claimId, cause } = args

  let order: PrintfulOrder
  try {
    order = await client.getOrderByExternalId(medusaOrderId)
  } catch (lookupErr) {
    if (lookupErr instanceof PrintfulApiError && lookupErr.status === 404) {
      // Printful is authoritative here: the order was never created.
      await printful.deletePrintfulOrderLinks(claimId)
      return { status: "released" }
    }

    // The lookup itself failed, so the create's outcome is still unknown. Keep
    // the claim: a stalled order someone can see and fix is a smaller harm
    // than one printed and shipped twice. Record why, so it is findable.
    const detail =
      lookupErr instanceof Error ? lookupErr.message : String(lookupErr)
    await printful
      .updatePrintfulOrderLinks({
        id: claimId,
        status: "unverified",
        error_message: `create outcome unknown (${
          cause instanceof Error ? cause.message : String(cause)
        }); verification failed: ${detail}`.slice(0, 1000),
        last_attempt_at: new Date(),
      })
      .catch(() => {
        // Best effort — the claim itself is what prevents the duplicate.
      })

    logger.error(
      `Printful: could not verify whether an order exists for ${medusaOrderId}; ` +
        `holding the claim to prevent a duplicate. Lookup error: ${detail}`
    )
    return { status: "held" }
  }

  await printful.updatePrintfulOrderLinks({
    id: claimId,
    printful_order_id: String(order.id),
    status: order.status || "created",
    error_message: null,
    last_attempt_at: null,
  })

  return { status: "found", order }
}

const createPrintfulOrderStep = createStep(
  "printful-create-order",
  async (input: CreatePrintfulOrderInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const orderModule = container.resolve(Modules.ORDER)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const options = await printful.getOptions()
    const client = await printful.getClient()

    // A link with a real Printful order id means the work is done. A link
    // still holding the `pending` sentinel does not: it is a claim from an
    // attempt whose outcome was never established. Treating that as
    // "already_linked" is what would strand such an order forever — nothing
    // creates it, and nothing ever looks again.
    const existing = await printful.findOrderLink(input.order_id)
    if (existing && !isUnresolvedLink(existing, PENDING_PRINTFUL_ORDER_ID)) {
      return new StepResponse<CreateResult>({
        skipped: true,
        reason: "already_linked",
        printful_order_id: existing.printful_order_id,
      })
    }

    if (existing) {
      // Recovery, not a second create: a claim is outstanding, so ask Printful
      // whether the earlier attempt landed rather than POSTing again.
      const recovered = await reconcileClaim({
        printful,
        client,
        logger,
        medusaOrderId: input.order_id,
        claimId: existing.id,
        cause: new Error("a previous create attempt left an unresolved claim"),
      })

      if (recovered.status === "found") {
        return new StepResponse<CreateResult>({
          skipped: false,
          printful_order_id: String(recovered.order.id),
          status: recovered.order.status,
        })
      }
      if (recovered.status === "held") {
        // Still unknown — hold the claim and surface it. Retrying blindly is
        // exactly what would duplicate the order.
        return new StepResponse<CreateResult>({
          skipped: true,
          reason: "unverified_claim",
        })
      }
      // `released`: Printful confirmed no such order and the claim is gone, so
      // fall through and create it properly below.
    }

    const order = await orderModule.retrieveOrder(input.order_id, {
      // `shipping_methods` carries the `data` blob `validateFulfillmentData`
      // recorded at selection, which is the only evidence on the order that
      // Printful confirmed the method the customer paid for.
      relations: ["items", "shipping_address", "shipping_methods"],
    })

    const items: PrintfulOrderItemInput[] = []
    const unresolved: string[] = []

    // A bundle is one Medusa line standing for several Printful products, and
    // the loop below resolves one line to one item. Left unexpanded, a
    // three-item bundle would ship a single thing — or, since a bundle variant
    // has no Printful link of its own, be skipped as `no_printful_items` and
    // ship nothing at all.
    //
    // Composition comes from each line's own metadata, written when the
    // customer bought. A merchant editing the bundle afterwards must not
    // change what an already-placed order ships.
    const lines = expandOrderLines(
      (order.items ?? []).map((item) => ({
        id: item.id,
        variant_id: item.variant_id,
        title: item.title,
        quantity: Number(item.quantity),
        metadata: (item.metadata ?? {}) as Record<string, unknown>,
      }))
    )

    for (const item of lines) {
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
        name: item.title ?? undefined,
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

    if (order.id.length > 32) {
      throw new Error(
        `Order ID ${order.id} is too long (${order.id.length} chars) to be used as a Printful external_id (max 32).`
      )
    }

    // Checked before the claim, not after: `external_id` is what makes a
    // failed create recoverable, so an order id Printful cannot store as one
    // must fail loudly here rather than reach the API and leave a claim that
    // can never be reconciled.
    assertUsableExternalId(order.id)

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
      // The claim is held until we know what became of the order. Releasing it
      // unconditionally is only correct when the request never reached
      // Printful; a create that timed out *after* Printful accepted it looks
      // identical from here, and releasing on that path lets the next
      // payment.captured print and ship the customer's item a second time.
      if (classifyCreateFailure(err) === "not_created") {
        // Printful read the request and refused it — nothing exists to collide
        // with. Free the claim so a retry can create the order.
        await printful.deletePrintfulOrderLinks(claim.id)
        throw err
      }

      // Outcome unknown (timeout, dropped socket, 5xx, 429, or a 409 that may
      // mean "this external_id already exists"). Ask Printful directly.
      const recovered = await reconcileClaim({
        printful,
        client,
        logger,
        medusaOrderId: order.id,
        claimId: claim.id,
        cause: err,
      })

      if (recovered.status === "released") {
        // Confirmed absent: the claim is gone and a retry may create it.
        throw err
      }
      if (recovered.status === "held") {
        // Still unknown. The claim stays so no retry can duplicate the order.
        throw err
      }

      pfOrder = recovered.order
      logger.info(
        `Printful order ${pfOrder.id} for ${order.id} existed despite a failed create; recovered.`
      )
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
