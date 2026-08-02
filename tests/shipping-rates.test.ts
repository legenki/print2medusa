import { describe, expect, it } from "vitest"
import { buildRateCacheKey, selectRate } from "../src/utils/shipping-rates"
import type { ShippingInfo } from "../src/utils/types"

const address = {
  country_code: "US",
  state_code: "CA",
  city: "Chatsworth",
  zip: "91311",
}

describe("buildRateCacheKey", () => {
  it("is stable for identical input", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    expect(a).toBe(b)
  })

  it("ignores item order", () => {
    const a = buildRateCacheKey({
      address,
      items: [
        { variant_id: 1, quantity: 1 },
        { variant_id: 2, quantity: 3 },
      ],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [
        { variant_id: 2, quantity: 3 },
        { variant_id: 1, quantity: 1 },
      ],
      currency: "USD",
    })
    expect(a).toBe(b)
  })

  it("ignores address casing and surrounding whitespace", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address: {
        country_code: " us ",
        state_code: "ca",
        city: " CHATSWORTH",
        zip: "91311 ",
      },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "usd",
    })
    expect(a).toBe(b)
  })

  it("differs when the address differs", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address: { ...address, zip: "90210" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })

  it("differs when quantities differ", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })

  it("differs when the currency differs", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "EUR",
    })
    expect(a).not.toBe(b)
  })

  it("does not let a delimiter in an address field merge two fields", () => {
    // A customer can type "|" into address1. Without escaping, these two
    // different addresses hash identically and share a cached quote.
    const a = buildRateCacheKey({
      address: { country_code: "US", zip: "90001", address1: "1|2" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address: { country_code: "US", zip: "90001|1", address1: "2" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })

  it("does not let a delimiter in an item field merge segments", () => {
    const a = buildRateCacheKey({
      address: { country_code: "US" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD#x",
    })
    const b = buildRateCacheKey({
      address: { country_code: "US" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })
})

const rates: ShippingInfo[] = [
  { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
  { id: "EXPRESS", name: "Express", rate: "15.50", currency: "USD" },
]

describe("selectRate", () => {
  it("finds the method and converts to minor units", () => {
    expect(selectRate(rates, "STANDARD", "USD")).toEqual({
      ok: true,
      amount: 499,
    })
  })

  it("converts without float drift", () => {
    // parseFloat("4.99") * 100 is 498.99999999999994
    expect(selectRate(rates, "STANDARD", "USD")).toEqual({
      ok: true,
      amount: 499,
    })
    expect(selectRate(rates, "EXPRESS", "USD")).toEqual({
      ok: true,
      amount: 1550,
    })
  })

  it("reports method_unavailable when the id is absent", () => {
    expect(selectRate(rates, "OVERNIGHT", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("reports currency_mismatch when the quote is in another currency", () => {
    expect(selectRate(rates, "STANDARD", "EUR")).toEqual({
      ok: false,
      reason: "currency_mismatch",
    })
  })

  it("compares currency case-insensitively", () => {
    expect(selectRate(rates, "STANDARD", "usd")).toEqual({
      ok: true,
      amount: 499,
    })
  })

  it("reports method_unavailable for an empty list", () => {
    expect(selectRate([], "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("rejects a malformed rate rather than returning NaN or zero", () => {
    const bad: ShippingInfo[] = [
      { id: "STANDARD", name: "x", rate: "not-a-number", currency: "USD" },
    ]
    expect(selectRate(bad, "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("rejects a negative rate", () => {
    const bad: ShippingInfo[] = [
      { id: "STANDARD", name: "x", rate: "-4.99", currency: "USD" },
    ]
    expect(selectRate(bad, "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("rejects a rate with trailing garbage rather than truncating it", () => {
    // parseFloat("4.99abc") is 4.99, not NaN — corrupt data must not price.
    const bad: ShippingInfo[] = [
      { id: "STANDARD", name: "x", rate: "4.99abc", currency: "USD" },
    ]
    expect(selectRate(bad, "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("prices a genuinely free method at zero", () => {
    // "0.00" is a legitimate rate, not malformed input — it must not be
    // rejected by the guard that catches unparseable strings.
    const free: ShippingInfo[] = [
      { id: "FREE", name: "Free", rate: "0.00", currency: "USD" },
    ]
    expect(selectRate(free, "FREE", "USD")).toEqual({ ok: true, amount: 0 })
  })

  it("does not match when both the quote and cart currency are empty", () => {
    const empty: ShippingInfo[] = [
      { id: "STANDARD", name: "x", rate: "4.99", currency: "" },
    ]
    expect(selectRate(empty, "STANDARD", "")).toEqual({
      ok: false,
      reason: "currency_mismatch",
    })
  })
})
