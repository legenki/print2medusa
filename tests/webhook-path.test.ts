import { describe, expect, it } from "vitest"
import {
  redactWebhookPath,
  WEBHOOK_BODY_SIZE_LIMIT,
} from "../src/utils/webhook-path"

describe("redactWebhookPath", () => {
  it("replaces the token segment with a placeholder", () => {
    expect(redactWebhookPath("/hooks/printful/s3cret")).toBe(
      "/hooks/printful/[redacted]"
    )
  })

  it("redacts regardless of how secret-like the token looks", () => {
    expect(
      redactWebhookPath("/hooks/printful/aGVsbG8td29ybGQtMTIzNDU2Nzg5MA")
    ).toBe("/hooks/printful/[redacted]")
  })

  it("redacts the token but keeps any trailing path", () => {
    expect(redactWebhookPath("/hooks/printful/s3cret/extra")).toBe(
      "/hooks/printful/[redacted]/extra"
    )
  })

  it("tolerates a trailing slash without treating it as a token", () => {
    expect(redactWebhookPath("/hooks/printful/")).toBe("/hooks/printful/")
  })

  // The middleware redacts req.originalUrl, which retains the query string.
  it("redacts the token when a query string follows it", () => {
    expect(redactWebhookPath("/hooks/printful/s3cret?retry=1")).toBe(
      "/hooks/printful/[redacted]?retry=1"
    )
  })

  it("does not let a query string smuggle the token through", () => {
    expect(redactWebhookPath("/hooks/printful/s3cret?x=1")).not.toContain(
      "s3cret"
    )
  })

  it("leaves the bare prefix untouched", () => {
    expect(redactWebhookPath("/hooks/printful")).toBe("/hooks/printful")
  })

  it("leaves unrelated paths untouched", () => {
    expect(redactWebhookPath("/admin/printful/status")).toBe(
      "/admin/printful/status"
    )
    expect(redactWebhookPath("/store/products")).toBe("/store/products")
  })

  it("does not redact a lookalike path that is not our webhook", () => {
    expect(redactWebhookPath("/other/hooks/printful/s3cret")).toBe(
      "/other/hooks/printful/s3cret"
    )
  })

  it("never returns the original token for any segment value", () => {
    // Tokens distinctive enough not to occur inside "[redacted]" itself.
    for (const token of [
      "Z",
      "A".repeat(200),
      "tok-en_123.456",
      "%20weird",
      "s3cret",
    ]) {
      expect(redactWebhookPath(`/hooks/printful/${token}`)).not.toContain(token)
    }
  })

  it("is idempotent, so re-running it cannot expose anything", () => {
    const once = redactWebhookPath("/hooks/printful/s3cret")
    expect(redactWebhookPath(once)).toBe(once)
  })

  it("returns a safe constant for non-string input instead of throwing", () => {
    expect(redactWebhookPath(undefined as unknown as string)).toBe("")
    expect(redactWebhookPath(null as unknown as string)).toBe("")
  })
})

/** Mirrors how body-parser's `bytes` parses the limit string. */
function limitInBytes(limit: string): number {
  const [, size, unit] = /^(\d+)(kb|mb)$/i.exec(limit)!
  return Number(size) * (unit.toLowerCase() === "mb" ? 1024 * 1024 : 1024)
}

describe("WEBHOOK_BODY_SIZE_LIMIT", () => {
  it("is expressed in a unit body-parser understands", () => {
    expect(WEBHOOK_BODY_SIZE_LIMIT).toMatch(/^\d+(kb|mb)$/i)
  })

  it("raises the limit above Express's 100KB default", () => {
    expect(limitInBytes(WEBHOOK_BODY_SIZE_LIMIT)).toBeGreaterThan(100 * 1024)
  })

  /**
   * Sizing evidence (see README): a `package_shipped` body for a 50-line-item
   * order, with 6 print files per item and realistic CDN URLs, measures ~262KB
   * from the published OpenAPI shapes. Express's 100KB default is exceeded by
   * roughly a 25-item order, so the default is genuinely too small for real
   * traffic — not merely a theoretical concern.
   */
  it("clears the measured worst case with headroom", () => {
    const measuredWorstCase = 262 * 1024
    expect(limitInBytes(WEBHOOK_BODY_SIZE_LIMIT)).toBeGreaterThan(
      measuredWorstCase
    )
  })

  it("stays bounded, so the endpoint is not an unbounded memory sink", () => {
    expect(limitInBytes(WEBHOOK_BODY_SIZE_LIMIT)).toBeLessThanOrEqual(
      2 * 1024 * 1024
    )
  })
})
