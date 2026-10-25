import { describe, expect, it, vi } from "vitest"
import { POST } from "../src/api/admin/printful/webhook/route"

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
