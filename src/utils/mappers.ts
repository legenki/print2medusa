import type {
  PrintfulPluginOptions,
  PrintfulSyncProductDetail,
  PrintfulSyncVariant,
} from "./types"
import { minorUnitFactor } from "./currency"
import { convertPrice, type ConvertedPriceRounding, type FxRates } from "./fx"
import { DISCONTINUED_MARKER_KEY, planStockActions } from "./stock"

export type MedusaProductOptionInput = {
  title: string
  values: string[]
}

export type MedusaVariantInput = {
  title: string
  sku?: string
  options: Record<string, string>
  prices: Array<{ amount: number; currency_code: string }>
  metadata: Record<string, unknown>
  manage_inventory?: boolean
  allow_backorder?: boolean
}

export type MedusaProductInput = {
  title: string
  handle: string
  status: "published" | "draft"
  thumbnail?: string
  images?: Array<{ url: string }>
  options: MedusaProductOptionInput[]
  variants: MedusaVariantInput[]
  metadata: Record<string, unknown>
  external_id?: string
  /**
   * False when an additional currency could not be priced — no rate was
   * available. The sync must then leave existing prices alone rather than
   * replace them with a set that silently drops the currency.
   */
  pricesComplete: boolean
}

const STATE_TABLES: Record<string, Record<string, string>> = {
  US: {
    alabama: "AL",
    alaska: "AK",
    arizona: "AZ",
    arkansas: "AR",
    california: "CA",
    colorado: "CO",
    connecticut: "CT",
    delaware: "DE",
    "district of columbia": "DC",
    florida: "FL",
    georgia: "GA",
    hawaii: "HI",
    idaho: "ID",
    illinois: "IL",
    indiana: "IN",
    iowa: "IA",
    kansas: "KS",
    kentucky: "KY",
    louisiana: "LA",
    maine: "ME",
    maryland: "MD",
    massachusetts: "MA",
    michigan: "MI",
    minnesota: "MN",
    mississippi: "MS",
    missouri: "MO",
    montana: "MT",
    nebraska: "NE",
    nevada: "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    ohio: "OH",
    oklahoma: "OK",
    oregon: "OR",
    pennsylvania: "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    tennessee: "TN",
    texas: "TX",
    utah: "UT",
    vermont: "VT",
    virginia: "VA",
    washington: "WA",
    "west virginia": "WV",
    wisconsin: "WI",
    wyoming: "WY",
    "puerto rico": "PR",
  },
  CA: {
    alberta: "AB",
    "british columbia": "BC",
    manitoba: "MB",
    "new brunswick": "NB",
    "newfoundland and labrador": "NL",
    "northwest territories": "NT",
    "nova scotia": "NS",
    nunavut: "NU",
    ontario: "ON",
    "prince edward island": "PE",
    quebec: "QC",
    québec: "QC",
    saskatchewan: "SK",
    yukon: "YT",
  },
  AU: {
    "australian capital territory": "ACT",
    "new south wales": "NSW",
    "northern territory": "NT",
    queensland: "QLD",
    "south australia": "SA",
    tasmania: "TAS",
    victoria: "VIC",
    "western australia": "WA",
  },
}

/**
 * Normalize a Medusa `province` into the 2-letter code Printful expects for
 * `state_code`. Printful requires it for US/CA/AU; for other countries the code
 * is optional and unknown values are dropped rather than sent raw.
 */
export function resolveStateCode(
  province: string | null | undefined,
  countryCode: string | null | undefined
): string | undefined {
  const raw = province?.trim()
  if (!raw) {
    return undefined
  }

  const table = STATE_TABLES[(countryCode || "").toUpperCase()]
  if (!table) {
    return undefined
  }

  const codes = new Set(Object.values(table))
  const upper = raw.toUpperCase()
  if (upper.length <= 3 && codes.has(upper)) {
    return upper
  }

  return table[raw.toLowerCase()] ?? undefined
}

export type ExistingMedusaVariant = {
  id: string
  metadata?: Record<string, unknown> | null
  prices?: Array<{ amount: number; currency_code: string }>
}

export type VariantUpdate = {
  id: string
  title: string
  sku?: string
  prices: Array<{ amount: number; currency_code: string }>
  metadata: Record<string, unknown>
}

/**
 * Reconcile freshly-mapped Printful variants against the variants already on a
 * Medusa product, matching by `printful_sync_variant_id` in metadata.
 *
 * - New sync variants → `toCreate` (added to the product).
 * - Known sync variants → `toUpdate` (price/title refreshed from Printful).
 *
 * Existing variants without a sync id are ignored (never touched or deleted),
 * so manually-added Medusa variants survive a re-sync.
 */
