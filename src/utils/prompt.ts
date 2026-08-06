import type { DesignParameters } from "./design"

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
      spec.apparel,
      "photorealistic, high detail",
      wear.framing,
    ]),
    label: design.color ?? noun,
    placement,
  }
}
