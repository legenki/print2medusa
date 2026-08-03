import { createHash } from "crypto"
import { minorUnitFactor } from "./currency"
import { parsePriceToMinorUnits } from "./mappers"
import type {
  CachedQuote,
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

  // Scaled by the quote's own currency. The equality check above already
  // proved it matches the cart's, so either code would do — the quote's is
  // used because it is the currency the rate string is actually denominated in.
  return { ok: true, amount: parsePriceToMinorUnits(match.rate, quoteCurrency) }
}

/** What `shipping_method.data.rate_source` may hold after confirmation. */
export type MethodConfirmation = "live" | FallbackReason

export type ConfirmMethodInput = {
  /** The entry `calculatePrice` wrote under the shared cache key, if any. */
  cached: CachedQuote | null
  /** How long an entry counts as fresh, in milliseconds. */
  freshnessMs: number
  methodId: string
  currency: string
}

export type ConfirmMethodResult =
  | { confirmation: "live"; methodId: string }
  | { confirmation: Exclude<MethodConfirmation, "live"> }

/**
 * Decide whether a cached quote confirms the method the customer selected.
 *
 * Pure: the caller re-fetches and calls again when this does not confirm, so
 * the decision itself never reaches the network.
 *
 * A stale entry never confirms, which is deliberately unlike `calculatePrice`'s
 * `staleOrFlat`. Serving a stale *price* is defensible — the customer sees a
 * number that was true recently. Serving a stale *method confirmation* is not:
 * the method may have stopped being offered, and stamping "live" on it would
 * record an agreement Printful never made. Only a fresh entry, or a re-fetch
 * the caller performs after this returns, can confirm.
 *
 * `misconfigured_zero` is reachable in `FallbackReason` but not here: it
 * describes a missing flat rate, and confirmation never consults
 * `fallbackShippingRates`.
 */
export function confirmMethod(input: ConfirmMethodInput): ConfirmMethodResult {
  const { cached, freshnessMs, methodId, currency } = input

  if (!cached) {
    return { confirmation: "printful_unreachable" }
  }

  // A negative age means the entry is dated in the future — clock skew on the
  // cache node — which would otherwise read as fresh until that date passes.
  // Same guard `calculatePrice` applies before trusting a fresh hit.
  const age = Date.now() - cached.cached_at
  if (age < 0 || age >= freshnessMs) {
    return { confirmation: "printful_unreachable" }
  }

  // `selectRate` already answers "does this list offer this method in a usable
  // currency", including the currency-mismatch and malformed-rate cases, so
  // the check is not reimplemented here.
  const hit = selectRate(cached.rates, methodId, currency)
  if (!hit.ok) {
    return { confirmation: hit.reason }
  }

  return { confirmation: "live", methodId }
}

/** A shipping method as the order path reads it back. */
export type RecordedShippingMethod = {
  data?: Record<string, unknown> | null
}

/**
 * Decide the `shipping` override to send Printful for an order, if any.
 *
 * Pure, and a read of what `validateFulfillmentData` already recorded — the
 * order path never calls Printful to re-confirm. All three conditions must
 * hold: an id is present, `rate_source` marks it live, and the id is one we
 * actually offer.
 *
 * Each condition guards a distinct way a bad override reaches an order.
 * `"live"` without an id proves only that some quote succeeded, not which
 * method it was for. An id without `"live"` is what 0.3.0 through 0.6.0 wrote —
 * those methods carry no `rate_source` at all, so trusting a bare id would turn
 * that release's dead code into a live promise on the first upgraded order. And
 * an id outside the allowlist is one this plugin never offered.
 *
 * Omitting the override is always safe: Printful then picks the method itself,
 * which is exactly today's behaviour. Sending an unconfirmed one is not — it
 * insists on a method Printful may not offer for that destination, risking a
 * rejected order. So every uncertain case resolves to `undefined`.
 */