export function diffVariantsForUpsert(
  mapped: MedusaVariantInput[],
  existing: ExistingMedusaVariant[]
): { toCreate: MedusaVariantInput[]; toUpdate: VariantUpdate[] } {
  const existingBySyncId = new Map<string, ExistingMedusaVariant>()
  for (const v of existing) {
    const syncId = v.metadata?.printful_sync_variant_id
    if (syncId != null && syncId !== "") {
      existingBySyncId.set(String(syncId), v)
    }
  }

  const toCreate: MedusaVariantInput[] = []
  const toUpdate: VariantUpdate[] = []

  for (const m of mapped) {
    const syncId = m.metadata?.printful_sync_variant_id
    const match =
      syncId != null ? existingBySyncId.get(String(syncId)) : undefined

    if (match) {
      toUpdate.push({
        id: match.id,
        title: m.title,
        sku: m.sku,
        prices: m.prices,
        metadata: m.metadata,
      })
    } else {
      toCreate.push(m)
    }
  }

  return { toCreate, toUpdate }
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "product"
  )
}

/**
 * Printful's decimal price string to Medusa minor units.
 *
 * Only for amounts this plugin keeps for itself (order cost metadata). Medusa
 * v2 does NOT store minor units — see `parsePriceToAmount` for anything that
 * becomes a Medusa price.
 */
export function parsePriceToMinorUnits(
  price: string | null | undefined,
  currencyCode?: string | null
): number {
  if (!price) {
    return 0
  }
  const n = Number.parseFloat(price)
  if (Number.isNaN(n)) {
    return 0
  }
  return Math.round(n * minorUnitFactor(currencyCode))
}

/**
 * Round a main-unit amount to the precision its currency actually has.
 *
 * Done through the minor-unit integer so binary float noise cannot survive:
 * 19.99 * 1.15 is 22.988499999999998, which rounds to 22.99 here.
 */
export function roundToCurrency(
  amount: number,
  currencyCode?: string | null
): number {
  const factor = minorUnitFactor(currencyCode)
  return Math.round(amount * factor) / factor
}

/**
 * Printful's decimal price string to a Medusa amount.
 *
 * Medusa v2 stores money in the currency's main unit, as-is: $25.00 is `25`,
 * ¥1500 is `1500`. The admin formats `amount` without dividing, and payment
 * providers scale it up to the smallest unit themselves (Stripe's
 * `getSmallestUnit`). Writing cents here priced a $25 tee at $2500.
 *
 * Rounded to the currency's own precision so a stray "25.005" cannot become
 * a price no customer can pay exactly.
 */
export function parsePriceToAmount(
  price: string | null | undefined,
  currencyCode?: string | null
): number {
  if (!price) {
    return 0
  }
  const n = Number.parseFloat(price)
  if (!Number.isFinite(n)) {
    return 0
  }
  return roundToCurrency(n, currencyCode)
}

/**
 * Markup is a ratio, so it applies to a main-unit amount directly; the result
 * is rounded to the currency's precision — whole yen, cents, or fils.
 */
export function applyMarkup(
  amount: number,
  markupPercent?: number,
  currencyCode?: string | null
): number {
  if (!markupPercent || markupPercent === 0) {
    return amount
  }
  return roundToCurrency(amount * (1 + markupPercent / 100), currencyCode)
}

function optionValuesFromVariants(variants: PrintfulSyncVariant[]): {
  options: MedusaProductOptionInput[]
  perVariant: Array<Record<string, string>>
} {
  const sizes = new Set<string>()
  const colors = new Set<string>()
  const perVariant: Array<Record<string, string>> = []

  for (const v of variants) {
    const opts: Record<string, string> = {}
    const size = v.size?.trim()
    const color = v.color?.trim()

    if (size) {
      sizes.add(size)
      opts.Size = size
    }
    if (color) {
      colors.add(color)
      opts.Color = color
    }

    if (!size && !color) {
      const parsed = parseNameOptions(v.name)
      if (parsed.Color) {
        colors.add(parsed.Color)
        opts.Color = parsed.Color
      }
      if (parsed.Size) {
        sizes.add(parsed.Size)
        opts.Size = parsed.Size
      }
      if (!opts.Size && !opts.Color) {
        opts.Title = v.name
      }
    }

    perVariant.push(opts)
  }

  // Colour first: it is the choice a shopper makes before size, and the
  // order a storefront renders the pickers in.
  const options: MedusaProductOptionInput[] = []
  if (colors.size) {
    options.push({ title: "Color", values: Array.from(colors) })
  }
  if (sizes.size) {
    options.push({ title: "Size", values: Array.from(sizes) })
  }

  const hasOnlyTitle = perVariant.every((o) => o.Title && !o.Size && !o.Color)
  if (hasOnlyTitle || options.length === 0) {
    const titles = Array.from(
      new Set(perVariant.map((o) => o.Title || "Default"))
    )
    return {
      options: [{ title: "Title", values: titles }],
      perVariant: perVariant.map((o) => ({ Title: o.Title || "Default" })),
    }
  }

  for (const o of perVariant) {
    for (const opt of options) {
      if (!o[opt.title]) {
        o[opt.title] = "Default"
        if (!opt.values.includes("Default")) {
          opt.values.push("Default")
        }
      }
    }
  }

  return { options, perVariant }
}

