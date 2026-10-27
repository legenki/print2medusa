import { describe, expect, it, vi } from "vitest"
import { POST } from "../src/api/admin/printful/webhook/route"
import { webhookUrlFor } from "../src/utils/webhook-path"

function call(secret: string) {
  const setWebhookConfig = vi.fn(async (url: string) => ({ url, types: [] }))
  const req = {
    body: { base_url: "https://shop.example/" },
    scope: {
      resolve: () => ({
        getClient: async () => ({ setWebhookConfig }),
        getOptions: async () => ({ webhookSecret: secret }),
      }),
    },
  }
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  return { req, res, setWebhookConfig }
}

describe("POST /admin/printful/webhook", () => {
  it("registers a URL whose path segment decodes back to the secret", async () => {
    // `openssl rand -base64` output contains "/" and "+". Unencoded, the
    // secret split the path and no delivery ever matched the route.
    const secret = "ab/cd+ef==" + "x".repeat(32)
    const { req, res, setWebhookConfig } = call(secret)

    await POST(req as never, res as never)

    const url = new URL(setWebhookConfig.mock.calls[0][0])
    const segments = url.pathname.split("/")
    expect(segments.slice(0, 3)).toEqual(["", "hooks", "printful"])
    expect(segments).toHaveLength(4)
    expect(decodeURIComponent(segments[3])).toBe(secret)
  })
})

describe("webhookUrlFor", () => {
  const SECRET = "s".repeat(32)

  it("keeps a path prefix and puts the secret last", () => {
    expect(webhookUrlFor("https://shop.example/medusa/", SECRET)).toEqual({
      ok: true,
      url: `https://shop.example/medusa/hooks/printful/${SECRET}`,
    })
  })

  it("refuses plain http, except on loopback", () => {
    // Over http the secret crosses the network with every delivery.
    expect(webhookUrlFor("http://shop.example", SECRET).ok).toBe(false)
    expect(webhookUrlFor("http://localhost:9000", SECRET)).toEqual({
      ok: true,
      url: `http://localhost:9000/hooks/printful/${SECRET}`,
    })
  })

  it("refuses a query string or fragment", () => {
    // Either moves the secret out of the last path segment — the only part
    // GET /admin/printful/webhook masks.
    expect(webhookUrlFor("https://shop.example/?a=", SECRET).ok).toBe(false)
    expect(webhookUrlFor("https://shop.example/#x", SECRET).ok).toBe(false)
  })

  it("refuses credentials, other schemes and garbage", () => {
    for (const bad of [
      "https://user:pass@shop.example",
      "ftp://shop.example",
      "javascript:alert(1)",
      "shop.example",
      "",
      undefined,
      42,
    ]) {
      expect(webhookUrlFor(bad, SECRET).ok).toBe(false)
    }
  })
})

describe("POST /admin/printful/webhook validation", () => {
  it("answers 400 and registers nothing for an http base_url", async () => {
    const { req, res, setWebhookConfig } = call("x".repeat(32))
    req.body.base_url = "http://shop.example"

    await POST(req as never, res as never)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(setWebhookConfig).not.toHaveBeenCalled()
  })
})
