import { describe, expect, it } from "vitest"
import { REMOVED_MARKER_KEY } from "../src/utils/removed"
import {
  planStockActions,
  resolveExistingProductWrite,
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

  it("does not mark a merchant's draft that happens to be out of stock", () => {
    // No marker means the plugin never unpublished this — the merchant did.
    // Writing one here would make the plugin republish their draft on restock.
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "draft",
      currentMetadata: {},
    })
    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
    expect(result.changed).toBe(false)
  })

  it("does not republish a merchant draft after a restock", () => {
    // The full latent path: out of stock while merchant-drafted, then back in
    // stock. The product must still be theirs to publish.
    const outOfStock = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "draft",
      currentMetadata: {},
    })

    const restocked = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: outOfStock.metadata,
    })

    expect(restocked.status).toBe("draft")
    expect(restocked.changed).toBe(false)
  })
})

describe("resolveExistingProductWrite", () => {
  // These cover the decision the *sync workflow* makes for a product that
  // already exists in Medusa. resolvePublication was fully unit-tested in
  // 0.4.0 and still nothing called it — the workflow force-set the mapper's
  // status instead. Testing the helper the workflow actually calls is what
  // closes that gap.

  const availablePlan = planStockActions([
    variant(1, "active"),
    variant(2, "active"),
  ])
  const soldOutPlan = planStockActions([
    variant(1, "out_of_stock"),
    variant(2, "discontinued"),
  ])

  it("leaves a merchant's unmarked draft alone when stock is available", () => {
    // The headline bug: Printful says every variant is orderable, so the
    // mapper's raw status is "published". The merchant drafted this product
    // themselves and there is no plugin marker, so it is not ours to publish.
    const result = resolveExistingProductWrite({
      plan: availablePlan,
      currentStatus: "draft",
      currentMetadata: {},
      mappedMetadata: { printful_sync_product_id: "77" },
    })

    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
  })

  it("republishes a draft the plugin marked, and clears the marker", () => {
    const result = resolveExistingProductWrite({
      plan: availablePlan,
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
      mappedMetadata: { printful_sync_product_id: "77" },
    })

    expect(result.status).toBe("published")
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
  })

  it("clears printful_removed when the product is seen on Printful again", () => {
    const result = resolveExistingProductWrite({
      plan: availablePlan,
      currentStatus: "draft",
      currentMetadata: {
        [STOCK_MARKER_KEY]: "unavailable",
        [REMOVED_MARKER_KEY]: true,
      },
      mappedMetadata: { printful_sync_product_id: "77" },
    })

    expect(result.status).toBe("published")
    expect(result.metadata[REMOVED_MARKER_KEY]).toBeUndefined()
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
  })

  it("drafts a published product that sold out, and marks it as ours", () => {
    const result = resolveExistingProductWrite({
      plan: soldOutPlan,
      currentStatus: "published",
      currentMetadata: {},
      mappedMetadata: { printful_sync_product_id: "77" },
    })

    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBe("unavailable")
  })

  it("keeps the Printful-derived metadata keys from the mapper", () => {
    const result = resolveExistingProductWrite({
      plan: availablePlan,
      currentStatus: "published",
      currentMetadata: { merchant_note: "keep me" },
      mappedMetadata: {
        printful_store_id: "store_1",
        printful_sync_product_id: "77",
        printful_discontinued: true,
      },
    })

    expect(result.metadata.printful_store_id).toBe("store_1")
    expect(result.metadata.printful_sync_product_id).toBe("77")
    expect(result.metadata.printful_discontinued).toBe(true)
    expect(result.metadata.merchant_note).toBe("keep me")
  })

  it("never returns the mapper's raw status for a merchant draft", () => {
    // Guard against a regression to `status: mapped.status`. planStockActions
    // returns "published" here; the write must still be "draft".
    expect(availablePlan.status).toBe("published")

    const result = resolveExistingProductWrite({
      plan: availablePlan,
      currentStatus: "draft",
      currentMetadata: { merchant_note: "drafted on purpose" },
      mappedMetadata: {},
    })

    expect(result.status).toBe("draft")
    expect(result.metadata.merchant_note).toBe("drafted on purpose")
  })
})
