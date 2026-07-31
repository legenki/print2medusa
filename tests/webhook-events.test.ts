import { describe, expect, it } from "vitest"
import { verifyWebhookToken } from "../src/utils/webhook-events"

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
