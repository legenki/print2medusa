import { createHash } from "crypto"
import { parsePriceToMinorUnits } from "./mappers"
import type {
  FallbackReason,
  ShippingInfo,
  ShippingRateItem,
  ShippingRatesRequest,
} from "./types"

/**
 * Shipping methods we expose as fulfillment options.
 *
 * These are Printful's own `ShippingInfo.id` values. The OpenAPI spec publishes
 * no enum — only the example `STANDARD` — so this list comes from the recorded
 * fixture and grows when a live response reveals more.
 *
 * The same string serves as the Medusa option id and the fallbackShippingRates
 * key, so the three cannot drift apart.
 */
export const PRINTFUL_SHIPPING_METHODS = ["STANDARD"] as const

/**
 * The return option id.
 *
 * Not a Printful method id: Printful's rate API quotes outbound shipping only,
 * so a return has no live rate and must be priced flat by the admin.
 */
export const PRINTFUL_RETURN_OPTION_ID = "PRINTFUL_RETURN"

/**
 * Option ids used before 0.3.0. Printful never returns these, so an option row
 * surviving the upgrade prices at zero rather than from a live quote.
 */
export const LEGACY_OPTION_IDS = new Set([
  "printful-standard",
  "printful-return",
])

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
    // `value` is part of the request Printful prices against — it drives
    // duties on international shipments — so it must be part of the identity
    // of the quote, or two carts differing only in price share one answer.
    [...input.items]
      .map((i) => `${i.variant_id}x${i.quantity}x${i.value ?? ""}`)
      .sort(),
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

/** Countries where Printful requires a state code alongside the country. */
const STATE_REQUIRED_COUNTRIES = new Set(["US", "AU", "CA"])

/**
 * Whether an address carries enough for Printful to quote.
 *
 * `calculatePrice` runs on every cart refresh, long before a shipping address
 * exists. Calling the API anyway means a 400 on every storefront visit, so an
 * incomplete address short-circuits to the fallback instead.
 */
export function isAddressQuotable(address: {
  country_code?: string
  state_code?: string
}): boolean {
  const country = (address.country_code ?? "").trim().toUpperCase()
  if (!country) {
    return false
  }
  if (STATE_REQUIRED_COUNTRIES.has(country)) {
    return Boolean((address.state_code ?? "").trim())
  }
  return true
}

export type CartLineForRates = {
  variant_id: string
  quantity: number
  /** Minor units, from the cart line item. */
  unit_price?: number
}

/**
 * Turn cart lines into Printful rate items.
 *
 * `catalogIdByVariantId` maps a Medusa variant id to the Printful *catalog*
 * variant id stored in variant metadata during sync. Lines whose variant has no
 * catalog id are skipped: that covers non-Printful products in a mixed store,
 * and Printful variants synced before the mapper recorded that id.
 */
export function buildRateItems(
  lines: CartLineForRates[],
  catalogIdByVariantId: Map<string, string>
): ShippingRateItem[] {
  const items: ShippingRateItem[] = []

  for (const line of lines) {
    const catalogId = catalogIdByVariantId.get(line.variant_id)
    if (!catalogId) {
      continue
    }
    // parseInt stops at the first invalid character, so "40.12" would parse as
    // 40 — a quote for a different product. Require the whole string to be a
    // positive integer.
    const trimmed = catalogId.trim()
    if (!/^\d+$/.test(trimmed)) {
      continue
    }
    const parsed = Number.parseInt(trimmed, 10)
    if (parsed <= 0) {
      continue
    }

    const quantity = Number(line.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) {
      continue
    }

    items.push({
      variant_id: parsed,
      quantity,
      ...(line.unit_price != null
        ? { value: (line.unit_price / 100).toFixed(2) }
        : {}),
    })
  }

  return items
}
