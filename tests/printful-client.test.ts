import { describe, expect, it, vi } from "vitest"
import { PrintfulApiError } from "../src/utils/errors"
import { PrintfulClient } from "../src/utils/printful-client"

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  })
}

describe("PrintfulClient", () => {
  it("lists sync products", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: [
          { id: 1, name: "Tee", external_id: null, variants: 2, synced: 2 },
        ],
        paging: { total: 1, offset: 0, limit: 100 },
      })
    )

    const client = new PrintfulClient({
      apiToken: "token",
      storeId: "123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const page = await client.listSyncProducts({ limit: 10 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].name).toBe("Tee")

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain("/store/products")
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token"
    )
    expect((init.headers as Record<string, string>)["X-PF-Store-Id"]).toBe(
      "123"
    )
  })

  it("paginates listAllSyncProducts across pages using paging.total", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          result: [
            { id: 1, name: "A", external_id: null, variants: 1, synced: 1 },
            { id: 2, name: "B", external_id: null, variants: 1, synced: 1 },
          ],
          paging: { total: 3, offset: 0, limit: 2 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          result: [
            { id: 3, name: "C", external_id: null, variants: 1, synced: 1 },
          ],
          paging: { total: 3, offset: 2, limit: 2 },
        })
      )

    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const all = await client.listAllSyncProducts({ limit: 2 })

    expect(all.map((p) => p.id)).toEqual([1, 2, 3])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[1][0])).toContain("offset=2")
  })

  it("creates order with confirm query", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: { id: 99, status: "draft" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const order = await client.createOrder({
      external_id: "ord_1",
      confirm: true,
      recipient: {
        name: "A",
        address1: "1 St",
        city: "NY",
        country_code: "US",
        zip: "10001",
      },
      items: [{ sync_variant_id: 11, quantity: 1 }],
    })

    expect(order.id).toBe(99)
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/orders?confirm=1")
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string)
    expect(body.confirm).toBeUndefined()
    expect(body.items[0].sync_variant_id).toBe(11)
  })

  it("retries on 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 429,
            result: "rate limited",
            error: { message: "slow down" },
          },
          429
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          result: {
            sync_product: {
              id: 5,
              external_id: null,
              name: "P",
              variants: 1,
              synced: 1,
            },
            sync_variants: [],
          },
        })
      )

    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      retryBaseMs: 1,
    })

    const detail = await client.getSyncProduct(5)
    expect(detail.sync_product.id).toBe(5)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("throws non-retryable 400 without endless retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 400,
          error: { message: "bad request", reason: "BadRequest" },
        },
        400
      )
    )

    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      retryBaseMs: 1,
    })

    await expect(client.getOrder(1)).rejects.toBeInstanceOf(PrintfulApiError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("reads the webhook config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: {
          url: "https://shop.test/hooks/printful/tok",
          types: ["package_shipped"],
        },
      })
    )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const config = await client.getWebhookConfig()

    expect(config.url).toBe("https://shop.test/hooks/printful/tok")
    expect(config.types).toEqual(["package_shipped"])
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/webhooks")
  })

  it("replaces the whole webhook config on set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: { url: "https://shop.test/h", types: ["order_failed"] },
      })
    )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.setWebhookConfig("https://shop.test/h", ["order_failed"])

    const [, init] = fetchImpl.mock.calls[0]
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.url).toBe("https://shop.test/h")
    expect(body.types).toEqual(["order_failed"])
  })

  it("disables the webhook config", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 200, result: { url: null, types: [] } })
      )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.disableWebhook()

    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE")
  })

  it("sends the store header on webhook config calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 200, result: { url: null, types: [] } })
      )
    const client = new PrintfulClient({
      apiToken: "token",
      storeId: "42",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.getWebhookConfig()

    const [, init] = fetchImpl.mock.calls[0]
    expect((init.headers as Record<string, string>)["X-PF-Store-Id"]).toBe("42")
  })

  it("returns an empty config when the store has no webhook set", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, result: null }))
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const config = await client.getWebhookConfig()

    expect(config).toEqual({ url: null, types: [] })
    expect(config.types).toHaveLength(0)
  })

  it("returns an empty config when disabling yields a null result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, result: null }))
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const config = await client.disableWebhook()

    expect(config).toEqual({ url: null, types: [] })
  })

  it("requests shipping rates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: [
          { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
        ],
      })
    )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const rates = await client.getShippingRates({
      recipient: { country_code: "US", state_code: "CA", zip: "91311" },
      items: [{ variant_id: 4012, quantity: 1 }],
      currency: "USD",
    })

    expect(rates).toHaveLength(1)
    expect(rates[0].id).toBe("STANDARD")

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain("/shipping/rates")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.recipient.country_code).toBe("US")
    expect(body.items[0].variant_id).toBe(4012)
    expect(body.currency).toBe("USD")
  })

  it("returns an empty list when the result is null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, result: null }))
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await expect(
      client.getShippingRates({
        recipient: { country_code: "DE" },
        items: [{ variant_id: 1, quantity: 1 }],
      })
    ).resolves.toEqual([])
  })

  it("sends the store header on rate requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, result: [] }))
    const client = new PrintfulClient({
      apiToken: "token",
      storeId: "42",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.getShippingRates({
      recipient: { country_code: "DE" },
      items: [{ variant_id: 1, quantity: 1 }],
    })

    const [, init] = fetchImpl.mock.calls[0]
    expect((init.headers as Record<string, string>)["X-PF-Store-Id"]).toBe("42")
  })
})

