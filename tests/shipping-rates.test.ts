import { describe, expect, it } from "vitest"
import { buildRateCacheKey } from "../src/utils/shipping-rates"

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
