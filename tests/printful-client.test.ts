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
})
