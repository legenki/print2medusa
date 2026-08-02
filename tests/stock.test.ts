import { describe, expect, it } from "vitest"
import {
  planStockActions,
  resolvePublication,
  STOCK_MARKER_KEY,
} from "../src/utils/stock"

const variant = (id: number, status?: string) => ({
  id,
  availability_status: status,
})

describe("planStockActions", () => {
  it("publishes when every variant is active", () => {
    const plan = planStockActions([variant(1, "active"), variant(2, "active")])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
    expect(plan.hasDiscontinued).toBe(false)
  })

  it("drafts when every variant is unavailable", () => {
    const plan = planStockActions([
      variant(1, "out_of_stock"),
      variant(2, "temporary_out_of_stock"),
    ])
    expect(plan.status).toBe("draft")
    expect(plan.allUnavailable).toBe(true)
  })

  it("stays published when one variant is still active", () => {
    // A single sold-out size does not hide the whole product.
    const plan = planStockActions([
      variant(1, "out_of_stock"),
      variant(2, "active"),
    ])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })

  it("flags discontinued separately from out of stock", () => {
    const plan = planStockActions([variant(1, "discontinued")])
    expect(plan.status).toBe("draft")
    expect(plan.hasDiscontinued).toBe(true)
  })

  it("reports discontinued even when another variant is active", () => {
    const plan = planStockActions([
      variant(1, "discontinued"),
      variant(2, "active"),
    ])
    expect(plan.status).toBe("published")
    expect(plan.hasDiscontinued).toBe(true)
  })

  it("treats an unrecognized status as available", () => {
    // A status Printful adds later must not silently hide a catalog.
    const plan = planStockActions([variant(1, "some_future_status")])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })

  it("treats a missing status as available", () => {
    const plan = planStockActions([variant(1, undefined)])
    expect(plan.status).toBe("published")
  })

  it("records availability per variant for metadata", () => {
    const plan = planStockActions([
      variant(1001, "active"),
      variant(1002, "out_of_stock"),
    ])
    expect(plan.variantAvailability).toEqual({
      "1001": "active",
      "1002": "out_of_stock",
    })
  })

  it("publishes a product with no variants rather than hiding it", () => {
    // An empty list is a data oddity, not evidence the product sold out.
    const plan = planStockActions([])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })
})

describe("resolvePublication", () => {
  it("unpublishes an available-turned-unavailable product and marks it", () => {
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "published",
      currentMetadata: {},
    })
    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBe("unavailable")
    expect(result.changed).toBe(true)
  })

  it("republishes a product the plugin unpublished, clearing the marker", () => {
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.status).toBe("published")
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
    expect(result.changed).toBe(true)
  })

  it("leaves a merchant's draft alone when there is no marker", () => {
    // The merchant drafted this deliberately — a restock must not undo that.
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: {},
    })
    expect(result.status).toBe("draft")
    expect(result.changed).toBe(false)
  })

  it("does not touch a published product that is still available", () => {
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "published",
      currentMetadata: {},
    })
    expect(result.status).toBe("published")
    expect(result.changed).toBe(false)
  })

  it("re-unpublishes a marked product a merchant manually published", () => {
    // A stale marker is harmless: the product is genuinely unavailable, so
    // hiding it again is the right outcome.
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "published",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.status).toBe("draft")
    expect(result.changed).toBe(true)
  })

  it("does not rewrite an already-unpublished marked product", () => {
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.changed).toBe(false)
  })

  it("does not mutate the metadata object it was given", () => {
    const original = { [STOCK_MARKER_KEY]: "unavailable", other: "keep" }
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: original,
    })
    expect(original[STOCK_MARKER_KEY]).toBe("unavailable")
    expect(result.metadata.other).toBe("keep")
  })
})
