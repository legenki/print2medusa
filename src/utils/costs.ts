import type { PrintfulOrder } from "./types"

/**
 * Printful reports money as JSON numbers in major units (12.34), and Medusa
 * stores integer minor units (1234). Everything crossing that boundary goes
 * through here.
 *
 * `undefined` means "we could not trust this value" and is deliberately
 * distinct from `0`. Reporting an unparseable cost as zero would show the
 * owner a 100% margin on an order that in fact cost them money.
 */
export function toMinorUnits(
  value: string | number | null | undefined
): number | undefined {
  if (value === null || value === undefined || value === "") {
    return 0
  }

  let n: number
  if (typeof value === "number") {
    n = value
  } else if (typeof value === "string") {
    // Number() rejects trailing garbage that parseFloat would silently accept:
    // Number("4.99abc") is NaN, parseFloat("4.99abc") is 4.99.
    n = Number(value)
  } else {
    return undefined
  }

  if (!Number.isFinite(n)) {
    return undefined
  }

  return Math.round(n * 100)
}

export const COST_CURRENCY_KEY = "printful_cost_currency"
export const COST_TOTAL_KEY = "printful_cost_total"
export const RETAIL_CURRENCY_KEY = "printful_retail_currency"
export const RETAIL_TOTAL_KEY = "printful_retail_total"
export const MARGIN_KEY = "printful_margin"

/** Cost fields copied verbatim, minus `currency` and `total` which are special. */
const COST_FIELDS = [
  "subtotal",
  "discount",
  "shipping",
  "digitization",
  "additional_fee",
  "fulfillment_fee",
  "retail_delivery_fee",
  "tax",
  "vat",
] as const

/**
 * Build the order-metadata patch describing what an order cost and what it
 * earned. Shaped like `planOrderStateActions` so the webhook workflow can
 * merge it the same way.
 *
 * Every amount is in minor units. A field that could not be parsed is omitted
 * rather than defaulted, so a partial Printful response never turns into a
 * confidently wrong margin.
 */
export function planCostMetadata(
  order: PrintfulOrder
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const costs = order.costs
  const retail = order.retail_costs

  if (!costs && !retail) {
    return metadata
  }

  const costCurrency = costs?.currency?.toLowerCase()
  const retailCurrency = retail?.currency?.toLowerCase()

  if (costs) {
    if (costCurrency) {
      metadata[COST_CURRENCY_KEY] = costCurrency
    }
    const total = toMinorUnits(costs.total)
    if (total !== undefined) {
      metadata[COST_TOTAL_KEY] = total
    }
    for (const field of COST_FIELDS) {
      const value = toMinorUnits(costs[field])
      if (value !== undefined && value !== 0) {
        metadata[`printful_cost_${field}`] = value
      }
    }
  }

  if (retail) {
    if (retailCurrency) {
      metadata[RETAIL_CURRENCY_KEY] = retailCurrency
    }
    const total = toMinorUnits(retail.total)
    if (total !== undefined) {
      metadata[RETAIL_TOTAL_KEY] = total
    }
  }

  // Margin only where the subtraction is meaningful. Converting between
  // currencies would need an exchange rate this plugin does not have, and a
  // margin built on a guessed rate is worse than no margin at all.
  const costTotal = metadata[COST_TOTAL_KEY]
  const retailTotal = metadata[RETAIL_TOTAL_KEY]
  if (
    typeof costTotal === "number" &&
    typeof retailTotal === "number" &&
    costCurrency &&
    retailCurrency &&
    costCurrency === retailCurrency
  ) {
    metadata[MARGIN_KEY] = retailTotal - costTotal
  }

  return metadata
}

/**
 * Build the order-metadata patch for an order Printful has just created.
 *
 * The identity keys matter as much as the costs: the admin order widget gates
 * its entire render on `printful_order_id`, so without them a freshly created
 * order shows the merchant no Printful panel at all until the first webhook
 * arrives — even though the order exists in Printful and its costs are stored.
 *
 * The key names deliberately match `planOrderStateActions`, so the webhook path
 * later overwrites these values rather than writing a parallel set.
 *
 * `printful_status_updated_at` is *not* stamped here. It is the "Last synced"
 * breadcrumb, meaning "when we last re-read the order from Printful". Creation
 * is not a re-read, and claiming it was would date a status that no webhook has
 * yet confirmed. The first real sync sets it.
 */
export function planCreatedOrderMetadata(
  order: PrintfulOrder
): Record<string, unknown> {
  return {
    // Spread first so an identity key always wins a name collision rather than
    // being silently overwritten by a cost key.
    ...planCostMetadata(order),
    printful_order_id: String(order.id),
    printful_status: order.status,
  }
}
