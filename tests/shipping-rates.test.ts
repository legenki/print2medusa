import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  buildRateCacheKey,
  selectRate,
  buildRateItems,
  isAddressQuotable,
  PRINTFUL_SHIPPING_METHODS,
} from "../src/utils/shipping-rates"
import { resolveStateCode } from "../src/utils/mappers"
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

  it("differs when only the item value differs", () => {
    // `value` is sent to Printful and drives duties on international
    // shipments, so two carts differing only in price are different quotes.
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1, value: "25.00" }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1, value: "80.00" }],
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

describe("isAddressQuotable", () => {
  it("accepts a country-only address for countries without state requirements", () => {
    expect(isAddressQuotable({ country_code: "DE" })).toBe(true)
    expect(isAddressQuotable({ country_code: "GB" })).toBe(true)
    expect(isAddressQuotable({ country_code: "JP" })).toBe(true)
  })

  it("requires a state code for US, AU, and CA", () => {
    expect(isAddressQuotable({ country_code: "US" })).toBe(false)
    expect(isAddressQuotable({ country_code: "AU" })).toBe(false)
    expect(isAddressQuotable({ country_code: "CA" })).toBe(false)
    expect(isAddressQuotable({ country_code: "US", state_code: "CA" })).toBe(
      true
    )
  })

  it("rejects a missing or blank country", () => {
    expect(isAddressQuotable({ country_code: "" })).toBe(false)
    expect(isAddressQuotable({ country_code: "   " })).toBe(false)
    expect(isAddressQuotable({})).toBe(false)
  })

  it("is case-insensitive about the country", () => {
    expect(isAddressQuotable({ country_code: "us", state_code: "ca" })).toBe(
      true
    )
  })

  it("treats a blank state as missing for state-requiring countries", () => {
    expect(isAddressQuotable({ country_code: "US", state_code: "  " })).toBe(
      false
    )
  })
})

describe("buildRateItems", () => {
  it("builds items from variants carrying a catalog id", () => {
    const items = buildRateItems(
      [
        { variant_id: "var_1", quantity: 2, unit_price: 2500 },
        { variant_id: "var_2", quantity: 1, unit_price: 1000 },
      ],
      new Map([
        ["var_1", "4012"],
        ["var_2", "4013"],
      ])
    )
    expect(items).toEqual([
      { variant_id: 4012, quantity: 2, value: "25.00" },
      { variant_id: 4013, quantity: 1, value: "10.00" },
    ])
  })

  it("skips variants with no catalog id", () => {
    const items = buildRateItems(
      [
        { variant_id: "var_1", quantity: 1, unit_price: 500 },
        { variant_id: "var_other", quantity: 1, unit_price: 500 },
      ],
      new Map([["var_1", "4012"]])
    )
    expect(items).toHaveLength(1)
    expect(items[0].variant_id).toBe(4012)
  })

  it("returns an empty array when nothing is a Printful variant", () => {
    expect(
      buildRateItems([{ variant_id: "x", quantity: 1 }], new Map())
    ).toEqual([])
  })

  it("omits value when the unit price is unknown", () => {
    const items = buildRateItems(
      [{ variant_id: "var_1", quantity: 1 }],
      new Map([["var_1", "4012"]])
    )
    expect(items[0].value).toBeUndefined()
  })

  it("skips a catalog id that is not a number", () => {
    const items = buildRateItems(
      [{ variant_id: "var_1", quantity: 1 }],
      new Map([["var_1", "not-a-number"]])
    )
    expect(items).toEqual([])
  })

  it("skips a catalog id with trailing garbage rather than truncating it", () => {
    // parseInt("40.12") is 40 — a quote for an entirely different product.
    for (const bad of ["4012abc", "40.12", "1e3"]) {
      expect(
        buildRateItems(
          [{ variant_id: "var_1", quantity: 1 }],
          new Map([["var_1", bad]])
        )
      ).toEqual([])
    }
  })

  it("skips non-positive catalog ids", () => {
    for (const bad of ["-1", "0"]) {
      expect(
        buildRateItems(
          [{ variant_id: "var_1", quantity: 1 }],
          new Map([["var_1", bad]])
        )
      ).toEqual([])
    }
  })

  it("tolerates surrounding whitespace in a catalog id", () => {
    const items = buildRateItems(
      [{ variant_id: "var_1", quantity: 1 }],
      new Map([["var_1", " 4012 "]])
    )
    expect(items).toEqual([{ variant_id: 4012, quantity: 1 }])
  })

  it("skips lines whose quantity is not a positive integer", () => {
    const catalog = new Map([["var_1", "4012"]])
    for (const qty of [0, -1, 1.5, NaN]) {
      expect(
        buildRateItems([{ variant_id: "var_1", quantity: qty }], catalog)
      ).toEqual([])
    }
  })

  it("formats value from minor units, including the single-cent boundary", () => {
    const catalog = new Map([["var_1", "4012"]])
    expect(
      buildRateItems(
        [{ variant_id: "var_1", quantity: 1, unit_price: 1 }],
        catalog
      )[0].value
    ).toBe("0.01")
    expect(
      buildRateItems(
        [{ variant_id: "var_1", quantity: 1, unit_price: 0 }],
        catalog
      )[0].value
    ).toBe("0.00")
  })
})

