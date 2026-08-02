import { createHash } from "crypto"
import { parsePriceToMinorUnits } from "./mappers"
import type {
  FallbackReason,
  ShippingInfo,
  ShippingRateItem,
  ShippingRatesRequest,
} from "./types"

export type RateCacheKeyInput = {
  address: ShippingRatesRequest["recipient"]
  items: ShippingRateItem[]
  currency: string
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

/**
 * Cache key for a rate quote.
 *
 * Deliberately excludes the shipping method: Printful returns every method in
 * one response, so a store offering two options costs one API call rather than
 * two. `selectRate` picks the method from the cached list locally.
 *
 * Carts that differ only incidentally — item order, address casing, stray
 * whitespace — must produce the same key, or the cache never hits.
 */
export function buildRateCacheKey(input: RateCacheKeyInput): string {
  // JSON-encode rather than joining with delimiters: a "|" typed into an
  // address field would otherwise merge two fields and collide with a
  // genuinely different address.
  const canonical = JSON.stringify([
    normalize(input.address.country_code),
    normalize(input.address.state_code),
    normalize(input.address.city),
    normalize(input.address.zip),
    normalize(input.address.address1),
    normalize(input.address.address2),
    [...input.items].map((i) => `${i.variant_id}x${i.quantity}`).sort(),
    normalize(input.currency),
  ])

  return createHash("sha256").update(canonical).digest("hex")
}

export type RateSelection =
  { ok: true; amount: number } | { ok: false; reason: FallbackReason }

/**
 * Pick one method out of a quote list.
 *
 * Printful sends `rate` as a decimal string; `parsePriceToMinorUnits` rounds it
 * correctly, where `parseFloat("4.99") * 100` would yield 498.99999999999994.
 *
 * A quote in a currency the cart cannot use is rejected rather than converted —
 * we never source an exchange rate ourselves.
 */
export function selectRate(
  rates: ShippingInfo[],
  methodId: string,
  cartCurrency: string
): RateSelection {
  const match = rates.find((r) => r.id === methodId)
  if (!match) {
    return { ok: false, reason: "method_unavailable" }
  }

  const quoteCurrency = match.currency.trim().toUpperCase()
  const wantCurrency = cartCurrency.trim().toUpperCase()
  if (!quoteCurrency || !wantCurrency || quoteCurrency !== wantCurrency) {
    return { ok: false, reason: "currency_mismatch" }
  }

  // parseFloat stops at the first invalid character, so "4.99abc" would parse
  // as 4.99 and "-4.99" as a negative price. Require the whole string to be a
  // non-negative decimal; "0.00" is a legitimate free method and must pass.
  if (!/^\d+(\.\d+)?$/.test(match.rate.trim())) {
    return { ok: false, reason: "method_unavailable" }
  }

  return { ok: true, amount: parsePriceToMinorUnits(match.rate) }
}
