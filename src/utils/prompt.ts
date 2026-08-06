import type { DesignParameters, ProductDesignSummary } from "./design"

/**
 * Prompts for fashion-style mockups, built from what Printful actually says
 * about the product.
 *
 * The plugin writes prompts and stops there. Generation happens elsewhere —
 * Gemini, Midjourney, whatever you use — which keeps API keys, rate-limit
 * queues and image storage out of a repo that is otherwise a clean
 * Printful-to-Medusa integration.
 *
 * **Printful's own mockup generator does not do this job.** It renders the
 * product on a plain background: right for a catalogue thumbnail, wrong for
 * the editorial look these prompts target. That is a text-to-image task, and
 * the plugin's contribution is a prompt carrying true product facts rather
 * than plausible-sounding ones.
 */

/** How a mockup should look. Named for the reference rather than a mood word. */
export type PromptStyle = "editorial" | "studio" | "street"

export type PromptStyleSpec = {
  id: PromptStyle
  label: string
  /** Scene direction for a garment on a person. */
  apparel: string
  /** Scene direction for a printed object. */
  printMedia: string
}

export const PROMPT_STYLES: readonly PromptStyleSpec[] = [
  {
    id: "editorial",
    label: "Editorial",
    apparel:
      "editorial fashion photograph, natural window light, soft shadows, " +
      "muted neutral backdrop, relaxed candid pose, shot on 50mm at f/2",
    printMedia:
      "editorial interior photograph, natural window light, soft shadows, " +
      "calm minimal room, shot on 35mm",
  },
  {
    id: "studio",
    label: "Studio",
    apparel:
      "clean studio photograph, even softbox lighting, seamless light grey " +
      "backdrop, straight-on framing, sharp product focus",
    printMedia:
      "clean studio photograph, even softbox lighting, seamless light grey " +
      "backdrop, straight-on framing",
  },
  {
    id: "street",
    label: "Street",
    apparel:
      "street style photograph, overcast daylight, urban background slightly " +
      "out of focus, walking mid-stride, shot on 35mm",
    printMedia:
      "lifestyle photograph, daylight, lived-in interior, slight angle",
  },
] as const

/**
 * Where a design sits, said the way a photographer would rather than the way
 * an API does. `embroidery_front` is a field name; "the front panel" is an
 * instruction.
 */
const PLACEMENT_PHRASE: Record<string, string> = {
  front: "on the chest",
  back: "across the back",
  embroidery_front: "on the front panel",
  embroidery_back: "on the back panel",
  front_dtf: "on the chest",
  back_dtf: "across the back",
  default: "",
}

/**
 * Products where `front` does not mean a chest.
 *
 * One API placement name covers different physical places: `front` is the
 * chest of a tee and the outward face of a tote. A bag has no chest, and the
 * phrase sends the image somewhere the product is not.
 */
const PLACEMENT_OVERRIDES: Record<string, Record<string, string>> = {
  // Eco tote
  "367": {
    front: "on the front panel of the bag",
    back: "on the back panel of the bag",
    front_dtf: "on the front panel of the bag",
    back_dtf: "on the back panel of the bag",
  },
}

/**
 * What the technique means for how the design looks.
 *
 * The distinction is load-bearing rather than decorative. A cap supporting
 * only `EMBROIDERY` has no printed version — asking for a print produces an
 * image of a product that cannot be ordered.
 */
const TECHNIQUE_PHRASE: Record<string, string> = {
  DTG: "the artwork printed directly into the fabric, matte and slightly absorbed by the weave",
  DTFILM:
    "the artwork applied as a transfer, sitting just above the fabric with a clean edge",
  EMBROIDERY:
    "the artwork stitched in thread, raised off the surface with visible stitch texture",
  DIGITAL: "the artwork printed with crisp edges and full colour",
}

/**
 * How a product is held on a body, and what "the whole thing" means for it.
 *
 * A t-shirt is worn and framed full-length; a cap is worn but framed on the
 * head; a tote is carried, not worn at all. Asking for a "full garment" on
 * headwear requests something that is not in shot and pulls the framing wrong.
 */
type WearStyle = {
  noun: string
  /** The verb phrase: "wearing", "carrying". */
  verb: string
  /** What should be visible. Absent when "all of it" is not meaningful. */
  framing?: string
}

