import { describe, expect, it } from "vitest"
import {
  classifyProduct,
  corePlacementsFor,
  planDesignParameters,
  PLACEMENTS_BY_CLASS,
} from "../src/utils/design"
import type { PrintfulCatalogVariant } from "../src/utils/types"

/**
 * Fixtures mirror the seven products the store actually sells, shaped as
 * `GET /products/variant/{id}` returns them. Placement lists are trimmed to
 * the ones that decide a case — the tee really exposes 17.
 */

const tee: PrintfulCatalogVariant = {
  variant: {
    id: 4025,
    product_id: 71,
    name: "Unisex Staple T-Shirt | Aqua / S",
    size: "S",
    color: "Aqua",
    color_code: "#008db5",
    material: [{ name: "Airlume cotton", percentage: 100 }],
  },
  product: {
    id: 71,
    title: "Unisex Staple T-Shirt | Bella + Canvas 3001",
    brand: "Bella + Canvas",
    model: "3001",
    techniques: [
      { key: "dtg", display_name: "DTG printing", is_default: true },
      { key: "embroidery", display_name: "Embroidery" },
      { key: "dtfilm", display_name: "DTF" },
    ],
    files: [
      { id: "front", type: "front", title: "Front print" },
      { id: "back", type: "back", title: "Back print" },
      { id: "left_sleeve", type: "left_sleeve", title: "Left sleeve" },
      { id: "embroidery_chest_left", type: "embroidery_chest_left" },
      { id: "preview", type: "preview", title: "Mockup" },
    ],
  },
}

const cap: PrintfulCatalogVariant = {
  variant: {
    id: 12820,
    product_id: 206,
    name: "Dad Hat | Black",
    color: "Black",
    color_code: "#111111",
    material: [{ name: "Cotton twill", percentage: 100 }],
  },
  product: {
    id: 206,
    title: "Dad Hat",
    brand: "Yupoong",
    model: "6245CM",
    // The whole point of the cap: no DTG anywhere in this list.
    techniques: [
      { key: "embroidery", display_name: "Embroidery", is_default: true },
      { key: "dtfilm", display_name: "DTF" },
    ],
    files: [
      { id: "embroidery_front", type: "embroidery_front", title: "Front" },
      { id: "embroidery_back", type: "embroidery_back", title: "Back" },
      { id: "preview", type: "preview" },
    ],
  },
}

const sticker: PrintfulCatalogVariant = {
  variant: {
    id: 10163,
    product_id: 358,
    name: 'Kiss-Cut Stickers | 3"×3"',
    size: '3"×3"',
  },
  product: {
    id: 358,
    title: "Kiss-Cut Stickers",
    dimensions: { default: '3" × 3"' },
    techniques: [{ key: "digital", display_name: "Digital", is_default: true }],
    files: [
      { id: "default", type: "default", title: "Print file" },
      { id: "preview", type: "preview" },
    ],
  },
}

const poster: PrintfulCatalogVariant = {
  variant: {
    id: 1349,
    product_id: 1,
    name: 'Matte Poster | 12"×18"',
    size: '12"×18"',
    color: "White",
    color_code: "#ffffff",
  },
  product: {
    id: 1,
    title: "Matte Poster (in)",
    dimensions: { '12"×18"': '12" × 18"' },
    techniques: [{ key: "digital", is_default: true }],
    files: [{ id: "default", type: "default" }],
  },
}

const tote: PrintfulCatalogVariant = {
  variant: {
    id: 15000,
    product_id: 367,
    name: "Eco Tote Bag | Oyster",
    color: "Oyster",
    color_code: "#d8d3c5",
    material: [{ name: "Recycled cotton", percentage: 65 }],
  },
  product: {
    id: 367,
    title: "Eco Tote Bag",
    brand: "Econscious",
    model: "EC8000",
    techniques: [
      { key: "dtg", is_default: true },
      { key: "embroidery" },
      { key: "dtfilm" },
    ],
    files: [
      { id: "front", type: "front" },
      { id: "back", type: "back" },
      { id: "preview", type: "preview" },
    ],
  },
}

