import { describe, expect, it } from "vitest"
import {
  COST_CURRENCY_KEY,
  COST_TOTAL_KEY,
  MARGIN_KEY,
  RETAIL_CURRENCY_KEY,
  RETAIL_TOTAL_KEY,
  planCostMetadata,
  planCreatedOrderMetadata,
  toMinorUnits,
} from "../src/utils/costs"
import { planOrderStateActions } from "../src/utils/order-state"
import type { PrintfulOrder } from "../src/utils/types"

describe("toMinorUnits", () => {
  it("converts a plain amount", () => {
    expect(toMinorUnits(12.34)).toBe(1234)
  })

  it("rounds rather than truncating the float representation", () => {
    // 0.07 * 100 is 7.000000000000001; 0.29 * 100 is 28.999999999999996.
    // Truncation turns the second into 28 — a real cent, lost.
    expect(toMinorUnits(12.34)).toBe(1234)
    expect(toMinorUnits(0.07)).toBe(7)
    expect(toMinorUnits(0.29)).toBe(29)
    expect(toMinorUnits(4.99)).toBe(499)
  })

  it("rounds a half-cent down when the float lands below it", () => {
    // Deliberately pinning actual behaviour, not the arithmetic ideal:
    // 1.005 * 100 is 100.49999999999999, so Math.round gives 100, not 101.
    // Printful only ever sends two-decimal amounts, so this input cannot
    // arise from a real cost — the assertion exists so that anyone changing
    // the converter sees exactly which edge they are moving.
    expect(toMinorUnits(1.005)).toBe(100)
  })

  it("accepts the string Printful uses for digitization", () => {
    expect(toMinorUnits("2.50")).toBe(250)
    expect(toMinorUnits("0")).toBe(0)
  })

  it("treats a missing value as zero", () => {
    expect(toMinorUnits(undefined)).toBe(0)
    expect(toMinorUnits(null)).toBe(0)
    expect(toMinorUnits("")).toBe(0)
  })

  it("rejects a value it cannot trust rather than reporting zero", () => {
    // Returning 0 here would silently claim a cost of nothing, which reads as
    // 100% margin. Undefined forces the caller to omit the field instead.
    expect(toMinorUnits("abc")).toBeUndefined()
    expect(toMinorUnits("4.99abc")).toBeUndefined()
    expect(toMinorUnits(Number.NaN)).toBeUndefined()
    expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(toMinorUnits({} as never)).toBeUndefined()
  })

  it("accepts a negative amount, because a discount is legitimately negative", () => {
    expect(toMinorUnits(-4.99)).toBe(-499)
  })
})

