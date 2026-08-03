import { describe, expect, it, vi } from "vitest"
import PrintfulFulfillmentProviderService from "../src/providers/printful-fulfillment/service"
import type { ShippingInfo } from "../src/utils/types"
import { PRINTFUL_RETURN_OPTION_ID } from "../src/utils/shipping-rates"

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
    // `ttl` is declared even though the stub ignores it: the TTL a caller
    // passes is behaviour worth asserting, and an untyped 2-arg mock makes
    // `set.mock.calls[0][2]` a type error.
    set: vi.fn(async (k: string, v: unknown, _ttl?: number) => {
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

  it("does not treat inherited object keys as configured rates", async () => {
    const logger = makeLogger()
    const service = new PrintfulFulfillmentProviderService(
      { logger } as never,
      {
        apiToken: "token",
        liveShippingRates: true,
        fallbackShippingRates: { STANDARD: 700 },
      } as never
    )

    for (const inherited of ["toString", "constructor", "valueOf"]) {
      const result = await service.calculatePrice(
        { id: inherited } as never,
        {} as never,
        CONTEXT
      )
      expect(typeof result.calculated_amount).toBe("number")
      expect(result.calculated_amount).toBe(0)
    }
  })

  it("rejects a non-numeric configured rate", async () => {
    const logger = makeLogger()
    const service = new PrintfulFulfillmentProviderService(
      { logger } as never,
      {
        apiToken: "token",
        liveShippingRates: true,
        // A rate that came from JSON or an env var arrives as a string.
        fallbackShippingRates: { STANDARD: "700" },
      } as never
    )

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    expect(result.calculated_amount).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it("treats a corrupt cache entry as a miss and still calls Printful", async () => {
    const cache = makeCache()
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      getShippingRates,
      query: makeQuery(),
      cache,
    })

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    for (const [k, v] of cache._store) {
      cache._store.set(k, { ...(v as object), rates: "corrupt" })
    }
    getShippingRates.mockClear()

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // Printful is healthy — a bad cache entry must not stop us asking it.
    expect(getShippingRates).toHaveBeenCalledTimes(1)
    expect(result.calculated_amount).toBe(499)
  })

  it("does not serve a future-dated cache entry as fresh", async () => {
    const cache = makeCache()
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      getShippingRates,
      query: makeQuery(),
      cache,
    })

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    // Clock skew on the cache node dates the entry ahead of us.
    for (const [k, v] of cache._store) {
      cache._store.set(k, {
        ...(v as object),
        cached_at: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      })
    }
    getShippingRates.mockClear()

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(getShippingRates).toHaveBeenCalledTimes(1)
  })

  it("reports a variant-query failure as query_unavailable, not Printful", async () => {
    const getShippingRates = vi.fn().mockResolvedValue(RATES)
    const { service, logger } = makeProvider({
      getShippingRates,
      query: { graph: vi.fn().mockRejectedValue(new Error("PG down")) },
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(700)
    expect(getShippingRates).not.toHaveBeenCalled()
    // Our database, not Printful — the log must not send the operator to
    // Printful's status page during their own incident.
    const logged = logger.error.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("variant query failed")
  })

  it("survives a non-array graph result", async () => {
    const { service, logger } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: { graph: vi.fn().mockResolvedValue({ data: { rows: [] } }) },
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // No Printful items resolve, so this is the flat rate. Assert the *route*,
    // not just the amount: without the Array.isArray guard the object is not
    // iterable, and the amount is still 700 — but it arrives via a thrown
    // TypeError rather than a clean no_printful_items skip. Requiring a silent
    // error log is what distinguishes the two paths.
    expect(result.calculated_amount).toBe(700)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("caches with the stale window, not the freshness window", async () => {
    const cache = makeCache()
    const { service } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache,
    })

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // The entry must outlive its freshness window, or the stale tier cannot
    // exist — this is the trap the design doc calls out explicitly.
    expect(cache.set.mock.calls[0][2]).toBe(86400)
  })

  it("raises a stale window configured below the freshness window", async () => {
    const logger = makeLogger()
    const cache = makeCache()
    const service = new PrintfulFulfillmentProviderService(
      { logger, query: makeQuery() as never, caching: cache as never } as never,
      {
        apiToken: "token",
        liveShippingRates: true,
        fallbackShippingRates: { STANDARD: 700 },
        shippingRateCacheTtlSeconds: 900,
        shippingRateStaleSeconds: 300,
      } as never
    )
    ;(service as never as { client_: unknown }).client_ = {
      getShippingRates: vi.fn().mockResolvedValue(RATES),
    }

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // Retention cannot be shorter than freshness, or an entry expires while
    // still considered fresh and the stale tier never gets a chance.
    expect(cache.set.mock.calls[0][2]).toBe(900)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("names the legacy id when a pre-0.3.0 option prices at zero", async () => {
    // getFulfillmentOptions no longer lists these, but an option row created
    // before the upgrade still resolves at checkout — silently, at zero.
    const { service, logger } = makeProvider({
      getShippingRates: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "printful-standard" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(0)
    const logged = logger.error.mock.calls.map((c) => String(c[0])).join("\n")
    expect(logged).toContain("pre-0.3.0")
    expect(logged).toContain("printful-standard")
    expect(logged).toContain("STANDARD")
  })
})

describe("canCalculate", () => {
  it("refuses live rates for the return option", async () => {
    const { service } = makeProvider({})

    // Printful quotes outbound shipping only; a live-rated return resolves to
    // zero, so it must be priced flat by the admin instead.
    await expect(
      service.canCalculate({ data: { id: "PRINTFUL_RETURN" } } as never)
    ).resolves.toBe(false)
  })

  it("allows live rates for an outbound method", async () => {
    const { service } = makeProvider({})

    await expect(
      service.canCalculate({ data: { id: "STANDARD" } } as never)
    ).resolves.toBe(true)
  })
})

describe("validateFulfillmentData", () => {
  it("accepts a recognized method id", async () => {
    const { service } = makeProvider({})

    await expect(
      service.validateFulfillmentData({ id: "STANDARD" }, { foo: 1 }, {})
    ).resolves.toEqual({ foo: 1, printful_option_id: "STANDARD" })
  })

  it("rejects an unrecognized method id rather than inventing a default", async () => {
    const { service } = makeProvider({})

    // Silently defaulting records STANDARD on the order while the customer was
    // priced for whatever they actually selected.
    for (const bad of [undefined, null, "", "printful-standard", 42]) {
      await expect(
        service.validateFulfillmentData({ id: bad } as never, {}, {})
      ).rejects.toThrow(/unrecognized method id/)
    }
  })

  it("accepts the return option, which validateOption already allows", async () => {
    // The return option is a first-class option here: `getFulfillmentOptions`
    // lists it and `validateOption` accepts it, and `canCalculate` returns
    // false for it precisely so the admin prices it flat. Rejecting it at this
    // step made an option the merchant could create but never use — the method
    // could not be added to a cart at all.
    const { service } = makeProvider({})

    await expect(
      service.validateFulfillmentData(
        { id: PRINTFUL_RETURN_OPTION_ID },
        { foo: 1 },
        {}
      )
    ).resolves.toEqual({
      foo: 1,
      printful_option_id: PRINTFUL_RETURN_OPTION_ID,
    })
  })

  it("names the return option in the error listing valid ids", async () => {
    // The message tells a merchant how to fix a broken option, so omitting the
    // return id would send them to recreate it against an outbound method.
    const { service } = makeProvider({})

    await expect(
      service.validateFulfillmentData({ id: "nonsense" }, {}, {})
    ).rejects.toThrow(/PRINTFUL_RETURN/)
  })
})
