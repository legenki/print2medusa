import { describe, expect, it } from "vitest"
import {
  REMOVED_MARKER_KEY,
  clearRemovedMarker,
  findMissingSyncProductLinks,
  planRemovedProductWrite,
  shouldRunRemovalPass,
} from "../src/utils/removed"
import { STOCK_MARKER_KEY } from "../src/utils/stock"

describe("findMissingSyncProductLinks", () => {
  const links = [
    {
      printful_sync_product_id: "1",
      medusa_product_id: "prod_1",
    },
    {
      printful_sync_product_id: "2",
      medusa_product_id: "prod_2",
    },
    {
      printful_sync_product_id: "3",
      medusa_product_id: "prod_3",
    },
  ]

  it("returns links whose Printful ids were not seen", () => {
    expect(findMissingSyncProductLinks(links, ["1", "3"])).toEqual([links[1]])
  })

  it("returns nothing when every link was seen", () => {
    expect(findMissingSyncProductLinks(links, ["1", "2", "3"])).toEqual([])
  })

  it("treats all links as missing when the catalogue is empty", () => {
    expect(findMissingSyncProductLinks(links, [])).toEqual(links)
  })

  it("normalizes string ids with whitespace", () => {
    expect(findMissingSyncProductLinks(links, [" 1 ", "2"])).toEqual([links[2]])
  })
})

describe("planRemovedProductWrite", () => {
  it("does nothing when policy is ignore", () => {
    const result = planRemovedProductWrite({
      policy: "ignore",
      currentStatus: "published",
      currentMetadata: { keep: true },
    })
    expect(result.action).toBe("none")
    expect(result.status).toBe("published")
    expect(result.metadata).toEqual({ keep: true })
  })

  it("unpublishes a published product and sets markers", () => {
    const result = planRemovedProductWrite({
      policy: "unpublish",
      currentStatus: "published",
      currentMetadata: { title_meta: 1 },
    })
    expect(result.action).toBe("unpublish")
    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBe("unavailable")
    expect(result.metadata[REMOVED_MARKER_KEY]).toBe(true)
    expect(result.metadata.title_meta).toBe(1)
  })

  it("does not claim a merchant draft that has no plugin marker", () => {
    const result = planRemovedProductWrite({
      policy: "unpublish",
      currentStatus: "draft",
      currentMetadata: {},
    })
    expect(result.action).toBe("none")
    expect(result.status).toBe("draft")
    expect(result.metadata[REMOVED_MARKER_KEY]).toBeUndefined()
  })

  it("keeps markers on a draft the plugin already owns", () => {
    const result = planRemovedProductWrite({
      policy: "unpublish",
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.action).toBe("none")
    expect(result.status).toBe("draft")
    expect(result.metadata[REMOVED_MARKER_KEY]).toBe(true)
  })
})

describe("clearRemovedMarker", () => {
  it("removes the removal flag without touching stock markers", () => {
    const next = clearRemovedMarker({
      [REMOVED_MARKER_KEY]: true,
      [STOCK_MARKER_KEY]: "unavailable",
      other: 1,
    })
    expect(next[REMOVED_MARKER_KEY]).toBeUndefined()
    expect(next[STOCK_MARKER_KEY]).toBe("unavailable")
    expect(next.other).toBe(1)
  })

  it("is a no-op when the flag is absent", () => {
    const meta = { a: 1 }
    expect(clearRemovedMarker(meta)).toBe(meta)
  })
})

describe("shouldRunRemovalPass", () => {
  it("runs on a full catalogue pass", () => {
    expect(shouldRunRemovalPass({ policy: "unpublish" })).toBe(true)
  })

  it("never runs on a partial sync", () => {
    // The dangerous case. A `limit` run sees only the first N products, so
    // everything past the limit looks removed — acting on that would unpublish
    // most of the catalogue from a run meant to touch a handful of items.
    expect(shouldRunRemovalPass({ policy: "unpublish", limit: 5 })).toBe(false)
    expect(shouldRunRemovalPass({ policy: "unpublish", limit: 1 })).toBe(false)
    // Zero is a limit too, and a falsy one — the guard must test for null,
    // not for truthiness.
    expect(shouldRunRemovalPass({ policy: "unpublish", limit: 0 })).toBe(false)
  })

  it("never runs when the policy is ignore", () => {
    expect(shouldRunRemovalPass({ policy: "ignore" })).toBe(false)
    expect(shouldRunRemovalPass({ policy: "ignore", limit: 5 })).toBe(false)
  })
})