const WEAR: Record<string, WearStyle> = {
  "71": {
    noun: "unisex t-shirt",
    verb: "wearing",
    framing: "full garment visible",
  },
  "380": {
    noun: "unisex pullover hoodie",
    verb: "wearing",
    framing: "full garment visible",
  },
  "206": {
    noun: "structured dad cap",
    verb: "wearing",
    framing: "head and shoulders, cap front clearly readable",
  },
  "367": {
    noun: "canvas tote bag",
    verb: "carrying",
    framing: "bag held at the side or over the shoulder, front panel visible",
  },
}

const DEFAULT_WEAR: WearStyle = {
  noun: "garment",
  verb: "wearing",
  framing: "full garment visible",
}

/** Print-media nouns, which are never worn. */
const PRINT_NOUN: Record<string, string> = {
  "1": "matte paper poster",
  "2": "framed matte poster",
  "358": "die-cut vinyl sticker",
}

/**
 * How light a hex colour is, `0` (black) to `1` (white), or nothing.
 *
 * Uses the Rec. 709 luma weights rather than a plain channel average, because
 * the eye is not equally sensitive to the three channels: `#00ff00` and
 * `#0000ff` average identically and look nothing alike. Aqua `#008db5` is a
 * mid tone by luma and a dark one by naive average, and it is the tee's most
 * common colour.
 *
 * Returns `undefined` on anything it cannot parse — never `0`. Absence has to
 * stay distinguishable from black, exactly as it does in `normalizeHex`: a
 * malformed value falling through to `0` would silently be styled as a dark
 * garment.
 */
export function hexLightness(
  raw: string | null | undefined
): number | undefined {
  const value = raw?.trim()
  if (!value) {
    return undefined
  }

  const body = value.startsWith("#") ? value.slice(1) : value
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(body)) {
    return undefined
  }

  const full =
    body.length === 3
      ? body
          .split("")
          .map((c) => c + c)
          .join("")
      : body

  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)

  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * What else the model wears, keyed by how light the garment is.
 *
 * **A table, not colour theory.** A merchant can read this file and predict
 * what a new colour will produce, which an inferred palette would not allow.
 * Tuning it is editing four strings.
 *
 * The bands, and why they fall where they do:
 *
 * - **`< 0.22` dark** — black, navy, forest. The reference look (Bershka, H&M)
 *   puts these against light denim and off-white, so the garment stays the
 *   lightest-contrast object in frame and the artwork keeps its edge.
 * - **`0.22 – 0.55` mid** — Aqua `#008db5` sits at 0.44, as do heather greys
 *   and most of the tee's saturated colours. A mid tone reads against either
 *   extreme, so it gets neutral denim, which is what an actual lookbook does.
 * - **`> 0.55` light** — white, cream, Oyster `#edcea5` at 0.82. These need a
 *   darker layer or the model dissolves into the backdrop; every style preset
 *   here specifies a light or neutral background.
 *
 * Two thresholds rather than more: each extra band is another wording an
 * admin has to hold in their head, and the returned image barely distinguishes
 * them.
 */
const PAIRING_BANDS: ReadonlyArray<{ below: number; wears: string }> = [
  {
    below: 0.22,
    wears: "light washed denim and off-white sneakers",
  },
  {
    below: 0.55,
    wears: "neutral straight-leg denim and plain white sneakers",
  },
  {
    below: Infinity,
    wears: "dark charcoal trousers and a deep indigo overshirt",
  },
]

/**
 * Products that get no styling clause, and why each one.
 *
 * - **Print media** never reaches this code — a poster is not styled with
 *   jeans, and its branch returns before pairing is considered.
 * - **The cap (206)** is worn, so it is not excluded for being unwearable. It
 *   is excluded because the styling clause exists to dress the model *around*
 *   the garment carrying the design, and a hat is the accessory to an outfit
 *   rather than the outfit. Naming trousers next to a cap makes the trousers
 *   compete with the thing being photographed, and the cap's framing is
 *   already "head and shoulders" — the trousers are not even in shot.
 * - **The tote (367)** is carried, not worn. Same reasoning: it is the
 *   accessory, and "A model carrying a tote, styled with denim" describes an
 *   outfit the prompt is not otherwise specifying.
 */
const NO_PAIRING_PRODUCTS = new Set(["206", "367"])

/**
 * The styling clause, or nothing.
 *
 * Nothing is the answer whenever the base colour is unknown. Choosing a
 * companion for a colour Printful did not report is the same class of mistake
 * as guessing the material: it puts an unverified claim into a prompt where
 * nothing marks it as invented.
 */