describe("classifyProduct", () => {
  it("classifies a DTG garment as apparel", () => {
    expect(classifyProduct(tee)).toBe("apparel")
  })

  it("classifies the tote as apparel — DTG on a garment, not a poster", () => {
    expect(classifyProduct(tote)).toBe("apparel")
  })

  it("classifies an embroidery-only cap as embroidery, never apparel", () => {
    // 206 supports EMBROIDERY and DTF and no DTG at all. Calling it apparel
    // would frame thread as ink and pick front/back placements it lacks.
    expect(classifyProduct(cap)).toBe("embroidery")
  })

  it("classifies DIGITAL-only products as print media", () => {
    expect(classifyProduct(sticker)).toBe("print_media")
    expect(classifyProduct(poster)).toBe("print_media")
  })

  it("does not classify from the catalog id", () => {
    // An eighth product the store adds tomorrow has an id we have never seen.
    // Derivation from techniques must still place it.
    const unknown: PrintfulCatalogVariant = {
      variant: { id: 999999, product_id: 99999, color: "Red" },
      product: {
        id: 99999,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }, { type: "back" }],
      },
    }
    expect(classifyProduct(unknown)).toBe("apparel")
  })

  it("returns unknown rather than guessing when there are no techniques", () => {
    const bare: PrintfulCatalogVariant = {
      variant: { id: 1 },
      product: { id: 2 },
    }
    expect(classifyProduct(bare)).toBe("unknown")
  })

  it("returns unknown for an empty technique list", () => {
    const bare: PrintfulCatalogVariant = {
      variant: { id: 1 },
      product: { id: 2, techniques: [], files: [] },
    }
    expect(classifyProduct(bare)).toBe("unknown")
  })

  it("classifies a DTF-only garment as apparel", () => {
    // DTF is film on fabric — printed, not stitched.
    const dtfOnly: PrintfulCatalogVariant = {
      variant: { id: 5, color: "Navy", color_code: "#001f3f" },
      product: {
        id: 6,
        techniques: [{ key: "dtfilm" }],
        files: [{ type: "front" }],
      },
    }
    expect(classifyProduct(dtfOnly)).toBe("apparel")
  })

  it("reads technique keys case-insensitively", () => {
    const upper: PrintfulCatalogVariant = {
      variant: { id: 7 },
      product: {
        id: 8,
        techniques: [{ key: "EMBROIDERY" }, { key: "DTFILM" }],
        files: [{ type: "embroidery_front" }],
      },
    }
    expect(classifyProduct(upper)).toBe("embroidery")
  })
})

describe("corePlacementsFor", () => {
  it("leads a tee with front and back out of its full placement set", () => {
    expect(corePlacementsFor(tee)).toEqual(["front", "back"])
  })

  it("gives the cap embroidery_front and never an empty list", () => {
    // A naive front/back filter returns [] here and the admin sees no
    // placement at all for a product that plainly has one.
    const core = corePlacementsFor(cap)
    expect(core.length).toBeGreaterThan(0)
    expect(core).toEqual(["embroidery_front"])
  })

  it("gives print media the default placement", () => {
    expect(corePlacementsFor(sticker)).toEqual(["default"])
    expect(corePlacementsFor(poster)).toEqual(["default"])
  })

  it("omits a core placement the variant does not actually offer", () => {
    // Front-only garment: `back` is not invented for it.
    const frontOnly: PrintfulCatalogVariant = {
      variant: { id: 9 },
      product: {
        id: 10,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }, { type: "preview" }],
      },
    }
    expect(corePlacementsFor(frontOnly)).toEqual(["front"])
  })

  it("returns an empty core list for an unclassifiable variant", () => {
    const bare: PrintfulCatalogVariant = { variant: {}, product: {} }
    expect(corePlacementsFor(bare)).toEqual([])
  })

  it("declares the core placement of each class", () => {
    expect(PLACEMENTS_BY_CLASS.apparel).toEqual(["front", "back"])
    expect(PLACEMENTS_BY_CLASS.embroidery).toEqual(["embroidery_front"])
    expect(PLACEMENTS_BY_CLASS.print_media).toEqual(["default"])
  })
})

