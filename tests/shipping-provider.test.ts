import { describe, expect, it, vi } from "vitest"
import PrintfulFulfillmentProviderService from "../src/providers/printful-fulfillment/service"
import type { ShippingInfo } from "../src/utils/types"

const RATES: ShippingInfo[] = [
  { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
]

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}

/** Query stub reporting every variant as Printful catalog variant 4012. */
function makeQuery() {
  return {
    graph: vi.fn().mockResolvedValue({
      data: [
        { id: "var_1", metadata: { printful_catalog_variant_id: "4012" } },
      ],
    }),
  }
}

function makeCache() {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (k: string) => (store.get(k) ?? null) as never),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v)
    }),
    _store: store,
  }
}

const CONTEXT = {
  id: "cart_1",
  currency_code: "usd",
  shipping_address: {
    country_code: "US",
    province: "California",
    city: "Chatsworth",
    postal_code: "91311",
    address_1: "19749 Dearborn St",
  },
  items: [{ variant: { id: "var_1" }, quantity: 1, unit_price: 2500 }],
} as never

function makeProvider(opts: {
  getShippingRates?: unknown
  query?: unknown
  cache?: unknown
  fallback?: Record<string, number>
}) {
  const logger = makeLogger()
  const service = new PrintfulFulfillmentProviderService(
    {
      logger,
      query: opts.query as never,
      caching: opts.cache as never,
    } as never,
    {
      apiToken: "token",
      liveShippingRates: true,
      fallbackShippingRates: opts.fallback ?? { STANDARD: 700 },
    } as never
  )
  if (opts.getShippingRates) {
    // Swap the whole client for a stub exposing only getShippingRates — the
    // only method calculatePrice uses. No real HTTP happens in these tests.
    ;(service as never as { client_: unknown }).client_ = {
      getShippingRates: opts.getShippingRates,
    }
  }
  return { service, logger }
}

describe("calculatePrice", () => {
  it("returns the live rate when Printful answers", async () => {
    const { service } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(499)
    expect(result.is_calculated_price_tax_inclusive).toBe(false)
  })

  it("falls back to the flat rate when Printful is unreachable", async () => {
    const { service, logger } = makeProvider({
      getShippingRates: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(700)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("falls back when the requested method is not offered", async () => {
    const { service } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
      fallback: { EXPRESS: 1500 },
    })

    const result = await service.calculatePrice(
      { id: "EXPRESS" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(1500)
  })

  it("never calls Printful when the address is incomplete", async () => {
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      getShippingRates,
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      { ...(CONTEXT as object), shipping_address: {} } as never
    )

    expect(getShippingRates).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
  })

  it("never calls Printful when no line resolves to a Printful variant", async () => {
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      getShippingRates,
      query: {
        graph: vi.fn().mockResolvedValue({
          data: [{ id: "var_1", metadata: {} }],
        }),
      },
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(getShippingRates).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
  })

  it("falls back when query is unavailable", async () => {
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service, logger } = makeProvider({
      getShippingRates,
      query: undefined,
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(getShippingRates).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
    expect(logger.error).toHaveBeenCalled()
  })

  it("returns zero and logs an error when no fallback is configured", async () => {
    const logger = makeLogger()
    const service = new PrintfulFulfillmentProviderService(
      { logger } as never,
      { apiToken: "token", liveShippingRates: true } as never
    )

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it("serves a second option from cache without a second API call", async () => {
    const getShippingRates = vi
      .fn()
      .mockResolvedValue([
        ...RATES,
        { id: "EXPRESS", name: "Express", rate: "15.50", currency: "USD" },
      ])
    const { service } = makeProvider({
      getShippingRates,
      query: makeQuery(),
      cache: makeCache(),
    })

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    await service.calculatePrice(
      { id: "EXPRESS" } as never,
      {} as never,
      CONTEXT
    )

    expect(getShippingRates).toHaveBeenCalledTimes(1)
  })

  it("works without a cache module", async () => {
    const { service } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: undefined,
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(499)
  })

  it("prefers a stale quote over the flat rate", async () => {
    const cache = makeCache()
    const getShippingRates = vi
      .fn()
      .mockResolvedValueOnce(RATES)
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))

    const { service } = makeProvider({
      getShippingRates,
      query: makeQuery(),
      cache,
    })

    // Populate the cache, then age the entry past the freshness window.
    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    for (const [k, v] of cache._store) {
      cache._store.set(k, {
        ...(v as object),
        cached_at: Date.now() - 60 * 60 * 1000,
      })
    }

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // 499 from the stale quote, not 700 from the flat rate.
    expect(result.calculated_amount).toBe(499)
  })
})