function parseNameOptions(name: string): { Size?: string; Color?: string } {
  const dash = name.split(" - ").pop()?.trim() ?? name
  if (dash.includes(" / ")) {
    // Printful writes both "Tee - Black / M" and "Tee / Black / M". Colour
    // and size are always the last two parts; anything before is the product.
    const parts = dash.split(" / ").map((s) => s.trim())
    const size = parts[parts.length - 1]
    const color = parts[parts.length - 2]
    return {
      ...(color ? { Color: color } : {}),
      ...(size ? { Size: size } : {}),
    }
  }
  return {}
}

function collectImages(detail: PrintfulSyncProductDetail): string[] {
  const urls = new Set<string>()
  if (detail.sync_product.thumbnail_url) {
    urls.add(detail.sync_product.thumbnail_url)
  }
  for (const v of detail.sync_variants) {
    for (const f of v.files ?? []) {
      const url = f.preview_url || f.thumbnail_url || f.url
      if (url) {
        urls.add(url)
      }
    }
    if (v.product?.image) {
      urls.add(v.product.image)
    }
  }
  return Array.from(urls)
}

/**
 * A variant's title from its options — "Heather Slate / L" — rather than
 * Printful's name, which repeats the product title ("Unisex t-shirt /
 * Heather Slate / L") and reads twice next to it in a cart or an order.
 */
function variantTitle(
  options: Record<string, string>,
  fallback: string
): string {
  const parts = [options.Color, options.Size].filter(
    (v): v is string => !!v && v !== "Default"
  )
  return parts.length ? parts.join(" / ") : fallback
}

/**
 * The mockup of this variant — the shirt in this colour — for a storefront
 * to show when the shopper picks it. Printful's `preview` file is the
 * rendered mockup; other files are print artwork.
 */
function variantPreviewUrl(v: PrintfulSyncVariant): string | undefined {
  const files = v.files ?? []
  const preview = files.find((f) => f.type === "preview")
  const pick = preview ?? files[0]
  return pick?.preview_url || pick?.thumbnail_url || undefined
}

export function mapSyncProductToMedusa(
  detail: PrintfulSyncProductDetail,
  options: Pick<
    PrintfulPluginOptions,
    | "storeId"
    | "defaultCurrency"
    | "markupPercent"
    | "onDiscontinued"
    | "additionalCurrencies"
    | "convertedPriceRounding"
  > & {
    /** Rates for `additionalCurrencies`; null when they could not be fetched. */
    fxRates?: FxRates | null
  } = {}
): MedusaProductInput {
  const { sync_product, sync_variants } = detail
  const stock = planStockActions(sync_variants)
  const storeId = options.storeId ?? "default"
  const currency = (
    sync_variants[0]?.currency ||
    options.defaultCurrency ||
    "USD"
  ).toLowerCase()

  const extraCurrencies = [
    ...new Set(
      (options.additionalCurrencies ?? [])
        .map((c) => String(c).trim().toLowerCase())
        .filter((c) => c && c !== currency)
    ),
  ]
  const rounding = options.convertedPriceRounding ?? "charm"
  let pricesComplete = true

  const { options: productOptions, perVariant } =
    optionValuesFromVariants(sync_variants)

  const variants: MedusaVariantInput[] = sync_variants.map((v, i) => {
    // `currency` is the same code these prices are stored under, so the scale
    // factor and the `currency_code` below can never disagree.
    const base = parsePriceToAmount(v.retail_price, currency)
    const amount = applyMarkup(base, options.markupPercent, currency)
    const prices = [{ amount, currency_code: currency }]
    for (const extra of extraCurrencies) {
      const converted = options.fxRates
        ? convertPrice(amount, currency, extra, options.fxRates, rounding)
        : null
      if (converted == null) {
        pricesComplete = false
      } else {
        prices.push({ amount: converted, currency_code: extra })
      }
    }
    const variantOptions = perVariant[i] ?? { Title: v.name }
    const preview = variantPreviewUrl(v)
    return {
      title: variantTitle(variantOptions, v.name),
      sku: v.sku || `pf-${v.id}`,
      options: variantOptions,
      prices,
      manage_inventory: false,
      allow_backorder: true,
      metadata: {
        printful_store_id: storeId,
        printful_sync_product_id: String(sync_product.id),
        printful_sync_variant_id: String(v.id),
        printful_catalog_variant_id: v.variant_id
          ? String(v.variant_id)
          : undefined,
        printful_availability_status:
          stock.variantAvailability[String(v.id)] ?? "active",
        ...(preview ? { printful_preview_url: preview } : {}),
      },
    }
  })

  const images = collectImages(detail)

  return {
    title: sync_product.name,
    handle: slugify(sync_product.name),
    status: stock.status,
    thumbnail: images[0],
    images: images.map((url) => ({ url })),
    options: productOptions,
    variants,
    external_id: String(sync_product.id),
    metadata: {
      printful_store_id: storeId,
      printful_sync_product_id: String(sync_product.id),
      printful_external_id: sync_product.external_id ?? undefined,
      ...(stock.hasDiscontinued && options.onDiscontinued !== "ignore"
        ? { [DISCONTINUED_MARKER_KEY]: true }
        : {}),
    },
    pricesComplete,
  }
}