describe("planDesignParameters", () => {
  it("returns apparel parameters with colour, hex and technique", () => {
    const plan = planDesignParameters(tee)
    expect(plan).not.toBeNull()
    expect(plan?.productClass).toBe("apparel")
    expect(plan?.color).toBe("Aqua")
    expect(plan?.colorHex).toBe("#008db5")
    expect(plan?.technique).toBe("DTG")
    expect(plan?.brand).toBe("Bella + Canvas")
    expect(plan?.model).toBe("3001")
    expect(plan?.material).toBe("100% Airlume cotton")
    expect(plan?.size).toBe("S")
  })

  it("keeps the full placement list alongside the core one", () => {
    const plan = planDesignParameters(tee)
    expect(plan?.corePlacements).toEqual(["front", "back"])
    // The rest stay available; only `preview` — not a print area — is dropped.
    expect(plan?.placements).toContain("left_sleeve")
    expect(plan?.placements).toContain("embroidery_chest_left")
    expect(plan?.placements).not.toContain("preview")
    expect(plan!.placements.length).toBeGreaterThan(plan!.corePlacements.length)
  })

  it("describes the cap as thread, not ink", () => {
    const plan = planDesignParameters(cap)
    expect(plan?.productClass).toBe("embroidery")
    expect(plan?.technique).toBe("EMBROIDERY")
    expect(plan?.corePlacements).toEqual(["embroidery_front"])
    expect(plan?.corePlacements.length).toBeGreaterThan(0)
  })

  it("gives print media a physical size and no colour", () => {
    const plan = planDesignParameters(sticker)
    expect(plan?.productClass).toBe("print_media")
    expect(plan?.technique).toBe("DIGITAL")
    expect(plan?.size).toBe('3"×3"')
    expect(plan?.dimensions).toBe('3" × 3"')
    // Stickers have no meaningful base colour, and none is invented.
    expect(plan?.color).toBeUndefined()
    expect(plan?.colorHex).toBeUndefined()
  })

  it("drops a print-media colour rather than describing white paper", () => {
    // The framed poster reports White #ffffff. That is stock, not a design
    // parameter, and showing it as a swatch reads as a deliberate choice.
    const plan = planDesignParameters(poster)
    expect(plan?.productClass).toBe("print_media")
    expect(plan?.color).toBeUndefined()
    expect(plan?.colorHex).toBeUndefined()
  })

  it("keeps a colour name when the hex is missing, without a fake hex", () => {
    // An empty string renders as a black swatch — the one wrong answer.
    const noHex: PrintfulCatalogVariant = {
      variant: { id: 11, color: "Heather Dust" },
      product: {
        id: 12,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }],
      },
    }
    const plan = planDesignParameters(noHex)
    expect(plan?.color).toBe("Heather Dust")
    expect(plan?.colorHex).toBeUndefined()
    expect(plan?.colorHex).not.toBe("")
  })

  it("rejects a hex that is not a hex rather than passing it through", () => {
    const badHex: PrintfulCatalogVariant = {
      variant: { id: 13, color: "Aqua", color_code: "not-a-colour" },
      product: {
        id: 14,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }],
      },
    }
    expect(planDesignParameters(badHex)?.colorHex).toBeUndefined()
  })

  it("normalizes a hex that arrives without its hash", () => {
    const bare: PrintfulCatalogVariant = {
      variant: { id: 15, color: "Aqua", color_code: "008db5" },
      product: {
        id: 16,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }],
      },
    }
    expect(planDesignParameters(bare)?.colorHex).toBe("#008db5")
  })

  it("returns null for a variant it cannot classify", () => {
    // Nothing to say beats saying something unfounded.
    expect(planDesignParameters({ variant: {}, product: {} })).toBeNull()
  })

  it("returns null for null or undefined input", () => {
    expect(planDesignParameters(null)).toBeNull()
    expect(planDesignParameters(undefined)).toBeNull()
  })

  it("does not crash on a variant with no product block at all", () => {
    expect(() =>
      planDesignParameters({ variant: { id: 1 } } as PrintfulCatalogVariant)
    ).not.toThrow()
  })

  it("prefers the default technique when several are offered", () => {
    const plan = planDesignParameters(tote)
    expect(plan?.technique).toBe("DTG")
    expect(plan?.techniques).toEqual(["DTG", "EMBROIDERY", "DTF"])
  })

  it("summarises a multi-part material blend", () => {
    const blend: PrintfulCatalogVariant = {
      variant: {
        id: 17,
        color: "Sport Grey",
        color_code: "#97999b",
        material: [
          { name: "cotton", percentage: 50 },
          { name: "polyester", percentage: 50 },
        ],
      },
      product: {
        id: 18,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }],
      },
    }
    expect(planDesignParameters(blend)?.material).toBe(
      "50% cotton, 50% polyester"
    )
  })

  it("omits material rather than emitting an empty summary", () => {
    const plan = planDesignParameters(cap)
    expect(plan?.material).toBe("100% Cotton twill")

    const noMaterial: PrintfulCatalogVariant = {
      variant: { id: 19, color: "Red", color_code: "#ff0000", material: [] },
      product: {
        id: 20,
        techniques: [{ key: "dtg" }],
        files: [{ type: "front" }],
      },
    }
    expect(planDesignParameters(noMaterial)?.material).toBeUndefined()
  })
})
