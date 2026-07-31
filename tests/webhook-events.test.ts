import { describe, expect, it } from "vitest"
import {
  deriveEventId,
  extractShipmentId,
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

  it("is stable across redelivery when retries increments", () => {
    const first = {
      type: "some_future_event",
      created: 500,
      retries: 0,
      data: { order: { id: 12 } },
    }
    const redelivered = { ...first, retries: 3 }
    expect(deriveEventId(first)).toBe(deriveEventId(redelivered))
  })

  it("is stable across redelivery for package_returned without a shipment id", () => {
    const first = {
      type: "package_returned",
      created: 600,
      retries: 0,
      data: { order: { id: 13 } },
    }
    const redelivered = { ...first, retries: 5 }
    expect(deriveEventId(first)).toBe(deriveEventId(redelivered))
  })

  it("is stable across redelivery for order_updated without an updated field", () => {
    const first = {
      type: "order_updated",
      created: 700,
      retries: 0,
      data: { order: { id: 14 } },
    }
    const redelivered = { ...first, retries: 2 }
    expect(deriveEventId(first)).toBe(deriveEventId(redelivered))
  })

  it("distinguishes two package_returned events by shipment id", () => {
    const a = { type: "package_returned", created: 1, data: { order: { id: 15 }, shipment: { id: 71 } } }
    const b = { type: "package_returned", created: 1, data: { order: { id: 15 }, shipment: { id: 72 } } }
    expect(deriveEventId(a)).not.toBe(deriveEventId(b))
  })

  it("treats an empty shipment id as absent", () => {
    const withEmpty = { type: "package_shipped", created: 2, data: { order: { id: 16 }, shipment: { id: "" } } }
    expect(extractShipmentId(withEmpty)).toBeNull()
  })

  it("excludes order_updated from the registered allowlist", () => {
    expect(PRINTFUL_WEBHOOK_TYPES).not.toContain("order_updated")
    expect(PRINTFUL_WEBHOOK_TYPES).toHaveLength(4)
  })
})
