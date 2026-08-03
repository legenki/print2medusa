import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceContext,
  CalculateShippingOptionPriceDTO,
  CreateShippingOptionDTO,
  FulfillmentOption,
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
} from "@medusajs/framework/types"
import { PrintfulClient } from "../../utils/printful-client"
import { resolveStateCode } from "../../utils/mappers"
import {
  buildRateRequest,
  confirmMethod,
  isAddressQuotable,
  LEGACY_OPTION_IDS,
  PRINTFUL_RETURN_OPTION_ID,
  PRINTFUL_SHIPPING_METHODS,
  rateLinesFrom,
  selectRate,
} from "../../utils/shipping-rates"
import type {
  MethodConfirmation,
  RateContext,
  RateRequestPlan,
} from "../../utils/shipping-rates"
import type {
  CachedQuote,
  FallbackReason,
  PrintfulPluginOptions,
  RateSource,
  ShippingInfo,
} from "../../utils/types"

type QueryLike = {
  graph: (input: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }) => Promise<{ data: unknown }>
}

type CacheLike = {
  get: <T>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, ttl?: number) => Promise<void>
}

type InjectedDependencies = {
  logger: {
    info: (msg: string) => void
    error: (msg: string) => void
    warn: (msg: string) => void
    debug?: (msg: string) => void
  }
  /**
   * Bridged only when the store owner adds `dependencies: ["query"]` to the
   * fulfillment module. Unbridged keys resolve to undefined, never throw, so
   * this must be treated as optional at runtime regardless of the type.
   */
  query?: QueryLike
  /** Medusa registers the caching module under "caching", not "cache". */
  caching?: CacheLike
}

class PrintfulFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "printful"

  protected logger_: InjectedDependencies["logger"]
  protected options_: PrintfulPluginOptions
  protected client_: PrintfulClient
  protected query_?: QueryLike
  protected cache_?: CacheLike
  /** How long a cached quote counts as fresh, in milliseconds. */
  protected freshnessMs_: number
  /** How long a cached quote is retained so it can serve as a stale fallback. */
  protected staleSeconds_: number

  constructor(container: InjectedDependencies, options: PrintfulPluginOptions) {
    super()
    this.logger_ = container.logger
    this.options_ = options || ({} as PrintfulPluginOptions)

    if (!this.options_.apiToken) {
      this.logger_.warn(
        "Printful fulfillment provider: apiToken is missing from options"
      )
    }

    this.query_ = container.query
    this.cache_ = container.caching

    if (this.options_.liveShippingRates && !this.query_) {
      this.logger_.error(
        "Printful live shipping rates need variant metadata, which requires " +
          'adding dependencies: ["query"] to the @medusajs/medusa/fulfillment ' +
          "module in medusa-config.ts. Falling back to flat rates until then."
      )
    }

    if (
      this.options_.liveShippingRates &&
      !this.options_.fallbackShippingRates
    ) {
      this.logger_.error(
        "Printful live shipping rates are enabled without fallbackShippingRates. " +
          "A Printful outage will price shipping at zero."
      )
    }

    // Coerce the TTLs once here rather than trusting them on every call: they
    // arrive from user config and may be strings, zero, or absent.
    const freshSeconds =
      Number(this.options_.shippingRateCacheTtlSeconds) > 0
        ? Number(this.options_.shippingRateCacheTtlSeconds)
        : 600
    const staleSeconds =
      Number(this.options_.shippingRateStaleSeconds) > 0
        ? Number(this.options_.shippingRateStaleSeconds)
        : 86400

    // The stale tier cannot outlive the cache entry, so retention must be at
    // least the freshness window.
    this.freshnessMs_ = freshSeconds * 1000
    this.staleSeconds_ = Math.max(freshSeconds, staleSeconds)

    if (staleSeconds < freshSeconds) {
      this.logger_.warn(
        "shippingRateStaleSeconds is below shippingRateCacheTtlSeconds; " +
          "raising it, since a stale quote cannot outlive its cache entry."
      )
    }

    this.client_ = new PrintfulClient({
      apiToken: this.options_.apiToken || "",
      storeId: this.options_.storeId,
    })
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      ...PRINTFUL_SHIPPING_METHODS.map((id) => ({
        id,
        name: `Printful ${id}`,
      })),
      {
        id: PRINTFUL_RETURN_OPTION_ID,
        name: "Printful Return",
        is_return: true,
      },
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    const id = data?.id
    return (
      typeof id === "string" &&
      ((PRINTFUL_SHIPPING_METHODS as readonly string[]).includes(id) ||
        id === PRINTFUL_RETURN_OPTION_ID)
    )
  }

  /**
   * Validate the selected method and record whether Printful confirmed it.
   *
   * Medusa persists this return value verbatim as `shipping_method.data`
   * (`add-shipping-method-to-cart.js:116`), and `complete-cart.js:405` copies
   * it onto the order — which is what makes this the right place to record the
   * confirmation. 0.3.0 stamped these fields onto `calculatePrice`'s return
   * value instead, which Medusa discards, so the feature was dead code.
   *
   * Everything except the unrecognized-id throw fails soft. This runs once, at
   * selection, so an API call is affordable here in a way it is not on the
   * pricing path — but a confirmation failure must never block a sale, and an
   * unconfirmed method simply lets Printful choose, exactly as it does today.
   */
  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // Runs when the method is added to the cart, not on every price refresh, so
    // throwing here does not violate calculatePrice's never-throw constraint.
    // Inventing a default would record one method on the order while the
    // customer was priced for another.
    const id = optionData?.id
    // The return option is accepted here for the same reason `validateOption`
    // accepts it: it is a real option this provider offers. It is excluded from
    // live rates in `canCalculate` — Printful quotes outbound shipping only —
    // not from being usable. Rejecting it here made an option the merchant
    // could create and price but never add to a cart.
    if (
      typeof id !== "string" ||
      !(
        (PRINTFUL_SHIPPING_METHODS as readonly string[]).includes(id) ||
        id === PRINTFUL_RETURN_OPTION_ID
      )
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Printful shipping option has an unrecognized method id ` +
          `(${JSON.stringify(id)}). Recreate it against one of: ` +
          `${[...PRINTFUL_SHIPPING_METHODS, PRINTFUL_RETURN_OPTION_ID].join(", ")}.`
      )
    }
    const validated = { ...data, printful_option_id: id }

    // Printful quotes outbound shipping only, so a return has nothing to
    // confirm against — `canCalculate` already excludes it from live rates for
    // the same reason. It carries no rate_source at all.
    if (id === PRINTFUL_RETURN_OPTION_ID) {
      return validated
    }

    let confirmation: MethodConfirmation
    try {
      confirmation = await this.confirmSelectedMethod(
        id,
        context as unknown as RateContext
      )
    } catch (err) {
      // A bug in our own code must not block a sale any more than a Printful
      // outage does.
      this.logger_.error(
        `Printful method confirmation failed unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      confirmation = "printful_unreachable"
    }

    if (confirmation !== "live") {
      // No `printful_shipping`: the order path sends an override only for a
      // method Printful confirmed, so omitting it lets Printful pick — the
      // behaviour every order had before this release.
      this.logger_.debug?.(
        `Printful method ${id} not confirmed (${confirmation}); ` +
          "the order will let Printful choose the shipping method."
      )
      return { ...validated, rate_source: confirmation }
    }

    return {
      ...validated,
      printful_shipping: id,
      rate_source: "live",
    }
  }

  /**
   * Ask whether Printful offers this method for this cart.
   *
   * Goes through `planRateRequest`, the same seam `calculatePrice` uses, so the
   * two compute the same cache key and this usually reads the entry pricing
   * wrote seconds earlier rather than hitting the API.
   *
   * A stale entry never confirms, and a failed re-fetch does not fall back to
   * one the way `staleOrFlat` does — `confirmMethod` encodes that rule and this
   * does not work around it.
   */
  private async confirmSelectedMethod(
    methodId: string,
    ctx: RateContext
  ): Promise<MethodConfirmation> {
    const plan = await this.planRateRequest(ctx)
    if (!plan.ok) {
      // `incomplete_address` cannot reach a shipping-method selection in
      // practice, but it is not a FallbackReason we want to invent a meaning
      // for either; reporting it as unreachable would misdirect an operator to
      // Printful's status page, so it is recorded as-is.
      return plan.reason
    }

    const { recipient, items, currency, cacheKey } = plan

    const cached = await this.readCache(cacheKey)
    const fromCache = confirmMethod({
      cached,
      freshnessMs: this.freshnessMs_,
      methodId,
      currency,
    })
    if (fromCache.confirmation === "live") {
      return "live"
    }

    let rates: ShippingInfo[]
    try {
      rates = await this.client_.getShippingRates({
        recipient,
        items,
        ...(currency ? { currency } : {}),
      })
    } catch (err) {
      this.logger_.warn(
        `Printful method confirmation could not reach Printful: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return "printful_unreachable"
    }

    // Written back under the shared key so a subsequent price refresh reuses
    // this response instead of paying for another call.
    await this.writeCache(
      cacheKey,
      { rates, currency, cached_at: Date.now() },
      this.staleSeconds_
    )

    const selected = selectRate(rates, methodId, currency)
    return selected.ok ? "live" : selected.reason
  }

  async canCalculate(data: CreateShippingOptionDTO): Promise<boolean> {
    const optionId = (data as { data?: { id?: unknown } })?.data?.id
    // Printful quotes outbound shipping only — a return has no live rate, so
    // it must be priced flat by the admin rather than resolving to zero.
    if (optionId === PRINTFUL_RETURN_OPTION_ID) {
      return false
    }
    return Boolean(this.options_.liveShippingRates)
  }

  /**
   * Price one shipping option.
   *
   * This method must never throw and must always return a `calculated_amount`.
   * Medusa blocks checkout when it does not, so every failure — Printful down,
   * method missing, currency unusable, config incomplete — resolves to a
   * fallback rather than an exception.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceContext
  ): Promise<CalculatedShippingOptionPrice> {
    const methodId = String(
      (optionData as { id?: unknown } | undefined)?.id ?? ""
    )

    try {
      return await this.quote(methodId, context)
    } catch (err) {
      // A bug in our own code must not block a cart either.
      this.logger_.error(
        `Printful rate calculation failed unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return this.fallback(methodId, "printful_unreachable")
    }
  }

  private async quote(
    methodId: string,
    context: CalculateShippingOptionPriceContext
  ): Promise<CalculatedShippingOptionPrice> {
    const ctx = context as unknown as RateContext

    const plan = await this.planRateRequest(ctx)

    if (!plan.ok) {
      return this.fallback(methodId, plan.reason)
    }

    const { recipient, items, currency, cacheKey } = plan

    const cached = await this.readCache(cacheKey)
    // A negative age means the entry is dated in the future — clock skew on the
    // cache node — which would otherwise read as fresh until that date passes.
    const age = cached ? Date.now() - cached.cached_at : 0
    if (cached && age >= 0 && age < this.freshnessMs_) {
      const hit = selectRate(cached.rates, methodId, currency)
      if (hit.ok) {
        return this.priced(hit.amount, methodId, "fresh_cache")
      }
    }

    let rates: ShippingInfo[]
    try {
      rates = await this.client_.getShippingRates({
        recipient,
        items,
        ...(currency ? { currency } : {}),
      })
    } catch (err) {
      this.logger_.warn(
        `Printful shipping rates unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return this.staleOrFlat(
        cached,
        methodId,
        currency,
        "printful_unreachable"
      )
    }

    await this.writeCache(
      cacheKey,
      { rates, currency, cached_at: Date.now() },
      this.staleSeconds_
    )

    const selected = selectRate(rates, methodId, currency)
    if (!selected.ok) {
      this.logger_.warn(
        `Printful rate for ${methodId} unusable (${selected.reason}); falling back`
      )
      return this.staleOrFlat(cached, methodId, currency, selected.reason)
    }

    return this.priced(selected.amount, methodId, "live")
  }

  /**
   * Build the Printful rate request and cache key for a cart context.
   *
   * The single seam `calculatePrice` and the confirm path both go through, so
   * the two can never compute different cache keys for the same cart. It owns
   * the parts that need the container — the `query` guard and the catalog-id
   * lookup — and delegates the rest to the pure `buildRateRequest`.
   */
  private async planRateRequest(
    ctx: RateContext
  ): Promise<RateRequestPlan | { ok: false; reason: "query_unavailable" }> {
    if (!this.query_) {
      return { ok: false, reason: "query_unavailable" }
    }

    const addr = ctx.shipping_address ?? {}
    const countryCode = (addr.country_code ?? "").toUpperCase()
    const stateCode = resolveStateCode(addr.province, countryCode)

    // The address guard runs before the query, so an unquotable address never
    // costs a database round trip on every storefront cart refresh.
    if (
      !isAddressQuotable({ country_code: countryCode, state_code: stateCode })
    ) {
      return { ok: false, reason: "incomplete_address" }
    }

    const lines = rateLinesFrom(ctx)

    let catalogIds: Map<string, string>
    try {
      catalogIds = await this.catalogIdsFor(lines.map((l) => l.variant_id))
    } catch (err) {
      // Our own database, not Printful. Misreporting this sends the operator
      // to Printful's status page during their own incident.
      this.logger_.error(
        `Printful rate lookup: variant query failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return { ok: false, reason: "query_unavailable" }
    }

    return buildRateRequest(ctx, lines, catalogIds, stateCode)
  }

  /** Look up Printful catalog variant ids for a set of Medusa variant ids. */
  private async catalogIdsFor(
    variantIds: string[]
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (!this.query_ || !variantIds.length) {
      return map
    }

    const { data } = await this.query_.graph({
      entity: "product_variant",
      fields: ["id", "metadata"],
      filters: { id: variantIds },
    })

    // `graph` is expected to return an array; a non-array result (schema drift,
    // an error envelope) would otherwise throw on iteration.
    const rows = Array.isArray(data)
      ? (data as Array<{
          id: string
          metadata?: Record<string, unknown> | null
        }>)
      : []

    for (const row of rows) {
      const catalogId = row.metadata?.printful_catalog_variant_id
      if (catalogId != null && catalogId !== "") {
        map.set(row.id, String(catalogId))
      }
    }

    return map
  }

  private async readCache(key: string): Promise<CachedQuote | null> {
    if (!this.cache_) {
      return null
    }
    try {
      const value = await this.cache_.get<CachedQuote>(key)
      // Treat a malformed entry as a miss. Schema drift from an older version
      // or a partial write would otherwise throw inside the fresh-path check,
      // blocking the live API for the whole stale window while Printful is up.
      if (
        !value ||
        !Array.isArray(value.rates) ||
        typeof value.cached_at !== "number" ||
        !Number.isFinite(value.cached_at)
      ) {
        return null
      }
      return value
    } catch {
      // A cache failure must not fail the quote.
      return null
    }
  }

  private async writeCache(
    key: string,
    value: CachedQuote,
    ttlSeconds: number
  ): Promise<void> {
    if (!this.cache_) {
      return
    }
    try {
      // TTL is the STALE window, not the freshness window: an aged entry must
      // survive so it can serve as a fallback.
      await this.cache_.set(key, value, ttlSeconds)
    } catch {
      // Non-fatal.
    }
  }

  private staleOrFlat(
    cached: CachedQuote | null,
    methodId: string,
    currency: string,
    reason: FallbackReason
  ): CalculatedShippingOptionPrice {
    if (cached) {
      const stale = selectRate(cached.rates, methodId, currency)
      if (stale.ok) {
        return this.priced(stale.amount, methodId, "stale_cache")
      }
    }
    return this.fallback(methodId, reason)
  }

  private fallback(
    methodId: string,
    reason: FallbackReason
  ): CalculatedShippingOptionPrice {
    // Read as an own property: a method id like "toString" would otherwise
    // resolve up the prototype chain to a function, which JSON.stringify drops
    // from the response entirely — the exact missing-field condition that
    // blocks checkout. Type-check it too, since a rate from JSON or an env var
    // arrives as a string.
    const table = this.options_.fallbackShippingRates
    const configured = Object.prototype.hasOwnProperty.call(
      table ?? {},
      methodId
    )
      ? (table as unknown as Record<string, unknown>)[methodId]
      : undefined
    const flat =
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured >= 0
        ? configured
        : undefined

    if (flat == null) {
      // calculatePrice cannot throw, so a legacy option row silently prices at
      // zero. Naming the id is the only mitigation available.
      if (LEGACY_OPTION_IDS.has(methodId)) {
        this.logger_.error(
          `Shipping option uses the pre-0.3.0 id "${methodId}", which Printful ` +
            `never returns, so it is pricing at zero. Recreate this option ` +
            `against one of: ${PRINTFUL_SHIPPING_METHODS.join(", ")}.`
        )
      } else {
        this.logger_.error(
          `No usable fallbackShippingRates entry for "${methodId}" — pricing ` +
            "shipping at zero. Every method in the allowlist needs a " +
            "non-negative numeric entry."
        )
      }
      return this.priced(0, methodId, "misconfigured_zero")
    }

    if (reason === "incomplete_address" || reason === "no_printful_items") {
      this.logger_.debug?.(`Printful rates skipped: ${reason}`)
    } else if (reason === "query_unavailable") {
      // Only advise the config change when query really is absent; a query that
      // exists but failed has already logged its own, accurate reason.
      if (!this.query_) {
        this.logger_.error(
          'Printful live rates need dependencies: ["query"] on the fulfillment module'
        )
      }
    } else {
      this.logger_.warn(`Printful rate fallback (${reason}) for ${methodId}`)
    }

    return this.priced(flat, methodId, "flat_fallback")
  }

  private priced(
    amount: number,
    _methodId: string,
    _source: RateSource
  ): CalculatedShippingOptionPrice {
    // The source is deliberately not returned. Medusa reads only
    // calculated_amount and is_calculated_price_tax_inclusive off this result
    // (core-flows add-shipping-method-to-cart.js) — a `data` field here is
    // discarded, so stamping provenance on it would be silently dead code.
    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: false,
    }
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    // Prefer order created by payment.captured subscriber; attach id if present.
    const existingId =
      (data?.printful_order_id as string | undefined) ||
      (fulfillment?.metadata?.printful_order_id as string | undefined)

    if (existingId) {
      return {
        data: {
          ...(typeof data === "object" ? data : {}),
          printful_order_id: existingId,
        },
        labels: [],
      }
    }

    // Best-effort: if order has external printful mapping via metadata, reuse.
    // Full auto-create is handled by create-printful-order workflow (subscriber).
    this.logger_.info(
      `Printful fulfillment created for order ${order?.id ?? "unknown"} ` +
        `(items: ${items?.length ?? 0}). Expect Printful order from payment.captured subscriber.`
    )

    return {
      data: {
        ...(typeof data === "object" ? data : {}),
        medusa_order_id: order?.id,
      },
      labels: [],
    }
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<unknown> {
    const printfulOrderId = data?.printful_order_id as string | undefined
    if (!printfulOrderId) {
      return {}
    }

    try {
      await this.client_.cancelOrder(printfulOrderId)
    } catch (err) {
      this.logger_.error(
        `Failed to cancel Printful order ${printfulOrderId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    return {}
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...(fulfillment?.data as object),
        is_return: true,
      },
      labels: [],
    }
  }
}

export default PrintfulFulfillmentProviderService
