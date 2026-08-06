import { describe, expect, it } from "vitest"
import {
  BUNDLE_MEMBERS_KEY,
  bundleMembersOf,
  expandOrderLines,
  isBundleLine,
  medusaLineIdFor,
  planBundleAvailability,
  planBundlePass,
  planBundlePublication,
} from "../src/utils/bundle"
import { STOCK_MARKER_KEY } from "../src/utils/stock"

/** A bundle line as it looks on an order: members captured at purchase. */
const bundleLine = {
  id: "item_bundle",
  variant_id: "var_bundle",
  title: "Wave drop — tee, sticker, poster",
  quantity: 1,
  metadata: {
    [BUNDLE_MEMBERS_KEY]: [
      { variant_id: "var_tee_black_l", quantity: 1 },
      { variant_id: "var_sticker_3in", quantity: 2 },
      { variant_id: "var_poster_a3", quantity: 1 },
    ],
  },
}

const plainLine = {
  id: "item_plain",
  variant_id: "var_tee_black_m",
  title: "Wave tee",
  quantity: 1,
  metadata: {},
}

describe("isBundleLine", () => {
  it("recognizes a line carrying members", () => {
    expect(isBundleLine(bundleLine)).toBe(true)
  })

  it("leaves an ordinary line alone", () => {
    expect(isBundleLine(plainLine)).toBe(false)
    expect(isBundleLine({ id: "x", variant_id: "v", quantity: 1 })).toBe(false)
  })

  it("does not treat an empty member list as a bundle", () => {
    // A bundle with nothing in it would expand to no Printful items, and the
    // order would look like it had none at all. Better to treat it as an
    // ordinary line and let the usual unresolved-variant path report it.
    expect(
      isBundleLine({ ...plainLine, metadata: { [BUNDLE_MEMBERS_KEY]: [] } })
    ).toBe(false)
  })
})

describe("expandOrderLines", () => {
  it("replaces a bundle with the lines it stands for", () => {
    // The defect this prevents: create-printful-order resolves one line to one
    // Printful item, so an unexpanded three-item bundle ships one thing.
    const out = expandOrderLines([bundleLine])

    expect(out).toHaveLength(3)
    expect(out.map((l) => l.variant_id)).toEqual([
      "var_tee_black_l",
      "var_sticker_3in",
      "var_poster_a3",
    ])
  })

  it("multiplies member quantity by how many bundles were bought", () => {
    // Two bundles, each holding two stickers, is four stickers. Getting this
    // wrong ships a customer half their order.
    const out = expandOrderLines([{ ...bundleLine, quantity: 2 }])

    expect(out.find((l) => l.variant_id === "var_sticker_3in")?.quantity).toBe(
      4
    )
    expect(out.find((l) => l.variant_id === "var_tee_black_l")?.quantity).toBe(
      2
    )
  })

  it("passes ordinary lines through untouched", () => {
    const out = expandOrderLines([plainLine])
    expect(out).toEqual([plainLine])
  })

  it("keeps order when a cart mixes bundles and singles", () => {
    const out = expandOrderLines([plainLine, bundleLine])
    expect(out).toHaveLength(4)
    expect(out[0].variant_id).toBe("var_tee_black_m")
  })

  it("traces every expanded line back to the bundle it came from", () => {
    // Printful reports failures per item. Without this, a merchant sees a
    // failed sticker and no way to tell which bundle sold it.
    const out = expandOrderLines([bundleLine])
    expect(out.every((l) => l.bundle_line_id === "item_bundle")).toBe(true)
  })

  it("drops a member with no variant id rather than ordering nothing", () => {
    const broken = {
      ...bundleLine,
      metadata: {
        [BUNDLE_MEMBERS_KEY]: [
          { variant_id: "var_tee_black_l", quantity: 1 },
          { quantity: 1 },
        ],
      },
    }
    const out = expandOrderLines([broken as never])
    expect(out).toHaveLength(1)
    expect(out[0].variant_id).toBe("var_tee_black_l")
  })
})

describe("bundleMembersOf", () => {
  it("reads members off a line", () => {
    expect(bundleMembersOf(bundleLine)).toHaveLength(3)
  })

  it("returns nothing for a line that is not a bundle", () => {
    expect(bundleMembersOf(plainLine)).toEqual([])
  })

  it("ignores a members value that is not a list", () => {
    // Metadata is free-form JSON. Something else writing a string here must
    // not crash order creation.
    expect(
      bundleMembersOf({
        ...plainLine,
        metadata: { [BUNDLE_MEMBERS_KEY]: "tee, sticker" },
      } as never)
    ).toEqual([])
  })
})

describe("medusaLineIdFor", () => {
  it("maps an expanded item back to the bundle line the customer bought", () => {
    // The defect this prevents: apply-order-status joins a parcel to a Medusa
    // line by external_id. A synthetic id matches no line, so every parcel
    // clamps to zero open quantity and the order is never marked shipped.
    const out = expandOrderLines([bundleLine])
    expect(out.map((l) => medusaLineIdFor(l.id))).toEqual([
      "item_bundle",
      "item_bundle",
      "item_bundle",
    ])
  })

  it("leaves an ordinary line id untouched", () => {
    expect(medusaLineIdFor("ordli_01JABC")).toBe("ordli_01JABC")
  })

  it("splits on the first separator only", () => {
    // Medusa ids are ULID-based and contain no colons, but a variant id is
    // merchant-controlled. Splitting on the last separator would attribute the
    // parcel to a line id that does not exist.
    expect(medusaLineIdFor("item_bundle::var::odd")).toBe("item_bundle")
  })
})