describe("request deadline", () => {
  it("passes an abort signal so a hung Printful cannot stall a request forever", async () => {
    // Since 0.7.0 a rate quote runs inside validateFulfillmentData, on the
    // customer's own "add shipping method" request. Undici's defaults only
    // bound headers and body at 300s each, and the retry loop multiplies that
    // by four attempts — so without a signal the customer waits, with nothing
    // in the plugin able to stop it. A failure is fine here; the soft-fail
    // path handles it. An unbounded wait is not.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
      timeoutMs: 5000,
    })

    await client.getShippingRates({
      recipient: { country_code: "US" },
      items: [{ variant_id: 1, quantity: 1 }],
    })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("gives every attempt its own signal, so a retry is not born aborted", async () => {
    // One signal shared across attempts would abort the retries too the moment
    // the first attempt's deadline passed, turning a transient 500 into a
    // permanent failure.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 200, result: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
      retryBaseMs: 1,
      timeoutMs: 5000,
    })

    await client.getShippingRates({
      recipient: { country_code: "US" },
      items: [{ variant_id: 1, quantity: 1 }],
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = (fetchImpl.mock.calls[0][1] as RequestInit).signal
    const second = (fetchImpl.mock.calls[1][1] as RequestInit).signal
    expect(first).not.toBe(second)
  })
})

describe("getStatistics", () => {
  it("sends the date range, report types and currency as query params", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          result: { store_statistics: [{ store_id: 1, currency: "USD" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.getStatistics({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      reportTypes: "profit,total_paid_orders",
      currency: "USD",
    })

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain("/reports/statistics")
    expect(url).toContain("date_from=2026-07-01")
    expect(url).toContain("date_to=2026-07-31")
    expect(url).toContain("report_types=profit%2Ctotal_paid_orders")
    expect(url).toContain("currency=USD")
  })

  it("omits currency when it was not asked for", async () => {
    // Printful reports in the store's own currency when none is given.
    // Sending an empty one would be a different request, not a default.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.getStatistics({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      reportTypes: "profit",
    })

    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("currency=")
  })

  it("returns an empty list rather than undefined when Printful reports none", async () => {
    // The admin page maps over this. A missing key must not become a crash on
    // a page whose whole job is telling the owner what is going on.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const stats = await client.getStatistics({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      reportTypes: "profit",
    })

    expect(stats).toEqual([])
  })
})

describe("getCatalogVariant", () => {
  const payload = {
    code: 200,
    result: {
      variant: {
        id: 4025,
        product_id: 71,
        color: "Aqua",
        color_code: "#008db5",
        size: "2XL",
        material: [{ name: "combed ring spun cotton", percentage: 100 }],
      },
      product: {
        id: 71,
        title: "Unisex Staple T-Shirt | Bella + Canvas 3001",
        brand: "Bella + Canvas",
        model: "3001",
        techniques: [{ key: "DTG", is_default: true }],
        files: [
          { id: "default", type: "front", title: "Front print" },
          { id: "back", type: "back", title: "Back print" },
        ],
      },
    },
  }

  it("reads a variant with its colour, material and techniques", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const got = await client.getCatalogVariant(4025)

    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      "/products/variant/4025"
    )
    expect(got?.variant.color_code).toBe("#008db5")
    expect(got?.product.techniques?.[0]?.key).toBe("DTG")
    expect(got?.variant.material?.[0]?.name).toBe("combed ring spun cotton")
  })

  it("returns null rather than throwing when the catalog cannot answer", async () => {
    // This runs inside the sync. A catalog hiccup must not fail an import that
    // is otherwise fine — design parameters are an enrichment, not a
    // precondition for selling the product.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"))

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await expect(client.getCatalogVariant(4025)).resolves.toBeNull()
  })

  it("returns null for a variant the catalog does not know", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 404, result: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    )

    const client = new PrintfulClient({
      apiToken: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await expect(client.getCatalogVariant(999999)).resolves.toBeNull()
  })
})
