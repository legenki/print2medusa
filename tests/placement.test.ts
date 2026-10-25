import { describe, expect, it, vi } from "vitest"
import { resolveProductPlacement } from "../src/utils/placement"

describe("resolveProductPlacement", () => {
  it("prefers the configured channels and profile over the store defaults", async () => {
    const getDefaultSalesChannelId = vi.fn().mockResolvedValue("sc_default")
    const getDefaultShippingProfileId = vi.fn().mockResolvedValue("sp_default")

    const placement = await resolveProductPlacement({
      salesChannelIds: ["sc_web", "sc_app"],
      shippingProfileId: "sp_pod",
      getDefaultSalesChannelId,
      getDefaultShippingProfileId,
    })

    expect(placement).toEqual({
      salesChannelIds: ["sc_web", "sc_app"],
      shippingProfileId: "sp_pod",
      warnings: [],
    })
    expect(getDefaultSalesChannelId).not.toHaveBeenCalled()
    expect(getDefaultShippingProfileId).not.toHaveBeenCalled()
  })

  it("falls back to the store's default channel and default profile", async () => {
    // Without a channel the Store API never lists the product; without a
    // profile the cart offers it no shipping option.
    const placement = await resolveProductPlacement({
      getDefaultSalesChannelId: async () => "sc_default",
      getDefaultShippingProfileId: async () => "sp_default",
    })

    expect(placement).toEqual({
      salesChannelIds: ["sc_default"],
      shippingProfileId: "sp_default",
      warnings: [],
    })
  })

  it("ignores blank configured values", async () => {
    const placement = await resolveProductPlacement({
      salesChannelIds: ["", "  "],
      shippingProfileId: " ",
      getDefaultSalesChannelId: async () => "sc_default",
      getDefaultShippingProfileId: async () => "sp_default",
    })

    expect(placement.salesChannelIds).toEqual(["sc_default"])
    expect(placement.shippingProfileId).toBe("sp_default")
  })

  it("warns rather than throws when nothing can be resolved", async () => {
    // A store with no defaults must still import its catalog; the warning is
    // what tells the owner why the products are not for sale yet.
    const placement = await resolveProductPlacement({
      getDefaultSalesChannelId: async () => {
        throw new Error("store module down")
      },
      getDefaultShippingProfileId: async () => null,
    })

    expect(placement.salesChannelIds).toEqual([])
    expect(placement.shippingProfileId).toBeUndefined()
    expect(placement.warnings).toHaveLength(2)
  })
})
