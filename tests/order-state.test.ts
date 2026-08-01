import { describe, expect, it } from "vitest"
import { planOrderStateActions } from "../src/utils/order-state"
import type { PrintfulOrder } from "../src/utils/types"

const base: PrintfulOrder = { id: 777, status: "pending" }

describe("planOrderStateActions", () => {
  it("plans no shipment work for a pending order", () => {
    const plan = planOrderStateActions(base, [])
    expect(plan.shipments).toHaveLength(0)
    expect(plan.metadata.printful_status).toBe("pending")
  })

  it("plans one shipment per unrecorded package", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, carrier: "USPS", service: "Priority", tracking_number: "A1" },
        { id: 2, carrier: "DHL", service: "Express", tracking_number: "B2" },
      ],
    }
    const plan = planOrderStateActions(order, [])
    expect(plan.shipments.map((s) => s.printful_shipment_id)).toEqual(["1", "2"])
    expect(plan.shipments[0].tracking_number).toBe("A1")
  })

  it("skips shipments already recorded in Medusa", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, tracking_number: "A1" },
        { id: 2, tracking_number: "B2" },
      ],
    }
    const plan = planOrderStateActions(order, ["1"])
    expect(plan.shipments.map((s) => s.printful_shipment_id)).toEqual(["2"])
    // Metadata keeps the full history — the admin widget renders every parcel,
    // not just the ones we have yet to record.
    expect(
      (plan.metadata.printful_shipments as Array<{ id: string }>).map((s) => s.id)
    ).toEqual(["1", "2"])
  })

  it("plans nothing when every shipment is recorded", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [{ id: 1, tracking_number: "A1" }],
    }
    expect(planOrderStateActions(order, ["1"]).shipments).toHaveLength(0)
  })

  it("records a failed order without planning shipment work", () => {
    const plan = planOrderStateActions({ ...base, status: "failed" }, [])
    expect(plan.shipments).toHaveLength(0)
    expect(plan.metadata.printful_status).toBe("failed")
    expect(plan.needsAttention).toBe(true)
  })

  it("flags canceled and onhold as needing attention", () => {
    expect(planOrderStateActions({ ...base, status: "canceled" }, []).needsAttention).toBe(true)
    expect(planOrderStateActions({ ...base, status: "onhold" }, []).needsAttention).toBe(true)
  })

  it("does not flag ordinary in-progress states", () => {
    expect(planOrderStateActions({ ...base, status: "inprocess" }, []).needsAttention).toBe(false)
    expect(planOrderStateActions({ ...base, status: "fulfilled" }, []).needsAttention).toBe(false)
  })

  it("carries shipment details into metadata", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 3, carrier: "UPS", service: "Ground", tracking_number: "C3", tracking_url: "http://t/C3", ship_date: "2026-07-31" },
      ],
    }
    const meta = planOrderStateActions(order, []).metadata
    expect(meta.printful_shipments).toEqual([
      { id: "3", carrier: "UPS", service: "Ground", tracking_number: "C3", tracking_url: "http://t/C3", ship_date: "2026-07-31", reshipment: false },
    ])
  })

  it("matches recorded ids regardless of string or number form", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [{ id: 42, tracking_number: "D4" }],
    }
    expect(planOrderStateActions(order, ["42"]).shipments).toHaveLength(0)
  })

  it("handles an order with no shipments array at all", () => {
    const plan = planOrderStateActions({ id: 5, status: "draft" }, [])
    expect(plan.shipments).toHaveLength(0)
    expect(plan.metadata.printful_shipments).toEqual([])
  })

  it("gives each parcel of a split order only its own items", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "partial",
      items: [
        { id: 11, external_id: "orli_a", quantity: 2 },
        { id: 22, external_id: "orli_b", quantity: 1 },
      ],
      shipments: [
        {
          id: 1,
          tracking_number: "A1",
          items: [{ item_id: 11, quantity: 2 }],
        },
        {
          id: 2,
          tracking_number: "B2",
          items: [{ item_id: 22, quantity: 1 }],
        },
      ],
    }

    const plan = planOrderStateActions(order, [])
    expect(plan.shipments).toHaveLength(2)
    expect(plan.shipments[0].items).toEqual([{ item_id: 11, quantity: 2 }])
    expect(plan.shipments[1].items).toEqual([{ item_id: 22, quantity: 1 }])
  })

  it("splits one line item across two parcels by quantity", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "partial",
      items: [{ id: 11, external_id: "orli_a", quantity: 3 }],
      shipments: [
        { id: 1, items: [{ item_id: 11, quantity: 1 }] },
        { id: 2, items: [{ item_id: 11, quantity: 2 }] },
      ],
    }

    const plan = planOrderStateActions(order, [])
    expect(plan.shipments[0].items).toEqual([{ item_id: 11, quantity: 1 }])
    expect(plan.shipments[1].items).toEqual([{ item_id: 11, quantity: 2 }])
  })

  it("leaves items undefined when Printful omits the breakdown", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [{ id: 1, tracking_number: "A1" }],
    }
    expect(planOrderStateActions(order, []).shipments[0].items).toBeUndefined()
  })

  it("carries the reshipment flag through to the plan", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, reshipment: true, items: [{ item_id: 11, quantity: 1 }] },
      ],
    }
    expect(planOrderStateActions(order, []).shipments[0].reshipment).toBe(true)
  })

  // A reshipment clamps to zero unfulfilled quantity, so apply-order-status
  // creates no fulfillment for it and its tracking number exists nowhere else.
  // Metadata is the only place a replacement parcel is visible to the admin,
  // and without this flag it is indistinguishable from the original.
  it("records the reshipment flag in shipment metadata", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, tracking_number: "A1" },
        { id: 2, tracking_number: "B2", reshipment: true },
      ],
    }

    const shipments = planOrderStateActions(order, []).metadata
      .printful_shipments as Array<Record<string, unknown>>

    expect(shipments[0].reshipment).toBe(false)
    expect(shipments[1].reshipment).toBe(true)
  })

  // Printful omits `reshipment` on ordinary parcels rather than sending false.
  // Normalizing to a boolean keeps the admin widget from rendering `undefined`
  // as an absent flag it cannot distinguish from a genuine original.
  it("normalizes a missing reshipment flag to false in metadata", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [{ id: 1, tracking_number: "A1" }],
    }

    const shipments = planOrderStateActions(order, []).metadata
      .printful_shipments as Array<Record<string, unknown>>

    expect(shipments[0].reshipment).toBe(false)
  })
})
