import type {
  PrintfulCatalogVariant,
  PrintfulMaterial,
  PrintfulSyncVariant,
} from "./types"
import type { MedusaVariantInput } from "./mappers"

/**
 * What kind of thing a design lands on. Derived from the techniques and
 * placements Printful reports, never from a catalog id — the store adds a
 * product every so often, and a hardcoded id list silently misclassifies the
 * next one as whatever the fallback happens to be.
 *
 * - `apparel` — ink or film on fabric (DTG or DTF). Has a base colour.
 * - `embroidery` — thread only. The cap: EMBROIDERY, possibly DTF, no DTG.
 * - `print_media` — DIGITAL. Paper and vinyl: physical size, no base colour.
 * - `unknown` — the data does not justify any of the above.
 */
export type ProductClass = "apparel" | "embroidery" | "print_media" | "unknown"

/**
 * The placements a design actually uses, per class. A tee exposes 17; these
 * are the ones the admin should lead with.
 *
 * `embroidery_front` is why this is a table and not a front/back filter: the
 * cap has no `front` placement at all, so filtering on front/back returns an
 * empty list for a product that plainly has somewhere to put a design.
 */
export const PLACEMENTS_BY_CLASS: Record<
  Exclude<ProductClass, "unknown">,
  readonly string[]
> = {
  apparel: ["front", "back"],
  embroidery: ["embroidery_front"],
  print_media: ["default"],
}

/**
 * Placement ids that are not print areas. Printful returns mockup and preview
 * entries in the same `files` list as real placements.
 */
const NON_PLACEMENT_TYPES = new Set(["preview", "mockup", "template"])

/** Printful technique keys, normalized to the names a human uses. */
const TECHNIQUE_NAMES: Record<string, string> = {
  dtg: "DTG",
  dtfilm: "DTF",
  dtf: "DTF",
  embroidery: "EMBROIDERY",
  digital: "DIGITAL",
  cut_sew: "CUT_SEW",
  sublimation: "SUBLIMATION",
  uv: "UV",
}

/**
 * Techniques that mean the design is *printed* onto fabric.
 *
 * DTF is deliberately absent. The cap supports EMBROIDERY and DTF and no DTG,
 * and DTF alone is an accessory transfer Printful offers almost everywhere —
 * treating it as evidence of apparel is exactly what turns the cap into a
 * garment with front/back placements it does not have. DTG (or sublimation) is
 * the technique that says "this is a printable garment".
 */
const PRINTED_ON_FABRIC = new Set(["dtg", "sublimation"])

/** Film transfer. Supported broadly; never on its own evidence of a class. */
const FILM = new Set(["dtfilm", "dtf"])

function techniqueKeys(variant: PrintfulCatalogVariant): string[] {
  const keys: string[] = []
  for (const t of variant.product?.techniques ?? []) {
    const key = t?.key?.trim().toLowerCase()
    if (key) {
      keys.push(key)
    }
  }
  return keys
}

function normalizeTechnique(key: string): string {
  return TECHNIQUE_NAMES[key] ?? key.toUpperCase()
}

/**
 * Decide the product class from what Printful says the variant supports.
 *
 * Order matters. `print_media` is checked before the fabric classes because
 * DIGITAL is the only technique a poster or sticker reports, and a store that
 * later stocks a DIGITAL-plus-DTG product is a garment, not paper.
 *
 * A variant with no techniques returns `unknown` rather than defaulting to
 * apparel. Guessing here would put front/back placements on something that may
 * have neither, and an admin reading a confident wrong answer is worse off
 * than one reading no answer.
 */
export function classifyProduct(
  variant: PrintfulCatalogVariant | null | undefined
): ProductClass {
  if (!variant) {
    return "unknown"
  }

  const keys = techniqueKeys(variant)
  if (keys.length === 0) {
    return "unknown"
  }

  const set = new Set(keys)
  const hasPrintOnFabric = keys.some((k) => PRINTED_ON_FABRIC.has(k))
  const hasFilm = keys.some((k) => FILM.has(k))
  const hasEmbroidery = set.has("embroidery")

  // Paper and vinyl: DIGITAL and nothing that touches fabric.
  if (set.has("digital") && !hasPrintOnFabric && !hasFilm && !hasEmbroidery) {
    return "print_media"
  }

  // Ink on fabric wins over thread: a tee supports embroidery too, but its
  // design goes on with DTG.
  if (hasPrintOnFabric) {
    return "apparel"
  }

  // Thread, with no DTG anywhere. The cap. DTF may sit alongside it and does
  // not make this apparel — the placement is `embroidery_front`, not `front`.
  if (hasEmbroidery) {
    return "embroidery"
  }

  // Film and nothing else: still a print on fabric, just not a direct one.
  if (hasFilm) {
    return "apparel"
  }

  return "unknown"
}