function pairingClause(design: DesignParameters): string | undefined {
  if (
    design.catalogProductId &&
    NO_PAIRING_PRODUCTS.has(design.catalogProductId)
  ) {
    return undefined
  }

  const lightness = hexLightness(design.colorHex)
  if (lightness === undefined) {
    return undefined
  }

  const band = PAIRING_BANDS.find((b) => lightness < b.below)
  return band ? `styled with ${band.wears}` : undefined
}

/**
 * "an Aqua", not "a Aqua". A prompt is read by a language model, and the
 * mismatched article is the tell that a template assembled it.
 */
const article = (word: string): string =>
  /^[aeiou]/i.test(word.trim()) ? "an" : "a"

export type MockupPrompt = {
  /** Paste-ready prompt text. */
  text: string
  /** What varies between prompts for one product — the colour, usually. */
  label: string
  placement: string
}

export type BuildPromptInput = {
  design: DesignParameters
  /** Which placement this prompt is for. */
  placement: string
  style?: PromptStyle
  /** What the artwork is, if you want it named. Optional and never invented. */
  artwork?: string
}

/** Joins the parts that exist, so an absent fact leaves no trace. */
const sentence = (parts: Array<string | undefined | null>): string =>
  parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join(", ")

const styleSpec = (style?: PromptStyle): PromptStyleSpec =>
  PROMPT_STYLES.find((s) => s.id === style) ?? PROMPT_STYLES[0]

/**
 * Build one prompt for one product, colour and placement.
 *
 * Every clause is dropped rather than defaulted when the parameter is absent.
 * A prompt is a description of a real product; a placeholder in it is a claim
 * Printful never made, and the resulting image would sell something that does
 * not exist.
 */
export function buildMockupPrompt(input: BuildPromptInput): MockupPrompt {
  const { design, placement, artwork } = input
  const spec = styleSpec(input.style)

  const wear =
    (design.catalogProductId && WEAR[design.catalogProductId]) || DEFAULT_WEAR
  const noun =
    design.productClass === "print_media"
      ? ((design.catalogProductId && PRINT_NOUN[design.catalogProductId]) ??
        "print")
      : wear.noun

  const technique = design.technique
    ? TECHNIQUE_PHRASE[design.technique.toUpperCase()]
    : undefined

  const overrides = design.catalogProductId
    ? PLACEMENT_OVERRIDES[design.catalogProductId]
    : undefined
  const where = overrides?.[placement] ?? PLACEMENT_PHRASE[placement] ?? ""
  const artworkClause = artwork
    ? `the artwork ${where ? `${where}: ` : "showing: "}${artwork}`
    : where
      ? `the design placed ${where}`
      : undefined

  if (design.productClass === "print_media") {
    // No model, no fabric, no base colour — a print's variables are its size
    // and how it hangs. `size` is this variant's real dimensions; the
    // product's `dimensions` table lists every size offered and would name one
    // the customer is not buying.
    return {
      text: sentence([
        `${article(noun).replace(/^a/, "A")} ${noun}${design.size ? ` measuring ${design.size}` : ""}`,
        artworkClause,
        technique,
        "hanging on a plain wall in a bright interior",
        spec.printMedia,
        "photorealistic, high detail",
      ]),
      label: design.size ?? "print",
      placement,
    }
  }

  const colour = design.color
    ? `${design.color}${design.colorHex ? ` (${design.colorHex})` : ""}`
    : undefined

  // The article agrees with whatever word actually follows it — the colour
  // when there is one, the noun otherwise.
  const subject = `${colour ? `${colour} ` : ""}${noun}`

  return {
    text: sentence([
      `A model ${wear.verb} ${article(subject)} ${subject}`,
      design.material ? `made of ${design.material}` : undefined,
      artworkClause,
      technique,
      // After the technique and before the scene: the outfit is context for
      // the garment, not a competing subject. Dropped entirely when the base
      // colour is unknown.
      pairingClause(design),
      spec.apparel,
      "photorealistic, high detail",
      wear.framing,
    ]),
    label: design.color ?? noun,
    placement,
  }
}

/**
 * How many mockups one product is worth.
 *
 * The store shoots 4–5 per product, so that is the ceiling. Not a knob: it is
 * the number that makes the panel readable, and a route that answered with 84
 * would be answering a question nobody asked.
 */
const MAX_PROMPTS_PER_PRODUCT = 5