describe("PRINTFUL_SHIPPING_METHODS", () => {
  it("uses Printful's own method ids", () => {
    // The same string is the Medusa option id, the fallbackShippingRates key,
    // and Printful's ShippingInfo.id — so the three cannot drift apart.
    expect(PRINTFUL_SHIPPING_METHODS).toContain("STANDARD")
  })

  it("does not use the invented ids from before 0.3.0", () => {
    expect(PRINTFUL_SHIPPING_METHODS).not.toContain("printful-standard")
  })

  it("matches the ids in the recorded fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "fixtures/printful-shipping-rates.json"),
        "utf8"
      )
    ) as { result: Array<{ id: string }> }
    const fixtureIds = fixture.result.map((r) => r.id)

    // A method we advertise but that Printful never returns is one a customer
    // can select and we can never price live.
    for (const id of PRINTFUL_SHIPPING_METHODS) {
      expect(fixtureIds).toContain(id)
    }
  })

  it("advertises every method the fixture records", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "fixtures/printful-shipping-rates.json"),
        "utf8"
      )
    ) as { result: Array<{ id: string }> }

    // The reverse direction: a fixture method we do not advertise is a
    // sellable shipping option quietly lost.
    for (const id of fixture.result.map((r) => r.id)) {
      expect(PRINTFUL_SHIPPING_METHODS).toContain(id)
    }
  })
})

describe("Printful rate response contract", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/printful-shipping-rates.json"),
      "utf8"
    )
  ) as { code: number; result: ShippingInfo[] }

  it("is shaped like a Printful API envelope", () => {
    expect(typeof fixture.code).toBe("number")
    expect(Array.isArray(fixture.result)).toBe(true)
    expect(fixture.result.length).toBeGreaterThan(0)
  })

  it("still has the fields selectRate depends on", () => {
    for (const rate of fixture.result) {
      expect(typeof rate.id).toBe("string")
      expect(rate.id.length).toBeGreaterThan(0)
      expect(typeof rate.name).toBe("string")
      // A decimal string, never a number — parsing a float for money drifts.
      expect(typeof rate.rate).toBe("string")
      expect(typeof rate.currency).toBe("string")
    }
  })

  it("prices every method in the fixture without falling back", () => {
    for (const rate of fixture.result) {
      const result = selectRate(fixture.result, rate.id, rate.currency)
      expect(result).toEqual({
        ok: true,
        amount: expect.any(Number),
      })
    }
  })
})

describe("country matrix", () => {
  const cases: Array<{
    country: string
    province?: string
    expectState?: string
    quotable: boolean
    why: string
  }> = [
    {
      country: "US",
      province: "California",
      expectState: "CA",
      quotable: true,
      why: "state required and resolvable",
    },
    {
      country: "CA",
      province: "Ontario",
      expectState: "ON",
      quotable: true,
      why: "state required and resolvable",
    },
    {
      country: "AU",
      province: "New South Wales",
      expectState: "NSW",
      quotable: true,
      why: "state required and resolvable",
    },
    {
      country: "DE",
      province: "Bavaria",
      expectState: undefined,
      quotable: true,
      why: "no state table, and Printful does not require one",
    },
    {
      country: "GB",
      province: "Greater London",
      expectState: undefined,
      quotable: true,
      why: "no state table, and Printful does not require one",
    },
    {
      country: "JP",
      province: "Tokyo",
      expectState: undefined,
      quotable: true,
      why: "no state table, and Printful does not require one",
    },
    {
      country: "US",
      province: "Nowhere",
      expectState: undefined,
      quotable: false,
      why: "state required but unresolvable — quoting would 400",
    },
    {
      country: "AU",
      province: undefined,
      expectState: undefined,
      quotable: false,
      why: "state required and absent",
    },
  ]

  for (const c of cases) {
    it(`${c.country}${c.province ? ` / ${c.province}` : ""}: ${c.why}`, () => {
      const state = resolveStateCode(c.province, c.country)
      expect(state).toBe(c.expectState)
      expect(
        isAddressQuotable({ country_code: c.country, state_code: state })
      ).toBe(c.quotable)
    })
  }
})