export function shippingOverrideFor(
  methods: RecordedShippingMethod[] | undefined | null
): string | undefined {
  const confirmed = new Set<string>()

  for (const method of methods ?? []) {
    const data = method?.data
    if (!data) {
      continue
    }

    // Read as own properties: a crafted `data` blob deserialized from JSON
    // cannot reach up the prototype chain, but a method id like "constructor"
    // resolving to a function would otherwise pass the allowlist check below.
    const id = Object.prototype.hasOwnProperty.call(data, "printful_shipping")
      ? data.printful_shipping
      : undefined
    const source = Object.prototype.hasOwnProperty.call(data, "rate_source")
      ? data.rate_source
      : undefined

    if (typeof id !== "string" || source !== "live") {
      continue
    }
    if (!(PRINTFUL_SHIPPING_METHODS as readonly string[]).includes(id)) {
      continue
    }

    confirmed.add(id)
  }

  // Printful's `shipping` takes one value. One confirmed method — or several
  // naming the same one, which a multi-profile cart shipping everything the
  // same way produces — is unambiguous. Two genuinely different confirmed
  // methods are not: picking either would override a method the customer paid
  // for on the other profile, so we let Printful choose instead. Unconfirmed
  // methods never enter this set, so a return method riding along on the order
  // cannot veto the outbound method the customer selected.
  return confirmed.size === 1 ? [...confirmed][0] : undefined
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
 * The shape both rate paths read a cart out of.
 *
 * `calculatePrice` receives a `CalculateShippingOptionPriceContext` and
 * `validateFulfillmentData` receives `{ ...cart }`. Both are structurally carts,
 * but neither is typed with the fields we actually need (`CartPropsForFulfillment`
 * declares no `currency_code` and no `unit_price`), so both call sites narrow to
 * this instead of to a framework type that does not describe what arrives.
 */
export type RateContext = {
  currency_code?: string
  shipping_address?: {
    country_code?: string
    province?: string
    city?: string
    postal_code?: string
    address_1?: string
    address_2?: string
  }
  items?: Array<{
    variant?: {
      id?: string
      /**
       * Present in both cart contexts — `cartFieldsForRefreshSteps` selects
       * `items.variant.product.shipping_profile.id`. It is what lets the
       * confirmation path narrow to the same lines the pricing path was given.
       */
      product?: { shipping_profile?: { id?: string } }
    }
    quantity?: number
    unit_price?: number
  }>
}

/** Why a rate request could not be built at all. */
export type RateRequestFailure = "incomplete_address" | "no_printful_items"

export type RateRequestPlan =
  | {
      ok: true
      recipient: ShippingRatesRequest["recipient"]
      items: ShippingRateItem[]
      currency: string
      cacheKey: string
      /** Medusa variant ids read off the context, before catalog resolution. */
      variantIds: string[]
    }
  | { ok: false; reason: RateRequestFailure }

/**
 * Read the cart lines a rate request would be built from.
 *
 * Split out from `buildRateRequest` because the caller must resolve catalog ids
 * for these variants — a container-bound `query` lookup — before the request can
 * be built. Keeping the lookup outside lets the builder stay pure.
 *
 * `shippingProfileId` narrows to the lines that ship under one profile. Medusa
 * hands the two paths different item lists for the same cart: the pricing
 * workflow filters by the option's profile
 * (`list-shipping-options-for-cart-with-pricing.js:266`), while the
 * add-method workflow passes the cart whole (`add-shipping-method-to-cart.js:90`).
 * Inheriting that difference would give the two paths different cache keys, so
 * a confirmation would miss the entry pricing wrote seconds earlier — silently,
 * and only on mixed-profile carts.
 *
 * Unlike Medusa's own `filterCartItemsByShippingProfile`, this **fails open**:
 * a line whose profile is absent is kept rather than dropped. Medusa filters a
 * list it populated itself and can fail closed safely; this runs on a context
 * that may legitimately omit the field, where dropping would report a cart as
 * having no Printful items at all.
 */
export function rateLinesFrom(
  context: RateContext,
  shippingProfileId?: string
): CartLineForRates[] {
  return (context.items ?? [])
    .filter((i) => i.variant?.id)
    .filter((i) => {
      if (!shippingProfileId) {
        return true
      }
      const profile = i.variant?.product?.shipping_profile?.id
      return profile === undefined || profile === shippingProfileId
    })
    .map((i) => ({
      variant_id: i.variant!.id as string,
      quantity: Number(i.quantity ?? 1),
      unit_price: i.unit_price,
    }))
}

/**
 * Build the Printful rate request and its cache key from a cart context.
 *
 * `calculatePrice` and `validateFulfillmentData` must agree on the cache key
 * exactly: the confirm path is only cheap because it reads the entry the pricing
 * path wrote moments earlier under the same key. Two call sites computing that
 * key independently would drift silently — a confirmation would miss a live
 * entry and re-hit the API, or confirm against a differently-shaped cart. One
 * function, called by both, is what makes the drift impossible.
 */
export function buildRateRequest(
  context: RateContext,
  lines: CartLineForRates[],
  catalogIdByVariantId: Map<string, string>,
  stateCode: string | undefined
): RateRequestPlan {
  const addr = context.shipping_address ?? {}
  const countryCode = (addr.country_code ?? "").toUpperCase()

  if (
    !isAddressQuotable({ country_code: countryCode, state_code: stateCode })
  ) {
    return { ok: false, reason: "incomplete_address" }
  }

  // Resolved before the items are built: each line's `value` is denominated in
  // the cart's currency, so it decides how the minor units convert out.
  const currency = (context.currency_code ?? "").toUpperCase()

  const items = buildRateItems(lines, catalogIdByVariantId, currency)

  if (!items.length) {
    return { ok: false, reason: "no_printful_items" }
  }

  const recipient = {
    country_code: countryCode,
    ...(stateCode ? { state_code: stateCode } : {}),
    ...(addr.city ? { city: addr.city } : {}),
    ...(addr.postal_code ? { zip: addr.postal_code } : {}),
    ...(addr.address_1 ? { address1: addr.address_1 } : {}),
    ...(addr.address_2 ? { address2: addr.address_2 } : {}),
  }

  return {
    ok: true,
    recipient,
    items,
    currency,
    cacheKey: buildRateCacheKey({ address: recipient, items, currency }),
    variantIds: lines.map((l) => l.variant_id),
  }
}

/**
 * Turn cart lines into Printful rate items.
 *
 * `catalogIdByVariantId` maps a Medusa variant id to the Printful *catalog*
 * variant id stored in variant metadata during sync. Lines whose variant has no
 * catalog id are skipped: that covers non-Printful products in a mixed store,
 * and Printful variants synced before the mapper recorded that id.
 *
 * `unit_price` is minor units in the cart's currency and `value` is the decimal
 * string Printful expects, so the conversion out is the currency's factor and
 * the decimal count is the currency's too. A ¥1500 line sends "1500": dividing
 * it by 100 would declare a ¥15 parcel to customs and quote its shipping.
 */
export function buildRateItems(
  lines: CartLineForRates[],
  catalogIdByVariantId: Map<string, string>,
  cartCurrency?: string
): ShippingRateItem[] {
  const items: ShippingRateItem[] = []
  const factor = minorUnitFactor(cartCurrency)
  // 100 → 2 decimals, 1 → 0. Printful reads the string as a decimal number, so
  // "1500.00" for yen would be as wrong as it is malformed.
  const decimals = factor === 1 ? 0 : 2

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
        ? { value: (line.unit_price / factor).toFixed(decimals) }
        : {}),
    })
  }

  return items
}
