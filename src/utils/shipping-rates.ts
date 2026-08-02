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
  const address = [
    normalize(input.address.country_code),
    normalize(input.address.state_code),
    normalize(input.address.city),
    normalize(input.address.zip),
    normalize(input.address.address1),
    normalize(input.address.address2),
  ].join("|")

  const items = [...input.items]
    .map((i) => `${i.variant_id}x${i.quantity}`)
    .sort()
    .join(",")

  return createHash("sha256")
    .update(`${address}#${items}#${normalize(input.currency)}`)
    .digest("hex")
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

  if (
    match.currency.trim().toUpperCase() !== cartCurrency.trim().toUpperCase()
  ) {
    return { ok: false, reason: "currency_mismatch" }
  }

  // parsePriceToMinorUnits returns 0 for unparseable input, which would be a
  // free delivery rather than an error — treat a non-numeric rate as no rate.
  if (!match.rate || Number.isNaN(Number.parseFloat(match.rate))) {
    return { ok: false, reason: "method_unavailable" }
  }

  return { ok: true, amount: parsePriceToMinorUnits(match.rate) }
}
