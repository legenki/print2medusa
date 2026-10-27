import { describe, expect, it } from "vitest"
import {
  printfulOrderIdFrom,
  safeTrackingUrl,
  withoutPrintfulKeys,
} from "../src/utils/order-metadata"
import { isFullyCaptured } from "../src/utils/payment-status"

describe("withoutPrintfulKeys", () => {
  it("drops every plugin-owned key a cart could have planted", () => {
    // Medusa copies cart.metadata onto the order at checkout.
    expect(
      withoutPrintfulKeys({
        gift_note: "hi",
        printful_order_id: "1",
        printful_status: "fulfilled",
        printful_shipments: [{ tracking_url: "javascript:alert(1)" }],
      })
    ).toEqual({ gift_note: "hi" })
  })

  it("accepts missing metadata", () => {
    expect(withoutPrintfulKeys(null)).toEqual({})
  })
})

describe("printfulOrderIdFrom", () => {
  it("accepts a positive integer id, as string or number", () => {
    expect(printfulOrderIdFrom({ printful_order_id: "12345" })).toBe("12345")
    expect(printfulOrderIdFrom({ printful_order_id: 12345 })).toBe("12345")
  })

  it("rejects the claim sentinel and anything path-like", () => {
    for (const bad of ["pending", "../webhooks", "0", "-1", "1e3", "", null]) {
      expect(printfulOrderIdFrom({ printful_order_id: bad })).toBeNull()
    }
    expect(printfulOrderIdFrom(null)).toBeNull()
  })
})

describe("safeTrackingUrl", () => {
  it("keeps http and https links", () => {
    expect(safeTrackingUrl("https://track.example/1")).toBe(
      "https://track.example/1"
    )
    expect(safeTrackingUrl("http://track.example/1")).toBe(
      "http://track.example/1"
    )
  })

  it("refuses script and data URLs, and anything unparseable", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "/relative",
      "",
      42,
      null,
    ]) {
      expect(safeTrackingUrl(bad)).toBeNull()
    }
  })
})

describe("isFullyCaptured", () => {
  it("is true only when every live collection is captured in full", () => {
    expect(
      isFullyCaptured([
        { status: "completed", amount: 50, captured_amount: 50 },
      ])
    ).toBe(true)
    expect(
      isFullyCaptured([
        { status: "authorized", amount: 50, captured_amount: 0 },
      ])
    ).toBe(false)
    expect(
      isFullyCaptured([
        { status: "completed", amount: 50, captured_amount: 50 },
        { status: "authorized", amount: 10, captured_amount: 5 },
      ])
    ).toBe(false)
  })

  it("ignores canceled collections, and needs at least one live one", () => {
    expect(
      isFullyCaptured([
        { status: "canceled", amount: 50, captured_amount: 0 },
        { status: "completed", amount: 50, captured_amount: 50 },
      ])
    ).toBe(true)
    expect(isFullyCaptured([{ status: "canceled", amount: 5 }])).toBe(false)
    expect(isFullyCaptured([])).toBe(false)
    expect(isFullyCaptured(undefined)).toBe(false)
  })
})
