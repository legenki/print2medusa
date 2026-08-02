import { createHash } from "crypto"
import type { ShippingRateItem, ShippingRatesRequest } from "./types"

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
