import type {
  PrintfulPluginOptions,
  PrintfulSyncProductDetail,
  PrintfulSyncVariant,
} from "./types"

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
  if (upper.length === 2 && codes.has(upper)) {
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

export function parsePriceToMinorUnits(
  price: string | null | undefined
): number {
  if (!price) {
    return 0
  }
  const n = Number.parseFloat(price)
  if (Number.isNaN(n)) {
    return 0
  }
  return Math.round(n * 100)
}

export function applyMarkup(
  amountMinor: number,
  markupPercent?: number
): number {
  if (!markupPercent || markupPercent === 0) {
    return amountMinor
  }
  return Math.round(amountMinor * (1 + markupPercent / 100))
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

  const options: MedusaProductOptionInput[] = []
  if (sizes.size) {
    options.push({ title: "Size", values: Array.from(sizes) })
  }
  if (colors.size) {
    options.push({ title: "Color", values: Array.from(colors) })
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
    const [color, size] = dash.split(" / ").map((s) => s.trim())
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

export function mapSyncProductToMedusa(
  detail: PrintfulSyncProductDetail,
  options: Pick<
    PrintfulPluginOptions,
    "storeId" | "defaultCurrency" | "markupPercent"
  > = {}
): MedusaProductInput {
  const { sync_product, sync_variants } = detail
  const storeId = options.storeId ?? "default"
  const currency = (
    sync_variants[0]?.currency ||
    options.defaultCurrency ||
    "USD"
  ).toLowerCase()

  const { options: productOptions, perVariant } =
    optionValuesFromVariants(sync_variants)

  const variants: MedusaVariantInput[] = sync_variants.map((v, i) => {
    const base = parsePriceToMinorUnits(v.retail_price)
    const amount = applyMarkup(base, options.markupPercent)
    return {
      title: v.name,
      sku: v.sku || `pf-${v.id}`,
      options: perVariant[i] ?? { Title: v.name },
      prices: [{ amount, currency_code: currency }],
      manage_inventory: false,
      allow_backorder: true,
      metadata: {
        printful_store_id: storeId,
        printful_sync_product_id: String(sync_product.id),
        printful_sync_variant_id: String(v.id),
        printful_catalog_variant_id: v.variant_id
          ? String(v.variant_id)
          : undefined,
      },
    }
  })

  const images = collectImages(detail)

  return {
    title: sync_product.name,
    handle: slugify(sync_product.name),
    status: "published",
    thumbnail: images[0],
    images: images.map((url) => ({ url })),
    options: productOptions,
    variants,
    external_id: String(sync_product.id),
    metadata: {
      printful_store_id: storeId,
      printful_sync_product_id: String(sync_product.id),
      printful_external_id: sync_product.external_id ?? undefined,
    },
  }
}