/**
 * Pick which colours to build prompts for.
 *
 * The tee carries 84 colours and the store sells three or four of them. The
 * useful selection is not "the first five Printful listed" — that ordering is
 * the catalog's, and its first five are frequently near-identical greys, which
 * is the same mockup rendered five times.
 *
 * So the pick is **spread across the lightness range**: sort by luma, then take
 * evenly spaced entries including both ends. The store is deciding which
 * colourway to shoot, and what it needs to see is the extremes and the middle —
 * the darkest, the lightest, and the tones between. It is also stable: the same
 * catalog produces the same five prompts every time the page is opened, so a
 * prompt an admin copied yesterday is still there today.
 *
 * Colours with no hex sort last rather than being dropped. They still make a
 * valid prompt — one without a styling clause — and dropping them would hide a
 * colourway the store actually sells.
 */
function pickColors(
  colors: ProductDesignSummary["colors"],
  limit: number
): ProductDesignSummary["colors"] {
  if (colors.length <= limit) {
    return colors
  }

  const sorted = [...colors].sort((a, b) => {
    const la = hexLightness(a.hex)
    const lb = hexLightness(b.hex)
    if (la === undefined && lb === undefined) {
      return 0
    }
    // Unknown lightness cannot be placed on the scale, so it goes to the end
    // rather than being treated as black.
    if (la === undefined) {
      return 1
    }
    if (lb === undefined) {
      return -1
    }
    return la - lb
  })

  // Evenly spaced across the sorted range, both ends included.
  const step = (sorted.length - 1) / (limit - 1)
  const picked: ProductDesignSummary["colors"] = []
  const seen = new Set<number>()
  for (let i = 0; i < limit; i++) {
    const index = Math.round(i * step)
    if (!seen.has(index)) {
      seen.add(index)
      picked.push(sorted[index])
    }
  }
  return picked
}

export type BuildProductPromptsInput = {
  design: ProductDesignSummary
  style?: PromptStyle
  /** What the artwork is. Optional; never invented when absent. */
  artwork?: string
  /** Ceiling on how many prompts to return. Defaults to five. */
  limit?: number
}

/**
 * Every prompt worth showing for one product.
 *
 * Built from the summary the design route already produces, so this costs no
 * Printful call — the sync paid for the catalog lookups once.
 *
 * The axis that varies is whatever actually varies on the product: colour for
 * apparel and embroidery, physical size for print media, which has no base
 * colour by construction. Placement is the product's first core placement
 * rather than every placement it offers — the tee exposes 17, and a page
 * listing front, back, both sleeves and four DTF variants for each of five
 * colours is 85 prompts nobody reads. The core placement is where the design
 * goes; the rest are available, not intended.
 *
 * Returns an empty list when the product has no placement at all, which is the
 * honest answer for a product whose design has nowhere to sit.
 */
export function buildProductPrompts(
  input: BuildProductPromptsInput
): MockupPrompt[] {
  const { design, style, artwork } = input
  const limit = Math.max(1, input.limit ?? MAX_PROMPTS_PER_PRODUCT)

  const placement = design.core_placements[0] ?? design.placements[0]
  if (!placement) {
    return []
  }

  /** The product-level facts, identical on every variant. */
  const base: DesignParameters = {
    productClass: design.product_class,
    ...(design.technique ? { technique: design.technique } : {}),
    techniques: design.techniques,
    corePlacements: design.core_placements,
    placements: design.placements,
    ...(design.material ? { material: design.material } : {}),
    ...(design.brand ? { brand: design.brand } : {}),
    ...(design.model ? { model: design.model } : {}),
    ...(design.dimensions ? { dimensions: design.dimensions } : {}),
    // What lets the prompt name the product — "unisex t-shirt" rather than
    // the "garment" fallback, and what selects its wear verb and framing.
    ...(design.catalog_product_id
      ? { catalogProductId: design.catalog_product_id }
      : {}),
  }

  if (design.product_class === "print_media") {
    // Size is the axis. The first few sizes rather than a spread: unlike
    // colour, sizes arrive in a meaningful order and the small ones are what
    // a store leads with.
    const sizes = design.sizes.slice(0, limit)
    const chosen = sizes.length > 0 ? sizes : [undefined]
    return chosen.map((size) =>
      buildMockupPrompt({
        design: { ...base, ...(size ? { size } : {}) },
        placement,
        style,
        artwork,
      })
    )
  }

  const colors = pickColors(design.colors, limit)
  const chosen =
    colors.length > 0 ? colors : [{ name: undefined, hex: undefined }]

  return chosen.map((color) =>
    buildMockupPrompt({
      design: {
        ...base,
        ...(color.name ? { color: color.name } : {}),
        ...(color.hex ? { colorHex: color.hex } : {}),
      },
      placement,
      style,
      artwork,
    })
  )
}
