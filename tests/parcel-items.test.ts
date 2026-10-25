import { describe, expect, it } from "vitest"
import { planParcelItems } from "../src/utils/parcel-items"

describe("planParcelItems", () => {
  it("fulfils an ordinary line with what the parcel carried", () => {
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_tee", quantity: 3 }],
      printfulItems: [{ id: 1, external_id: "ordli_tee", quantity: 3 }],
      parcels: [
        { printful_shipment_id: "s1", items: [{ item_id: 1, quantity: 2 }] },
        { printful_shipment_id: "s2", items: [{ item_id: 1, quantity: 1 }] },
      ],
      recorded: new Set(),
    })
    expect(plan.get("s1")).toEqual([{ id: "ordli_tee", quantity: 2 }])
    expect(plan.get("s2")).toEqual([{ id: "ordli_tee", quantity: 1 }])
  })

  it("does not close a bundle until its last member ships", () => {
    // Tee and mug of one bundle leave in different parcels. The first parcel
    // used to fulfil the whole bundle line while the mug was still printing.
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_b", quantity: 1 }],
      printfulItems: [
        { id: 1, external_id: "ordli_b::variant_tee", quantity: 1 },
        { id: 2, external_id: "ordli_b::variant_mug", quantity: 1 },
      ],
      parcels: [
        { printful_shipment_id: "s1", items: [{ item_id: 1, quantity: 1 }] },
        { printful_shipment_id: "s2", items: [{ item_id: 2, quantity: 1 }] },
      ],
      recorded: new Set(),
    })
    expect(plan.get("s1")).toEqual([])
    expect(plan.get("s2")).toEqual([{ id: "ordli_b", quantity: 1 }])
  })

  it("counts whole bundles when members ship in uneven batches", () => {
    // Two bundles, each a tee and two stickers: 2 tees, 4 stickers.
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_b", quantity: 2 }],
      printfulItems: [
        { id: 1, external_id: "ordli_b::variant_tee", quantity: 2 },
        { id: 2, external_id: "ordli_b::variant_sticker", quantity: 4 },
      ],
      parcels: [
        {
          printful_shipment_id: "s1",
          items: [
            { item_id: 1, quantity: 2 },
            { item_id: 2, quantity: 3 },
          ],
        },
        { printful_shipment_id: "s2", items: [{ item_id: 2, quantity: 1 }] },
      ],
      recorded: new Set(),
    })
    // 3 stickers complete one bundle (two each); the fourth completes the next.
    expect(plan.get("s1")).toEqual([{ id: "ordli_b", quantity: 1 }])
    expect(plan.get("s2")).toEqual([{ id: "ordli_b", quantity: 1 }])
  })

  it("accumulates bundle progress through parcels already recorded", () => {
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_b", quantity: 1 }],
      printfulItems: [
        { id: 1, external_id: "ordli_b::variant_tee", quantity: 1 },
        { id: 2, external_id: "ordli_b::variant_mug", quantity: 1 },
      ],
      parcels: [
        { printful_shipment_id: "s1", items: [{ item_id: 1, quantity: 1 }] },
        { printful_shipment_id: "s2", items: [{ item_id: 2, quantity: 1 }] },
      ],
      recorded: new Set(["s1"]),
    })
    expect(plan.has("s1")).toBe(false)
    expect(plan.get("s2")).toEqual([{ id: "ordli_b", quantity: 1 }])
  })

  it("clamps to what Medusa still has open", () => {
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_tee", quantity: 2, fulfilled_quantity: 2 }],
      printfulItems: [{ id: 1, external_id: "ordli_tee", quantity: 2 }],
      parcels: [
        { printful_shipment_id: "s3", items: [{ item_id: 1, quantity: 2 }] },
      ],
      recorded: new Set(),
    })
    expect(plan.get("s3")).toEqual([])
  })

  it("without a breakdown, fulfils only lines Printful holds", () => {
    // Mixed cart: the poster ships from the merchant, not from Printful. A
    // Printful parcel with no item list must not mark it fulfilled.
    const plan = planParcelItems({
      orderLines: [
        { id: "ordli_tee", quantity: 1 },
        { id: "ordli_poster", quantity: 1 },
        { id: "ordli_b", quantity: 1 },
      ],
      printfulItems: [
        { id: 1, external_id: "ordli_tee", quantity: 1 },
        { id: 2, external_id: "ordli_b::variant_mug", quantity: 1 },
      ],
      parcels: [{ printful_shipment_id: "s1" }],
      recorded: new Set(),
    })
    expect(plan.get("s1")).toEqual([
      { id: "ordli_tee", quantity: 1 },
      { id: "ordli_b", quantity: 1 },
    ])
  })

  it("ignores parcel items it cannot place", () => {
    const plan = planParcelItems({
      orderLines: [{ id: "ordli_tee", quantity: 1 }],
      printfulItems: [{ id: 1, external_id: null, quantity: 1 }],
      parcels: [
        { printful_shipment_id: "s1", items: [{ item_id: 1, quantity: 1 }] },
      ],
      recorded: new Set(),
    })
    expect(plan.get("s1")).toEqual([])
  })
})