describe("planBundlePublication", () => {
  const member = (status: string) => ({
    metadata: { printful_availability_status: status },
  })

  it("drafts a bundle whose member sold out, and marks it as ours", () => {
    const out = planBundlePublication({
      members: [member("active"), member("out_of_stock")],
      currentStatus: "published",
      currentMetadata: {},
    })

    expect(out.status).toBe("draft")
    expect(out.changed).toBe(true)
    expect(out.metadata[STOCK_MARKER_KEY]).toBe("unavailable")
  })

  it("republishes once the member is back, clearing the marker", () => {
    const out = planBundlePublication({
      members: [member("active")],
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })

    expect(out.status).toBe("published")
    expect(out.metadata[STOCK_MARKER_KEY]).toBeUndefined()
  })

  it("leaves a draft the merchant made alone", () => {
    // No marker means we did not draft it. Republishing here would undo the
    // merchant's own decision on every sync.
    const out = planBundlePublication({
      members: [member("active")],
      currentStatus: "draft",
      currentMetadata: {},
    })

    expect(out.status).toBe("draft")
    expect(out.changed).toBe(false)
  })

  it("drafts on one sold-out member, unlike a plain product", () => {
    // planStockActions drafts only when *every* variant is gone. A bundle is a
    // promise to ship all of it, so one missing member breaks the promise even
    // though the rest are in stock.
    const out = planBundlePublication({
      members: [member("active"), member("active"), member("discontinued")],
      currentStatus: "published",
      currentMetadata: {},
    })

    expect(out.status).toBe("draft")
  })

  it("does not touch a bundle with no members recorded", () => {
    // An empty member list is a bundle not yet configured, not a sellout.
    // Drafting it would hide a product the merchant is still building.
    const out = planBundlePublication({
      members: [],
      currentStatus: "published",
      currentMetadata: {},
    })

    expect(out.status).toBe("published")
    expect(out.changed).toBe(false)
  })
})

describe("planBundlePass", () => {
  const variants = (statuses: Record<string, string>) =>
    new Map(
      Object.entries(statuses).map(([id, status]) => [
        id,
        { metadata: { printful_availability_status: status } },
      ])
    )

  const bundleProduct = (status: string, members: string[]) => ({
    id: "prod_bundle",
    status,
    metadata: {},
    variants: [
      {
        id: "var_bundle",
        metadata: {
          [BUNDLE_MEMBERS_KEY]: members.map((variant_id) => ({ variant_id })),
        },
      },
    ],
  })

  it("drafts a bundle whose member sold out, naming the member", () => {
    // Bundles have no Printful product, so the per-product sync loop never
    // reaches them. Without this pass a bundle stays on sale after a member
    // sells out and every such order fails at Printful.
    const writes = planBundlePass({
      bundles: [bundleProduct("published", ["var_tee", "var_hat"])],
      variantsById: variants({ var_tee: "active", var_hat: "out_of_stock" }),
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].status).toBe("draft")
    expect(writes[0].missing).toEqual(["var_hat"])
  })

  it("writes nothing when no bundle changed", () => {
    // A sync over an unchanged catalogue must issue no product updates.
    const writes = planBundlePass({
      bundles: [bundleProduct("published", ["var_tee"])],
      variantsById: variants({ var_tee: "active" }),
    })

    expect(writes).toEqual([])
  })

  it("ignores a product that is not a bundle", () => {
    const writes = planBundlePass({
      bundles: [
        {
          id: "prod_tee",
          status: "published",
          variants: [{ id: "v", metadata: {} }],
        },
      ],
      variantsById: variants({}),
    })

    expect(writes).toEqual([])
  })

  it("does not republish a bundle when no member could be loaded", () => {
    // Knowing nothing about the members is not evidence they are back in
    // stock. Republishing here would put a bundle back on sale on the strength
    // of a failed lookup.
    const writes = planBundlePass({
      bundles: [
        {
          ...bundleProduct("draft", ["var_tee", "var_hat"]),
          metadata: { [STOCK_MARKER_KEY]: "unavailable" },
        },
      ],
      variantsById: variants({}),
    })

    expect(writes).toEqual([])
  })

  it("does not draft a bundle whose member could not be loaded", () => {
    // A missing lookup is not evidence Printful ran out of anything. Counting
    // it as sold out would hide a live bundle on a transient failure.
    const writes = planBundlePass({
      bundles: [bundleProduct("published", ["var_tee", "var_gone"])],
      variantsById: variants({ var_tee: "active" }),
    })

    expect(writes).toEqual([])
  })
})

describe("planBundleAvailability", () => {
  const available = { printful_availability_status: "active" }
  const soldOut = { printful_availability_status: "out_of_stock" }

  it("is available when every member is", () => {
    const plan = planBundleAvailability([available, available])
    expect(plan.available).toBe(true)
  })

  it("is unavailable when any single member is", () => {
    // A bundle is a promise to ship all of it. One sold-out member makes the
    // whole promise unkeepable, however available the rest are.
    const plan = planBundleAvailability([available, soldOut, available])
    expect(plan.available).toBe(false)
    expect(plan.unavailableCount).toBe(1)
  })

  it("is unavailable when it has no members at all", () => {
    // Nothing to ship is not the same as everything in stock, though a
    // vacuous "every member is available" would say so.
    expect(planBundleAvailability([]).available).toBe(false)
  })

  it("treats an unknown status as available, matching the stock planner", () => {
    // planStockActions fails open on statuses Printful has not documented;
    // diverging here would make a bundle stricter than its own members.
    const plan = planBundleAvailability([
      { printful_availability_status: "something_new" },
    ])
    expect(plan.available).toBe(true)
  })
})
