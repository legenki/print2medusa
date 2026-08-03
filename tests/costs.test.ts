import { describe, expect, it } from "vitest"
import { toMinorUnits } from "../src/utils/costs"

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
