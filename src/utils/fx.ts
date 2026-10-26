import { minorUnitFactor } from "./currency"

/**
 * Exchange rates for pricing in more than the Printful store's currency.
 *
 * Printful reports a retail price in one currency only — the store's. A shop
 * selling to Europe in euros and to everyone else in dollars needs both on
 * every variant, and Medusa does no conversion of its own: a region whose
 * currency has no price simply has no price, which a storefront shows as 0.
 *
 * The rates are the European Central Bank's daily reference rates. They are
 * free, need no key, publish once a working day, and are what most European
 * merchants quote against anyway.
 */
export const ECB_DAILY_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

export type FxRates = {
  /** The ECB publication date the rates are for. */
  date: string
  /** Units of each currency per one euro, upper-case codes. EUR is 1. */
  perEur: Record<string, number>
}

/**
 * How a converted price is rounded.
 *
 * - `charm` — up to the next .99 (€21.43 → €21.99). Never below the exact
 *   conversion, so a converted price never undercuts the base one.
 * - `whole` — up to the next whole unit (€21.43 → €22.00).
 * - `exact` — the conversion at the currency's own precision (€21.43).
 *
 * Currencies without subunits have no .99, so `charm` rounds them up to a
 * whole unit like `whole` does.
 */
export type ConvertedPriceRounding = "charm" | "whole" | "exact"

/** Parse the ECB daily feed. Null when the body is not that feed. */
export function parseEcbRates(xml: string): FxRates | null {
  if (typeof xml !== "string") {
    return null
  }
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1]
  if (!date) {
    return null
  }

  const perEur: Record<string, number> = { EUR: 1 }
  const entry = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([^'"]+)['"]/g
  for (let m = entry.exec(xml); m; m = entry.exec(xml)) {
    const rate = Number(m[2])
    if (Number.isFinite(rate) && rate > 0) {
      perEur[m[1]] = rate
    }
  }

  return Object.keys(perEur).length > 1 ? { date, perEur } : null
}

/**
 * Fetch today's ECB rates. Null on any failure — never throws.
 *
 * A sync must not fail because a currency feed did. The caller keeps the
 * converted prices it already has rather than writing guesses.
 */
export async function fetchEcbRates(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<FxRates | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(ECB_DAILY_URL, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { Accept: "application/xml, text/xml" },
    })
    if (!res.ok) {
      return null
    }
    return parseEcbRates(await res.text())
  } catch {
    return null
  }
}

/** Round a converted main-unit amount for display as a price. */
export function roundConvertedPrice(
  amount: number,
  currencyCode: string,
  rounding: ConvertedPriceRounding
): number {
  const factor = minorUnitFactor(currencyCode)
  // Settle to the currency's precision first, so float noise from the
  // division (21.990000000000002) cannot push a price up a whole unit.
  const minor = Math.round(amount * factor * 1e6) / 1e6
  const exactMinor = Math.ceil(minor - 1e-6)

  if (rounding === "exact") {
    return Math.round(minor) / factor
  }

  const wholeUnit = factor
  if (rounding === "whole" || factor !== 100) {
    return (Math.ceil(exactMinor / wholeUnit) * wholeUnit) / factor
  }

  // charm: the smallest N.99 at or above the exact amount.
  const units = Math.floor(exactMinor / 100)
  const charm = units * 100 + 99
  return (charm >= exactMinor ? charm : charm + 100) / factor
}

/**
 * Convert a main-unit amount between currencies through EUR, the feed's base.
 *
 * Null when either currency is missing from the rates — the caller must keep
 * what it has rather than price at zero.
 */
export function convertPrice(
  amount: number,
  from: string,
  to: string,
  rates: FxRates,
  rounding: ConvertedPriceRounding
): number | null {
  const source = from.toUpperCase()
  const target = to.toUpperCase()
  if (source === target) {
    return amount
  }
  const fromRate = rates.perEur[source]
  const toRate = rates.perEur[target]
  if (!fromRate || !toRate) {
    return null
  }
  return roundConvertedPrice((amount / fromRate) * toRate, target, rounding)
}
