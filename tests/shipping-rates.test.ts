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
})
