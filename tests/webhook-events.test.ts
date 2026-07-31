import { describe, expect, it } from "vitest"
import {
  deriveEventId,
  PRINTFUL_WEBHOOK_TYPES,
  verifyWebhookToken,
} from "../src/utils/webhook-events"

describe("verifyWebhookToken", () => {
  it("accepts a matching token", () => {
    expect(verifyWebhookToken("s3cret", "s3cret")).toBe(true)
  })

  it("rejects a wrong token of the same length", () => {
    expect(verifyWebhookToken("s3cret", "s3crXt")).toBe(false)
  })

  it("rejects tokens of differing length without throwing", () => {
    expect(verifyWebhookToken("s3cret", "s3")).toBe(false)
    expect(verifyWebhookToken("s3cret", "s3cret-and-more")).toBe(false)
  })

  it("rejects when the configured secret is missing", () => {
    expect(verifyWebhookToken(undefined, "anything")).toBe(false)
    expect(verifyWebhookToken("", "anything")).toBe(false)
  })

  it("rejects when the provided token is missing", () => {
    expect(verifyWebhookToken("s3cret", undefined)).toBe(false)
    expect(verifyWebhookToken("s3cret", "")).toBe(false)
  })

  it("rejects non-string input instead of throwing", () => {
    expect(verifyWebhookToken("s3cret", ["s3cret"] as unknown as string)).toBe(false)
    expect(verifyWebhookToken("s3cret", 123 as unknown as string)).toBe(false)
    expect(verifyWebhookToken("s3cret", {} as unknown as string)).toBe(false)
    expect(verifyWebhookToken(42 as unknown as string, "s3cret")).toBe(false)
  })
})

describe("deriveEventId", () => {
  const shipped = {
    type: "package_shipped",
    created: 1735689600,
    data: {
      order: { id: 777 },
      shipment: { id: 5001, tracking_number: "1Z999" },
    },
  }

  it("is stable for an identical payload", () => {
    expect(deriveEventId(shipped)).toBe(deriveEventId({ ...shipped }))
  })

  it("distinguishes two shipments of the same order", () => {
    const second = {
      ...shipped,
      data: { ...shipped.data, shipment: { id: 5002, tracking_number: "1Z888" } },
    }
    expect(deriveEventId(shipped)).not.toBe(deriveEventId(second))
  })

  it("distinguishes two order_updated events by updated timestamp", () => {
    const a = { type: "order_updated", created: 1, data: { order: { id: 9, updated: 100 } } }
    const b = { type: "order_updated", created: 1, data: { order: { id: 9, updated: 200 } } }
    expect(deriveEventId(a)).not.toBe(deriveEventId(b))
  })

  it("treats order_failed as one event per order", () => {
    const a = { type: "order_failed", created: 10, data: { order: { id: 9 } } }
    const b = { type: "order_failed", created: 10, data: { order: { id: 9 } } }
    expect(deriveEventId(a)).toBe(deriveEventId(b))
  })

  it("falls back to a payload fingerprint for unknown types", () => {
    const a = { type: "some_future_event", data: { order: { id: 3 }, extra: "a" } }
    const b = { type: "some_future_event", data: { order: { id: 3 }, extra: "b" } }
    expect(deriveEventId(a)).not.toBe(deriveEventId(b))
  })

  it("is insensitive to key order in the payload", () => {
    const a = { type: "x", data: { order: { id: 1 }, p: 1, q: 2 } }
    const b = { type: "x", data: { q: 2, order: { id: 1 }, p: 1 } }
    expect(deriveEventId(a)).toBe(deriveEventId(b))
  })

  it("exposes the subscribed type allowlist", () => {
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("package_shipped")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("order_failed")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("order_canceled")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("package_returned")
  })
})