/** Every real print placement the variant offers, mockups excluded. */
export function placementsFor(
  variant: PrintfulCatalogVariant | null | undefined
): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const f of variant?.product?.files ?? []) {
    // `type`, not `id`. Printful names the primary placement `id: "default"`
    // on every product and puts the meaning in `type` — a tee's default is
    // `front`, a cap's is `embroidery_front`. Reading `id` therefore collapses
    // every product's main placement to the same meaningless "default", which
    // matched nothing in the core lists and left the cap with no placement at
    // all. Verified against the live catalog for variants 4025 and 7853.
    const id = (f?.type ?? f?.id)?.trim()
    if (!id || NON_PLACEMENT_TYPES.has(id.toLowerCase()) || seen.has(id)) {
      continue
    }
    seen.add(id)
    out.push(id)
  }

  return out
}

/**
 * The placements a design actually uses on this variant: the class's core
 * list, intersected with what the variant really offers.
 *
 * The intersection is what keeps this honest in both directions. It never
 * invents a `back` on a front-only garment, and — because the table is keyed
 * by class rather than hardcoded to front/back — it never returns an empty
 * list for the cap, whose only placement is `embroidery_front`.
 */
export function corePlacementsFor(
  variant: PrintfulCatalogVariant | null | undefined
): string[] {
  const productClass = classifyProduct(variant)
  if (productClass === "unknown") {
    return []
  }

  const available = new Set(placementsFor(variant))
  return PLACEMENTS_BY_CLASS[productClass].filter((p) => available.has(p))
}

/**
 * A hex colour, or nothing.
 *
 * Never returns `""`. An empty string renders as a black swatch, which tells
 * the admin the shirt is black when in truth Printful did not say. Absence has
 * to stay distinguishable from black.
 */
function normalizeHex(raw: string | null | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) {
    return undefined
  }

  const body = value.startsWith("#") ? value.slice(1) : value
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(body)) {
    return undefined
  }

  return `#${body.toLowerCase()}`
}

/** "100% Airlume cotton", "50% cotton, 50% polyester", or nothing. */
function summarizeMaterial(
  material: PrintfulMaterial[] | undefined
): string | undefined {
  const parts: string[] = []

  for (const m of material ?? []) {
    const name = m?.name?.trim()
    if (!name) {
      continue
    }
    parts.push(m.percentage != null ? `${m.percentage}% ${name}` : name)
  }

  return parts.length ? parts.join(", ") : undefined
}

/**
 * The physical size of a print medium, when Printful states one.
 *
 * `dimensions` is keyed by size on posters and by placement on stickers, so
 * the variant's own size is tried as a key first and a single-entry map falls
 * through to its only value.
 */
function physicalDimensions(
  variant: PrintfulCatalogVariant
): string | undefined {
  const dims = variant.product?.dimensions
  if (!dims) {
    return undefined
  }

  const size = variant.variant?.size?.trim()
  if (size && dims[size]) {
    return dims[size]
  }

  const values = Object.values(dims).filter((v) => typeof v === "string" && v)
  return values.length === 1 ? values[0] : values[0] || undefined
}

/**
 * Everything the admin needs to see how a design lands on one variant.
 *
 * Every field beyond `productClass` is optional and omitted rather than
 * defaulted. This object is displayed as-is and later fed to a prompt, and a
 * placeholder in either place is a claim about the garment that Printful never
 * made.
 */
export type DesignParameters = {
  productClass: Exclude<ProductClass, "unknown">
  /** The technique the design is actually made with — the default one. */
  technique?: string
  /** Every technique the variant supports, default first. */
  techniques: string[]
  /** Core placements, already intersected with what the variant offers. */
  corePlacements: string[]
  /** Every real print placement. Superset of `corePlacements`. */
  placements: string[]
  /** Colour name. Absent on print media, which has no meaningful base colour. */
  color?: string
  /** `#008db5`. Never `""` — absence must not render as black. */
  colorHex?: string
  size?: string
  /** "100% Airlume cotton". Absent when Printful reports no material. */
  material?: string
  brand?: string
  model?: string
  /** Physical size, e.g. `3" × 3"`. Print media only. */
  dimensions?: string
  /** Printful catalog product id, for tracing back. */
  catalogProductId?: string
}

function orderedTechniques(variant: PrintfulCatalogVariant): {
  technique?: string
  techniques: string[]
} {
  const list = variant.product?.techniques ?? []
  const named: string[] = []
  let defaultName: string | undefined

  for (const t of list) {
    const key = t?.key?.trim().toLowerCase()
    if (!key) {
      continue
    }
    const name = normalizeTechnique(key)
    if (!named.includes(name)) {
      named.push(name)
    }
    if (t.is_default && !defaultName) {
      defaultName = name
    }
  }

  // No explicit default: the first technique listed is the one Printful leads
  // with, and it is a better answer than none.
  return { technique: defaultName ?? named[0], techniques: named }
}

