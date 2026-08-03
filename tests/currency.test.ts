import { describe, expect, it } from "vitest"
import { minorUnitFactor, isZeroDecimalCurrency } from "../src/utils/currency"

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
