import { describe, expect, it } from "vitest"
import {
  BUNDLE_MEMBERS_KEY,
  bundleMembersOf,
  expandOrderLines,
  isBundleLine,
  planBundleAvailability,
} from "../src/utils/bundle"

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
