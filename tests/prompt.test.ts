import { describe, expect, it } from "vitest"
import { buildMockupPrompt, hexLightness } from "../src/utils/prompt"
import type { DesignParameters } from "../src/utils/design"

/** The real parameters for the seven products, as the catalog reports them. */
const tee: DesignParameters = {
  productClass: "apparel",
  technique: "DTG",
  techniques: ["DTG"],
  corePlacements: ["front", "back"],
  placements: ["front", "back", "front_dtf"],
  color: "Aqua",
  colorHex: "#008db5",
  size: "L",
  material: "100% combed ring spun cotton",
  brand: "Bella + Canvas",
  model: "3001",
  catalogProductId: "71",
}

const cap: DesignParameters = {
  productClass: "embroidery",
  technique: "EMBROIDERY",
  techniques: ["EMBROIDERY"],
  corePlacements: ["embroidery_front"],
  placements: ["embroidery_front", "embroidery_back"],
  color: "Black",
  colorHex: "#000000",
  brand: "Yupoong",
  model: "6245CM",
  catalogProductId: "206",
}

const poster: DesignParameters = {
  productClass: "print_media",
  technique: "DIGITAL",
  techniques: ["DIGITAL"],
  corePlacements: ["default"],
  placements: ["default"],
  size: "11.69″×16.54″",
  model: "Paper Poster (in) | Matte",
  catalogProductId: "1",
}

describe("buildMockupPrompt — apparel", () => {
  it("names the garment, its colour and where the design sits", () => {
    const p = buildMockupPrompt({ design: tee, placement: "front" })

    expect(p.text).toContain("Aqua")
    expect(p.text).toContain("#008db5")
    // "on the chest", not "front" — the API's field name is not an
    // instruction an image model can act on.
    expect(p.text.toLowerCase()).toContain("on the chest")
  })

  it("says the fabric, because it changes how a print reads", () => {
    const p = buildMockupPrompt({ design: tee, placement: "front" })
    expect(p.text).toContain("combed ring spun cotton")
  })

  it("asks for a person, since a garment on a model is the point", () => {
    const p = buildMockupPrompt({ design: tee, placement: "front" })
    expect(p.text.toLowerCase()).toMatch(/model|person|wearing/)
  })
})

describe("buildMockupPrompt — embroidery", () => {
  it("describes thread, never ink", () => {
    // The failure this exists to prevent. The cap supports EMBROIDERY only;
    // a prompt calling it printed describes an object Printful cannot make.
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })

    expect(p.text.toLowerCase()).toMatch(/embroider|stitch|thread/)
    expect(p.text.toLowerCase()).not.toMatch(/\bprinted\b|\bink\b|screen print/)
  })

  it("does not ask for a flat print texture on a stitched product", () => {
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })
    expect(p.text.toLowerCase()).not.toContain("dtg")
  })
})

describe("buildMockupPrompt — print media", () => {
  it("uses the variant's real size, not the product's size table", () => {
    // planDesignParameters carries both: `size` is this variant's actual
    // dimensions, `dimensions` is the first key of a table listing every size
    // the product offers. Quoting the table would state a size the customer
    // is not buying.
    const p = buildMockupPrompt({ design: poster, placement: "default" })

    expect(p.text).toContain("11.69″×16.54″")
    expect(p.text).not.toContain("8×10")
  })

  it("frames it as an object on a wall, with no model or fabric", () => {
    const p = buildMockupPrompt({ design: poster, placement: "default" })

    expect(p.text.toLowerCase()).toMatch(/wall|framed|interior|hanging/)
    expect(p.text.toLowerCase()).not.toMatch(/cotton|fabric|wearing/)
  })

  it("never claims a base colour print media does not have", () => {
    const p = buildMockupPrompt({ design: poster, placement: "default" })
    expect(p.text.toLowerCase()).not.toMatch(/base colou?r/)
  })
})

describe("buildMockupPrompt — what it refuses to invent", () => {
  it("omits the material when Printful reported none", () => {
    // The cap has no material in the catalog. A prompt that guesses "cotton"
    // is making a claim about a product nobody verified.
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })
    expect(p.text.toLowerCase()).not.toContain("cotton")
  })

  it("omits the hex when the catalog did not report one", () => {
    const noHex: DesignParameters = { ...tee, colorHex: undefined }
    const p = buildMockupPrompt({ design: noHex, placement: "front" })

    expect(p.text).toContain("Aqua")
    expect(p.text).not.toContain("#")
  })

  it("still produces a usable prompt from the barest parameters", () => {
    const bare: DesignParameters = {
      productClass: "apparel",
      techniques: [],
      corePlacements: [],
      placements: [],
    }
    const p = buildMockupPrompt({ design: bare, placement: "front" })

    expect(p.text.length).toBeGreaterThan(40)
    expect(p.text).not.toContain("undefined")
    expect(p.text).not.toContain("null")
  })
})

