import { describe, expect, it, vi } from "vitest"
import {
  convertPrice,
  fetchEcbRates,
  parseEcbRates,
  roundConvertedPrice,
} from "../src/utils/fx"

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-10-23'>
      <Cube currency='USD' rate='1.1665'/>
      <Cube currency='JPY' rate='176.12'/>
      <Cube currency='GBP' rate='0.8712'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`

describe("parseEcbRates", () => {
  it("reads every rate, with EUR itself as 1", () => {
    const rates = parseEcbRates(ECB_XML)
    expect(rates).toEqual({
      date: "2026-10-23",
      perEur: { EUR: 1, USD: 1.1665, JPY: 176.12, GBP: 0.8712 },
    })
  })

  it("returns null for a body that is not the ECB feed", () => {
    expect(parseEcbRates("<html>maintenance</html>")).toBeNull()
    expect(parseEcbRates("")).toBeNull()
  })

  it("ignores a rate that is not a positive number", () => {
    const rates = parseEcbRates(
      `<Cube time='2026-10-23'><Cube currency='USD' rate='abc'/><Cube currency='GBP' rate='0.87'/></Cube>`
    )
    expect(rates?.perEur).toEqual({ EUR: 1, GBP: 0.87 })
  })
})

describe("roundConvertedPrice", () => {
  it("charm-rounds up to .99, never below the exact conversion", () => {
    expect(roundConvertedPrice(21.43, "eur", "charm")).toBe(21.99)
    expect(roundConvertedPrice(21.99, "eur", "charm")).toBe(21.99)
    expect(roundConvertedPrice(21.991, "eur", "charm")).toBe(22.99)
    expect(roundConvertedPrice(22, "eur", "charm")).toBe(22.99)
  })

  it("rounds up to a whole unit", () => {
    expect(roundConvertedPrice(21.43, "eur", "whole")).toBe(22)
    expect(roundConvertedPrice(22, "eur", "whole")).toBe(22)
  })

  it("keeps the exact conversion at the currency's precision", () => {
    expect(roundConvertedPrice(21.4321, "eur", "exact")).toBe(21.43)
  })

  it("has no .99 for a currency without subunits", () => {
    expect(roundConvertedPrice(3775.2, "jpy", "charm")).toBe(3776)
  })

  it("does not let float noise push an exact price up a whole unit", () => {
    // 21.99 can arrive as 21.990000000000002 after division.
    expect(roundConvertedPrice(21.990000000000002, "eur", "charm")).toBe(21.99)
    expect(roundConvertedPrice(22.000000000000004, "eur", "whole")).toBe(22)
  })
})

describe("convertPrice", () => {
  const rates = parseEcbRates(ECB_XML)!

  it("converts through EUR, the feed's base", () => {
    // $25 / 1.1665 = €21.43 → €21.99
    expect(convertPrice(25, "usd", "eur", rates, "charm")).toBe(21.99)
    // $25 → £18.67 → £18.99
    expect(convertPrice(25, "USD", "GBP", rates, "charm")).toBe(18.99)
  })

  it("returns null when either currency has no rate", () => {
    expect(convertPrice(25, "usd", "chf", rates, "charm")).toBeNull()
    expect(convertPrice(25, "xxx", "eur", rates, "charm")).toBeNull()
  })

  it("passes a same-currency amount through untouched", () => {
    expect(convertPrice(25, "usd", "USD", rates, "charm")).toBe(25)
  })
})

describe("fetchEcbRates", () => {
  it("returns parsed rates on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(ECB_XML))
    const rates = await fetchEcbRates({ fetchImpl })
    expect(rates?.perEur.USD).toBe(1.1665)
  })

  it("returns null rather than throwing when the feed is down", async () => {
    // A sync must not fail because a currency feed did: it keeps the prices
    // it already has instead.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"))
    expect(await fetchEcbRates({ fetchImpl })).toBeNull()

    const bad = vi.fn().mockResolvedValue(new Response("oops", { status: 503 }))
    expect(await fetchEcbRates({ fetchImpl: bad })).toBeNull()
  })
})