/**
 * Build the design parameters for a catalog variant.
 *
 * Returns `null` when the variant cannot be classified. The caller is a
 * best-effort sync enrichment: writing a half-guessed object into variant
 * metadata would put an unfounded claim in front of the admin and into a
 * later prompt, where nothing distinguishes it from a verified one.
 */
export function planDesignParameters(
  variant: PrintfulCatalogVariant | null | undefined
): DesignParameters | null {
  if (!variant) {
    return null
  }

  const productClass = classifyProduct(variant)
  if (productClass === "unknown") {
    return null
  }

  const { technique, techniques } = orderedTechniques(variant)
  const isPrintMedia = productClass === "print_media"

  // Print media reports the stock's own colour — a poster is "White #ffffff".
  // That is the paper, not a design parameter, and showing it as a swatch
  // reads as a choice someone made.
  const color = isPrintMedia ? undefined : variant.variant?.color?.trim()
  const colorHex = isPrintMedia
    ? undefined
    : normalizeHex(variant.variant?.color_code)

  return {
    productClass,
    ...(technique ? { technique } : {}),
    techniques,
    corePlacements: corePlacementsFor(variant),
    placements: placementsFor(variant),
    ...(color ? { color } : {}),
    ...(colorHex ? { colorHex } : {}),
    ...(variant.variant?.size?.trim()
      ? { size: variant.variant.size.trim() }
      : {}),
    ...(summarizeMaterial(variant.variant?.material)
      ? { material: summarizeMaterial(variant.variant?.material) }
      : {}),
    ...(variant.product?.brand?.trim()
      ? { brand: variant.product.brand.trim() }
      : {}),
    ...(variant.product?.model?.trim()
      ? { model: variant.product.model.trim() }
      : {}),
    ...(isPrintMedia && physicalDimensions(variant)
      ? { dimensions: physicalDimensions(variant) }
      : {}),
    ...(variant.product?.id != null
      ? { catalogProductId: String(variant.product.id) }
      : {}),
  }
}

/**
 * Where design parameters live in variant metadata.
 *
 * Nested under one key rather than spread as `printful_design_color`,
 * `printful_design_color_hex`, … The existing flat keys — `printful_store_id`,
 * `printful_availability_status` — are each a single scalar the plugin reads
 * back individually. This is one cohesive record read as a whole by one admin
 * panel, and a dozen sibling keys would triple the width of every variant's
 * metadata for no lookup that wants them separately. The `printful_design_`
 * prefix is kept on the container so the namespace still reads at a glance.
 */
export const DESIGN_METADATA_KEY = "printful_design"

/**
 * The identity of one catalog probe.
 *
 * This is the whole stampede defence, so it is a named function with its own
 * tests rather than an inline template string.
 *
 * A tee is 84 colours across 9 sizes — 756 sync variants, each with its own
 * catalog variant id. Asking the catalog about every one is 756 HTTP calls for
 * a product whose technique, placements, brand and model are identical across
 * all of them, and whose hex is identical across the sizes of a colour. So the
 * probe is keyed by product and colour: 84 calls, not 756. Size is deliberately
 * not part of the key — it is the axis that varies without changing any answer
 * the catalog gives us, and it already arrives free on the sync variant.
 */
export function designProbeKey(input: {
  syncProductId: string
  color?: string | null
}): string {
  const color = input.color?.trim().toLowerCase() ?? ""
  return `${input.syncProductId}::${color}`
}

/**
 * Memoizes catalog lookups by probe key for the life of one sync.
 *
 * Caches the *promise*, not the result, so two variants of the same colour
 * reaching this concurrently share one in-flight request instead of racing to
 * start two. Caches `null` answers too — a blank the catalog fails on must
 * cost one call, not one per variant that shares it.
 */
export class CatalogVariantCache {
  private readonly entries = new Map<
    string,
    Promise<PrintfulCatalogVariant | null>
  >()
  private made = 0

  constructor(
    private readonly fetchVariant: (
      catalogVariantId: string
    ) => Promise<PrintfulCatalogVariant | null>
  ) {}

  /** How many catalog calls were actually issued. For logging and tests. */
  get calls(): number {
    return this.made
  }

  async get(
    key: string,
    catalogVariantId: string | number
  ): Promise<PrintfulCatalogVariant | null> {
    const cached = this.entries.get(key)
    if (cached) {
      return cached
    }

    this.made += 1
    // Never let a rejection escape: this is a best-effort enrichment and the
    // sync must survive a catalog that throws rather than returns null.
    const pending = this.fetchVariant(String(catalogVariantId)).catch(
      () => null
    )
    this.entries.set(key, pending)
    return pending
  }
}

