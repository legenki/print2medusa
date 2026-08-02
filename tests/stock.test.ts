import { describe, expect, it } from "vitest"
import { planStockActions } from "../src/utils/stock"

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
