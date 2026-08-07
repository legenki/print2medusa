import { describe, expect, it } from "vitest"
import {
  minorUnitFactor,
  isZeroDecimalCurrency,
  ZERO_DECIMAL_CURRENCIES as ZERO_DECIMAL_FOR_TEST,
} from "../src/utils/currency"

describe("isZeroDecimalCurrency", () => {
  it("recognizes the currencies with no minor unit", () => {
    // ¥1500 is fifteen hundred yen, not fifteen yen — JPY has no subunit in
    // circulation, so Medusa stores the major unit directly.
    expect(isZeroDecimalCurrency("JPY")).toBe(true)
    expect(isZeroDecimalCurrency("KRW")).toBe(true)
    expect(isZeroDecimalCurrency("VND")).toBe(true)
  })

  it("recognizes the ones people forget", () => {
    // Not on the short list most implementations hardcode. This is the reason
    // the table comes from Medusa rather than a list typed out here.
    expect(isZeroDecimalCurrency("HUF")).toBe(true)
    expect(isZeroDecimalCurrency("ISK")).toBe(true)
    expect(isZeroDecimalCurrency("CLP")).toBe(true)
  })

  it("is false for ordinary two-decimal currencies", () => {
    expect(isZeroDecimalCurrency("USD")).toBe(false)
    expect(isZeroDecimalCurrency("EUR")).toBe(false)
    expect(isZeroDecimalCurrency("GBP")).toBe(false)
  })

  it("accepts either case, because Printful and Medusa disagree on it", () => {
    // Printful sends "USD"; Medusa stores "usd". Both reach this.
    expect(isZeroDecimalCurrency("jpy")).toBe(true)
    expect(isZeroDecimalCurrency("JpY")).toBe(true)
    expect(isZeroDecimalCurrency("usd")).toBe(false)
  })

  it("treats an unknown or missing code as having minor units", () => {
    // Two decimals is the overwhelming default, and guessing zero would
    // deflate a real amount by 100x. Guessing two only mis-scales the rare
    // zero-decimal currency we failed to recognize.
    expect(isZeroDecimalCurrency("ZZZ")).toBe(false)
    expect(isZeroDecimalCurrency(undefined)).toBe(false)
    expect(isZeroDecimalCurrency(null)).toBe(false)
    expect(isZeroDecimalCurrency("")).toBe(false)
  })
})

describe("minorUnitFactor", () => {
  it("is 1 where the major unit is the minor unit", () => {
    expect(minorUnitFactor("JPY")).toBe(1)
    expect(minorUnitFactor("krw")).toBe(1)
  })

  it("is 100 for ordinary currencies", () => {
    expect(minorUnitFactor("USD")).toBe(100)
    expect(minorUnitFactor("eur")).toBe(100)
  })

  it("is 100 for anything it cannot identify", () => {
    expect(minorUnitFactor(undefined)).toBe(100)
    expect(minorUnitFactor("ZZZ")).toBe(100)
  })
})

describe("the built-in list against Medusa's own table", () => {
  // Imported here, in a test that only ever runs under Node. The module under
  // test deliberately does not import it: `@medusajs/framework/utils` reaches
  // jsonwebtoken → jws → util.inherits, which a browser does not have, and the
  // admin widget imports currency.ts. See the header of src/utils/currency.ts.
  //
  // This is what makes the hand-written list safe. The usual objection — that
  // HUF, ISK and CLP get missed — is answered by failing here rather than by
  // trusting whoever edits the list next.
  it("classifies every currency Medusa knows the same way Medusa does", async () => {
    const { defaultCurrencies } = await import("@medusajs/framework/utils")

    const disagreements = Object.entries(defaultCurrencies)
      .filter(
        ([code, entry]) =>
          isZeroDecimalCurrency(code) !== (entry.decimal_digits === 0)
      )
      .map(([code]) => code)

    expect(disagreements).toEqual([])
  })

  it("holds no code Medusa does not consider zero-decimal", async () => {
    // The reverse direction. The test above walks Medusa's table, so a code
    // this list invented — a typo, or one Medusa later dropped — would never
    // be visited and would go on forcing a factor of 1 on real money.
    const { defaultCurrencies } = await import("@medusajs/framework/utils")

    const known = new Set(
      Object.entries(defaultCurrencies)
        .filter(([, entry]) => entry.decimal_digits === 0)
        .map(([code]) => code)
    )

    const missing = [...known].filter((code) => !isZeroDecimalCurrency(code))
    expect(missing).toEqual([])

    // The direction the check above cannot see. A code this list invented — a
    // typo, or one Medusa later dropped — is absent from Medusa's table, so
    // walking that table never visits it. Left unchecked it would go on
    // forcing a factor of 1 on money that has subunits, deflating every
    // amount in that currency by a hundred.
    const everyCode = Object.keys(defaultCurrencies)
    const invented = everyCode.filter(
      (code) => isZeroDecimalCurrency(code) && !known.has(code)
    )
    expect(invented).toEqual([])

    // Nothing outside Medusa's table at all: a code Medusa never had would
    // pass both filters above, since both iterate the table.
    const knownEverywhere = new Set(everyCode)
    const strangers = [...ZERO_DECIMAL_FOR_TEST].filter(
      (code) => !knownEverywhere.has(code)
    )
    expect(strangers).toEqual([])
  })
})