describe("toMinorUnits rounding properties", () => {
  it("never drifts from the exact cent across 1000 amounts", () => {
    // A deterministic sweep of two-decimal amounts. Every one of these is a
    // price a real order could carry, and each has an unambiguous correct
    // answer in cents, so any float drift shows up as an exact mismatch.
    const failures: string[] = []
    for (let cents = 0; cents < 1000; cents++) {
      const major = cents / 100
      const got = toMinorUnits(major)
      if (got !== cents) {
        failures.push(`${major} -> ${got}, expected ${cents}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("agrees between the number and string forms of the same amount", () => {
    // digitization arrives as a string and its siblings as numbers. If the two
    // paths disagreed, one field of a cost breakdown would be off by a cent.
    const failures: string[] = []
    for (let cents = 0; cents < 1000; cents++) {
      const major = cents / 100
      const asNumber = toMinorUnits(major)
      const asString = toMinorUnits(major.toFixed(2))
      if (asNumber !== asString) {
        failures.push(`${major}: number=${asNumber} string=${asString}`)
      }
    }
    expect(failures).toEqual([])
  })
})

const order = (
  costs: Record<string, unknown>,
  retail?: Record<string, unknown>
): PrintfulOrder =>
  ({
    id: 1,
    status: "fulfilled",
    costs,
    ...(retail ? { retail_costs: retail } : {}),
  }) as PrintfulOrder

describe("planCostMetadata", () => {
  it("stores the cost breakdown in minor units", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", subtotal: 10, shipping: 5, total: 15 })
    )
    expect(meta[COST_TOTAL_KEY]).toBe(1500)
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
  })

  it("computes margin as retail minus cost when currencies agree", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", total: 15 }, { currency: "USD", total: 25 })
    )
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[MARGIN_KEY]).toBe(1000)
  })

  it("refuses to compute margin across different currencies", () => {
    // Subtracting USD from EUR produces a number that looks authoritative and
    // is meaningless. Both totals are still stored, each with its currency.
    const meta = planCostMetadata(
      order({ currency: "USD", total: 15 }, { currency: "EUR", total: 25 })
    )
    expect(meta[COST_TOTAL_KEY]).toBe(1500)
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[MARGIN_KEY]).toBeUndefined()
  })

  it("omits margin when retail costs are absent", () => {
    const meta = planCostMetadata(order({ currency: "USD", total: 15 }))
    expect(meta[MARGIN_KEY]).toBeUndefined()
  })

  it("returns nothing at all when the order carries no costs", () => {
    const meta = planCostMetadata({ id: 1, status: "draft" } as PrintfulOrder)
    expect(meta).toEqual({})
  })

  it("omits a field it could not parse rather than storing zero", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", total: "not-a-number" })
    )
    expect(meta[COST_TOTAL_KEY]).toBeUndefined()
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
  })

  it("reads digitization even though Printful types it as a string", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", digitization: "2.50", total: 15 })
    )
    expect(meta["printful_cost_digitization"]).toBe(250)
  })
})

describe("planCostMetadata namespace refresh", () => {
  it("clears a fee the second response omitted rather than leaving it stale", () => {
    // The bug this pins: both call sites merge per-key into existing metadata,
    // so a first stamp carrying `shipping` followed by a re-read that dropped it
    // used to leave the old fee sitting beside a brand new total.
    const first = planCostMetadata(
      order({ currency: "USD", subtotal: 10, shipping: 5, total: 15 })
    )
    expect(first["printful_cost_shipping"]).toBe(500)

    const second = planCostMetadata(
      order({ currency: "USD", subtotal: 18, total: 18 })
    )
    const merged = { ...first, ...second }

    expect(merged[COST_TOTAL_KEY]).toBe(1800)
    expect(merged["printful_cost_shipping"]).toBeUndefined()
    // The key may still be present carrying `undefined`; what matters is that
    // JSON serialization into the jsonb metadata column drops it entirely.
    expect(JSON.parse(JSON.stringify(merged))).not.toHaveProperty(
      "printful_cost_shipping"
    )
  })

  it("emits an explicit undefined for every fee it did not write", () => {
    const meta = planCostMetadata(order({ currency: "USD", total: 15 }))
    // Present-but-undefined is the mechanism: a bare omission would not
    // overwrite the stale key when spread over existing metadata.
    expect(meta).toHaveProperty("printful_cost_shipping")
    expect(meta["printful_cost_shipping"]).toBeUndefined()
  })

  it("still writes nothing at all when the order carries no costs", () => {
    // No costs and no retail means we know nothing, so we must not clear
    // fees a previous, better-informed response legitimately stored.
    const meta = planCostMetadata({ id: 1, status: "draft" } as PrintfulOrder)
    expect(meta).toEqual({})
  })
})

describe("planCreatedOrderMetadata", () => {
  it("stamps the identity keys alongside the costs", () => {
    const meta = planCreatedOrderMetadata(
      order({ currency: "USD", total: 15 }, { currency: "USD", total: 25 })
    )
    expect(meta["printful_order_id"]).toBe("1")
    expect(meta["printful_status"]).toBe("fulfilled")
    expect(meta[COST_TOTAL_KEY]).toBe(1500)
    expect(meta[MARGIN_KEY]).toBe(1000)
  })

  it("stamps the identity keys even when the order carries no costs", () => {
    // The whole point of the fix: a costless order must still become visible
    // in the admin widget, which gates entirely on printful_order_id.
    const meta = planCreatedOrderMetadata({
      id: 42,
      status: "draft",
    } as PrintfulOrder)
    expect(meta["printful_order_id"]).toBe("42")
    expect(meta["printful_status"]).toBe("draft")
  })

  it("coerces a numeric Printful id to the string the widget reads", () => {
    const meta = planCreatedOrderMetadata({
      id: 12345,
      status: "pending",
    } as PrintfulOrder)
    expect(meta["printful_order_id"]).toBe("12345")
  })

  it("does not stamp the sync breadcrumb, which belongs to the webhook path", () => {
    const meta = planCreatedOrderMetadata({
      id: 1,
      status: "draft",
    } as PrintfulOrder)
    expect(meta).not.toHaveProperty("printful_status_updated_at")
  })

  it("uses the same keys planOrderStateActions writes, so a webhook overwrites", () => {
    // If these drifted apart the webhook would write a parallel set of keys and
    // the widget would show whichever one it happened to read.
    const pfOrder = order({ currency: "USD", total: 15 })
    const created = planCreatedOrderMetadata(pfOrder)
    const fromWebhook = planOrderStateActions(pfOrder, []).metadata

    for (const key of Object.keys(created)) {
      expect(fromWebhook).toHaveProperty(key)
    }
    expect(fromWebhook["printful_order_id"]).toBe(created["printful_order_id"])
    expect(fromWebhook["printful_status"]).toBe(created["printful_status"])
  })
})

describe("EUR order against USD Printful pricing", () => {
  it("keeps both totals and withholds the margin", () => {
    // The realistic mismatch: a European store selling in EUR while Printful
    // bills the merchant in USD. Both numbers are real and worth storing; the
    // difference between them is not a number anyone should act on.
    const meta = planCostMetadata(
      order(
        { currency: "USD", subtotal: 10, shipping: 4.99, total: 14.99 },
        { currency: "EUR", subtotal: 20, shipping: 5, total: 25 }
      )
    )

    expect(meta[COST_TOTAL_KEY]).toBe(1499)
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[RETAIL_CURRENCY_KEY]).toBe("eur")
    expect(meta[MARGIN_KEY]).toBeUndefined()
    // 4.99 is the value that truncation would have turned into 498.
    expect(meta["printful_cost_shipping"]).toBe(499)
  })
})