export type EnrichDesignOptions = {
  /** Printful sync product id — scopes the probe key to this product. */
  syncProductId: string
  getCatalogVariant: (
    catalogVariantId: string
  ) => Promise<PrintfulCatalogVariant | null>
  /** Pass one across products to dedupe a blank two products share. */
  cache?: CatalogVariantCache
}

/**
 * Attach design parameters to already-mapped Medusa variants.
 *
 * Best-effort throughout. A `null` from the catalog, a variant with no catalog
 * id, or a variant the classifier cannot place all leave the variant exactly as
 * it arrived — importable, with its price, title and every other metadata key
 * untouched. The key is omitted entirely rather than written as `null`, so
 * "we never asked" and "we asked and learned nothing" do not render alike.
 *
 * `variants` and `syncVariants` are positionally paired, which is how the
 * mapper produces them.
 */
export async function enrichVariantsWithDesign(
  variants: MedusaVariantInput[],
  syncVariants: PrintfulSyncVariant[],
  options: EnrichDesignOptions
): Promise<MedusaVariantInput[]> {
  const cache =
    options.cache ?? new CatalogVariantCache(options.getCatalogVariant)

  return Promise.all(
    variants.map(async (variant, i) => {
      const sync = syncVariants[i]
      const catalogVariantId = sync?.variant_id

      // Nothing to look up. Printful leaves `variant_id` unset on sync
      // variants it never bound to a catalog blank.
      if (catalogVariantId == null || catalogVariantId === 0) {
        return variant
      }

      const key = designProbeKey({
        syncProductId: options.syncProductId,
        color: sync?.color,
      })

      const catalog = await cache.get(key, catalogVariantId)
      if (!catalog) {
        return variant
      }

      const plan = planDesignParameters(catalog)
      if (!plan) {
        return variant
      }

      // The probe answered for one arbitrary size of this colour, so its size
      // is not this variant's. Everything else on the answer — technique,
      // placements, hex, material, brand — is genuinely shared.
      const size = sync?.size?.trim() || plan.size
      const design: DesignParameters = {
        ...plan,
        ...(size ? { size } : {}),
      }
      if (!size) {
        delete design.size
      }

      return {
        ...variant,
        metadata: {
          ...variant.metadata,
          [DESIGN_METADATA_KEY]: design,
        },
      }
    })
  )
}

/** One product's design parameters, folded from its variants for display. */
export type ProductDesignSummary = {
  product_class: DesignParameters["productClass"]
  technique?: string
  techniques: string[]
  core_placements: string[]
  placements: string[]
  brand?: string
  model?: string
  material?: string
  dimensions?: string
  /**
   * Which Printful catalog product this is. A product-level fact like brand
   * and technique, and what lets a prompt say "unisex t-shirt" rather than
   * falling back to "garment".
   */
  catalog_product_id?: string
  /** Distinct base colours, in the order the variants report them. */
  colors: Array<{ name: string; hex?: string }>
  sizes: string[]
}

/**
 * Fold a product's variants into one design summary.
 *
 * Product-level facts — class, technique, placements, brand — are identical
 * across every variant, so the first variant carrying design metadata answers
 * for the product. Colour and size are the axes that vary, and are collected.
 *
 * Returns `null` when no variant carries design metadata. That is deliberately
 * distinct from a summary with empty fields: a product that was never enriched
 * is not a product with no design parameters, and a page that renders the two
 * identically tells the owner something false about a product that is fine.
 */
export function summarizeProductDesign(
  variants: Array<{ metadata?: Record<string, unknown> | null }>
): ProductDesignSummary | null {
  let shape: DesignParameters | undefined
  const colors: Array<{ name: string; hex?: string }> = []
  const sizes: string[] = []
  const seenColor = new Set<string>()
  const seenSize = new Set<string>()

  for (const variant of variants) {
    const design = (variant?.metadata ?? {})[DESIGN_METADATA_KEY] as
      DesignParameters | undefined
    if (!design) {
      continue
    }

    shape ??= design

    if (design.color && !seenColor.has(design.color)) {
      seenColor.add(design.color)
      // The hex rides with the name rather than being looked up separately:
      // a swatch without one must render as absent, not as black.
      colors.push({ name: design.color, hex: design.colorHex })
    }
    if (design.size && !seenSize.has(design.size)) {
      seenSize.add(design.size)
      sizes.push(design.size)
    }
  }

  if (!shape) {
    return null
  }

  return {
    product_class: shape.productClass,
    technique: shape.technique,
    techniques: shape.techniques,
    core_placements: shape.corePlacements,
    placements: shape.placements,
    brand: shape.brand,
    model: shape.model,
    material: shape.material,
    dimensions: shape.dimensions,
    catalog_product_id: shape.catalogProductId,
    colors,
    sizes,
  }
}