describe("buildMockupPrompt — phrasing that betrays a template", () => {
  it("says 'an Aqua' rather than 'a Aqua'", () => {
    // A prompt is read by a language model. "a Aqua t-shirt" is the tell that
    // a template assembled it, and degrades what comes back.
    const p = buildMockupPrompt({ design: tee, placement: "front" })
    expect(p.text).not.toMatch(/\ba [aeiou]/i)
  })

  it("does not ask for a full garment when the product is a cap", () => {
    // "full garment visible" makes sense for a tee. On headwear it asks for
    // something that is not there, and pulls the framing wrong.
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })
    expect(p.text.toLowerCase()).not.toContain("full garment")
  })

  it("frames a tote as carried, not worn", () => {
    const tote: DesignParameters = {
      productClass: "apparel",
      technique: "DTG",
      techniques: ["DTG"],
      corePlacements: ["front", "back"],
      placements: ["front", "back"],
      color: "Oyster",
      colorHex: "#dcd7c9",
      brand: "Econscious",
      model: "EC8000",
      catalogProductId: "367",
    }
    const p = buildMockupPrompt({ design: tote, placement: "front" })
    expect(p.text.toLowerCase()).toMatch(
      /carry|carrying|held|over the shoulder/
    )
  })
})

describe("buildMockupPrompt — placement phrasing follows the product", () => {
  const tote: DesignParameters = {
    productClass: "apparel",
    technique: "DTG",
    techniques: ["DTG"],
    corePlacements: ["front", "back"],
    placements: ["front", "back"],
    color: "Oyster",
    colorHex: "#edcea5",
    catalogProductId: "367",
  }

  it("puts a tote's design on its panel, not on a chest", () => {
    // `front` is one API name meaning different physical places. A bag has no
    // chest, and the phrase sends the image somewhere the product is not.
    const p = buildMockupPrompt({ design: tote, placement: "front" })

    expect(p.text.toLowerCase()).not.toContain("on the chest")
    expect(p.text.toLowerCase()).toMatch(/panel|face of the bag|on the front/)
  })

  it("still puts a t-shirt's front design on the chest", () => {
    const p = buildMockupPrompt({ design: tee, placement: "front" })
    expect(p.text.toLowerCase()).toContain("on the chest")
  })
})

describe("hexLightness", () => {
  it("reads a six-digit hex", () => {
    expect(hexLightness("#000000")).toBe(0)
    // The luma weights are floats and do not sum to exactly 1.
    expect(hexLightness("#ffffff")).toBeCloseTo(1)
  })

  it("accepts the short form and a missing hash", () => {
    // Printful is consistent, but the value passes through variant metadata
    // that a host app can write to. Both forms are valid CSS hex.
    expect(hexLightness("#fff")).toBeCloseTo(1)
    expect(hexLightness("008db5")).toBeCloseTo(
      hexLightness("#008db5") as number
    )
  })

  it("returns undefined rather than throwing on malformed input", () => {
    // Absence has to stay distinguishable from black. A helper that returned
    // 0 here would make every unparseable colour a dark garment and hand it
    // the light-companion pairing, which is a claim nobody verified.
    expect(hexLightness("")).toBeUndefined()
    expect(hexLightness("nothing")).toBeUndefined()
    expect(hexLightness("#ff")).toBeUndefined()
    expect(hexLightness("#gggggg")).toBeUndefined()
    expect(hexLightness(undefined)).toBeUndefined()
  })
})

describe("buildMockupPrompt — pairing", () => {
  /** The styling clause, as the prompt introduces it. */
  const stylingClause = (text: string): string | undefined =>
    text.split(", ").find((c) => c.startsWith("styled with "))

  it("gives a dark tee light companions", () => {
    const black: DesignParameters = {
      ...tee,
      color: "Black",
      colorHex: "#000000",
    }
    const clause = stylingClause(
      buildMockupPrompt({ design: black, placement: "front" }).text
    )

    expect(clause).toBeDefined()
    // The direction, not the wording. The table is meant to be tuned.
    expect(clause?.toLowerCase()).toMatch(/light|pale|cream|ecru|white|washed/)
    expect(clause?.toLowerCase()).not.toMatch(/dark|charcoal|black|deep/)
  })

  it("gives a light tee darker companions", () => {
    const oyster: DesignParameters = {
      ...tee,
      color: "Oyster",
      colorHex: "#edcea5",
    }
    const clause = stylingClause(
      buildMockupPrompt({ design: oyster, placement: "front" }).text
    )

    expect(clause).toBeDefined()
    expect(clause?.toLowerCase()).toMatch(/dark|charcoal|black|deep|indigo/)
    expect(clause?.toLowerCase()).not.toMatch(/pale|cream|ecru|off-white/)
  })

  it("says nothing about styling when the catalog reported no hex", () => {
    // Same rule as the material: a companion chosen for an unknown base colour
    // is a guess, and a guess in a prompt becomes an image of a product nobody
    // verified. The clause is dropped, not defaulted.
    const noHex: DesignParameters = { ...tee, colorHex: undefined }
    const p = buildMockupPrompt({ design: noHex, placement: "front" })

    expect(p.text).not.toContain("styled with")
  })

  it("does not style a poster with clothes", () => {
    const p = buildMockupPrompt({ design: poster, placement: "default" })
    expect(p.text).not.toContain("styled with")
  })

  it("does not style a cap with trousers", () => {
    // The cap has a hex, so the guard here is the product, not the colour.
    // The styling clause dresses the model around the garment carrying the
    // design; a hat is worn *with* an outfit the prompt is not describing.
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })
    expect(p.text).not.toContain("styled with")
  })

  it("does not reintroduce ink onto an embroidered product", () => {
    const p = buildMockupPrompt({ design: cap, placement: "embroidery_front" })
    expect(p.text.toLowerCase()).not.toMatch(/\bprinted\b|\bink\b/)
  })
})
