import { describe, expect, it, vi } from "vitest"
import {
  CatalogVariantCache,
  DESIGN_METADATA_KEY,
  enrichVariantsWithDesign,
  designProbeKey,
} from "../src/utils/design"
import type {
  PrintfulCatalogVariant,
  PrintfulSyncVariant,
} from "../src/utils/types"
import type { MedusaVariantInput } from "../src/utils/mappers"

/** A catalog answer for a tee in one colour. */
const teeCatalog = (
  color: string,
  hex: string,
  size: string
): PrintfulCatalogVariant => ({
  variant: {
    id: 4025,
    product_id: 71,
    size,
    color,
    color_code: hex,
    material: [{ name: "Airlume cotton", percentage: 100 }],
  },
  product: {
    id: 71,
    title: "Unisex Staple T-Shirt",
    brand: "Bella + Canvas",
    model: "3001",
    techniques: [{ key: "dtg", is_default: true }, { key: "embroidery" }],
    files: [
      { id: "front", type: "front" },
      { id: "back", type: "back" },
      { id: "preview", type: "preview" },
    ],
  },
})

/**
 * Build N sync variants for one product across `colors` × `sizes`, the shape
 * that makes the stampede real: 84 colours × 9 sizes on catalog 71.
 */
function teeSyncVariants(
  colors: string[],
  sizes: string[]
): PrintfulSyncVariant[] {
  const out: PrintfulSyncVariant[] = []
  let id = 1000
  let catalogId = 4000
  for (const color of colors) {
    for (const size of sizes) {
      out.push({
        id: id++,
        sync_product_id: 100,
        name: `Tee - ${color} / ${size}`,
        variant_id: catalogId++,
        color,
        size,
      })
    }
  }
  return out
}

function medusaVariantsFor(sync: PrintfulSyncVariant[]): MedusaVariantInput[] {
  return sync.map((v) => ({
    title: v.name,
    options: { Color: v.color ?? "", Size: v.size ?? "" },
    prices: [{ amount: 2500, currency_code: "usd" }],
    metadata: {
      printful_sync_variant_id: String(v.id),
      printful_catalog_variant_id: v.variant_id
        ? String(v.variant_id)
        : undefined,
      printful_availability_status: "active",
    },
  }))
}

describe("designProbeKey", () => {
  it("groups variants of one product by colour, not by size", () => {
    // Product-level facts are identical across the whole product, and the hex
    // is identical across sizes of a colour. Size is the axis that must NOT
    // open a new probe.
    const small = designProbeKey({
      syncProductId: "100",
      color: "Aqua",
    })
    const large = designProbeKey({
      syncProductId: "100",
      color: "Aqua",
    })
    expect(small).toBe(large)
  })

  it("separates two colours of the same product", () => {
    expect(designProbeKey({ syncProductId: "100", color: "Aqua" })).not.toBe(
      designProbeKey({ syncProductId: "100", color: "Black" })
    )
  })

  it("separates the same colour name across two products", () => {
    // "Black" on a tee is not "Black" on a cap: different blank, different
    // technique, different placements.
    expect(designProbeKey({ syncProductId: "100", color: "Black" })).not.toBe(
      designProbeKey({ syncProductId: "206", color: "Black" })
    )
  })

  it("gives a colourless variant one probe for the whole product", () => {
    // Posters and stickers have no colour; every size shares one answer.
    expect(designProbeKey({ syncProductId: "1", color: undefined })).toBe(
      designProbeKey({ syncProductId: "1", color: null })
    )
  })
})

describe("CatalogVariantCache", () => {
  it("calls the catalog once per key and serves the rest from memory", async () => {
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))
    const cache = new CatalogVariantCache(get)

    const a = await cache.get("k", 4000)
    const b = await cache.get("k", 4001)
    const c = await cache.get("k", 4002)

    expect(get).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it("caches a null answer so a failure is not retried per variant", async () => {
    // A catalog that 500s on one blank must cost one call, not 756.
    const get = vi.fn(async () => null)
    const cache = new CatalogVariantCache(get)

    expect(await cache.get("k", 4000)).toBeNull()
    expect(await cache.get("k", 4001)).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("does not launch a second call while the first is in flight", async () => {
    let resolve: (v: PrintfulCatalogVariant | null) => void = () => {}
    const get = vi.fn(
      () =>
        new Promise<PrintfulCatalogVariant | null>((r) => {
          resolve = r
        })
    )
    const cache = new CatalogVariantCache(get)

    const p1 = cache.get("k", 4000)
    const p2 = cache.get("k", 4001)
    resolve(teeCatalog("Aqua", "#008db5", "S"))

    expect(await p1).toBe(await p2)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("reports how many catalog calls it made", async () => {
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))
    const cache = new CatalogVariantCache(get)
    await cache.get("a", 1)
    await cache.get("a", 2)
    await cache.get("b", 3)
    expect(cache.calls).toBe(2)
  })
})

describe("enrichVariantsWithDesign", () => {
  it("writes design metadata when the catalog answers", async () => {
    const sync = teeSyncVariants(["Aqua"], ["S"])
    const variants = medusaVariantsFor(sync)
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: get,
    })

    const design = out[0].metadata[DESIGN_METADATA_KEY] as Record<
      string,
      unknown
    >
    expect(design).toBeTruthy()
    expect(design.productClass).toBe("apparel")
    expect(design.colorHex).toBe("#008db5")
    expect(design.technique).toBe("DTG")
    expect(design.corePlacements).toEqual(["front", "back"])
  })

  it("leaves the variant importable and otherwise unchanged on a null", async () => {
    const sync = teeSyncVariants(["Aqua"], ["S"])
    const variants = medusaVariantsFor(sync)
    const before = JSON.parse(JSON.stringify(variants))

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: async () => null,
    })

    expect(out).toHaveLength(1)
    // No key at all, rather than a key holding null — an absent design and a
    // design that is explicitly nothing must not look the same to the admin.
    expect(DESIGN_METADATA_KEY in out[0].metadata).toBe(false)
    expect(out[0].metadata.printful_sync_variant_id).toBe(
      before[0].metadata.printful_sync_variant_id
    )
    expect(out[0].metadata.printful_availability_status).toBe("active")
    expect(out[0].title).toBe(before[0].title)
    expect(out[0].prices).toEqual(before[0].prices)
  })

  it("does not stampede: one call per colour, not per variant", async () => {
    // The real shape of catalog 71 as this store sells it.
    const colors = Array.from({ length: 84 }, (_, i) => `Color${i}`)
    const sizes = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]
    const sync = teeSyncVariants(colors, sizes)
    expect(sync).toHaveLength(756)

    const variants = medusaVariantsFor(sync)
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))

    await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: get,
    })

    // 84 colours, not 756 variants. This is the assertion that makes the sync
    // shippable; if grouping regresses to per-variant it reads 756 here.
    expect(get).toHaveBeenCalledTimes(84)
    expect(get.mock.calls.length).toBeLessThan(sync.length)
  })

  it("makes exactly one call for a colourless product of many sizes", async () => {
    // Matte Poster: 33 sizes, no colour. One catalog answer covers them all.
    const sync: PrintfulSyncVariant[] = Array.from({ length: 33 }, (_, i) => ({
      id: 2000 + i,
      sync_product_id: 1,
      name: `Poster ${i}`,
      variant_id: 3000 + i,
      size: `size-${i}`,
    }))
    const variants = medusaVariantsFor(sync)
    const get = vi.fn(async () => teeCatalog("White", "#ffffff", "12x18"))

    await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "1",
      getCatalogVariant: get,
    })

    expect(get).toHaveBeenCalledTimes(1)
  })

  it("shares one cache across products so a shared blank is fetched once", async () => {
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))
    const cache = new CatalogVariantCache(get)

    const sync = teeSyncVariants(["Aqua"], ["S"])
    await enrichVariantsWithDesign(medusaVariantsFor(sync), sync, {
      syncProductId: "100",
      getCatalogVariant: get,
      cache,
    })
    await enrichVariantsWithDesign(medusaVariantsFor(sync), sync, {
      syncProductId: "100",
      getCatalogVariant: get,
      cache,
    })

    expect(get).toHaveBeenCalledTimes(1)
  })

  it("skips a variant with no catalog variant id without spending a call", async () => {
    // A sync variant Printful never linked to a catalog blank. There is no id
    // to look up, so there is nothing to ask and nothing to write.
    const sync: PrintfulSyncVariant[] = [
      {
        id: 1,
        sync_product_id: 100,
        name: "Custom item",
        variant_id: null,
        color: "Aqua",
      },
    ]
    const variants = medusaVariantsFor(sync)
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: get,
    })

    expect(get).not.toHaveBeenCalled()
    expect(DESIGN_METADATA_KEY in out[0].metadata).toBe(false)
    expect(out[0].metadata.printful_sync_variant_id).toBe("1")
  })

  it("enriches the linked variants when only some lack a catalog id", async () => {
    const sync: PrintfulSyncVariant[] = [
      {
        id: 1,
        sync_product_id: 100,
        name: "Unlinked",
        variant_id: null,
        color: "Aqua",
      },
      {
        id: 2,
        sync_product_id: 100,
        name: "Linked",
        variant_id: 4025,
        color: "Aqua",
      },
    ]
    const variants = medusaVariantsFor(sync)
    const get = vi.fn(async () => teeCatalog("Aqua", "#008db5", "S"))

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: get,
    })

    expect(DESIGN_METADATA_KEY in out[0].metadata).toBe(false)
    expect(DESIGN_METADATA_KEY in out[1].metadata).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("never throws when the catalog call itself rejects", async () => {
    // The client returns null on failure, but a caller could pass a raw fn.
    // A sync must not die because a catalog lookup blew up.
    const sync = teeSyncVariants(["Aqua"], ["S"])
    const variants = medusaVariantsFor(sync)

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: async () => {
        throw new Error("catalog down")
      },
    })

    expect(out).toHaveLength(1)
    expect(DESIGN_METADATA_KEY in out[0].metadata).toBe(false)
  })

  it("omits design metadata when the variant cannot be classified", async () => {
    const sync = teeSyncVariants(["Aqua"], ["S"])
    const variants = medusaVariantsFor(sync)

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: async () => ({ variant: {}, product: {} }),
    })

    expect(DESIGN_METADATA_KEY in out[0].metadata).toBe(false)
  })

  it("returns the variants in their original order", async () => {
    const sync = teeSyncVariants(["A", "B", "C"], ["S", "M"])
    const variants = medusaVariantsFor(sync)

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      getCatalogVariant: async () => teeCatalog("A", "#008db5", "S"),
    })

    expect(out.map((v) => v.title)).toEqual(variants.map((v) => v.title))
  })

  it("uses the variant's own colour and size, not the probe's", async () => {
    // One catalog answer covers a whole colour's sizes, so the size on that
    // answer is one arbitrary size. Writing it onto every variant would tell
    // the admin a 5XL is an S.
    const sync = teeSyncVariants(["Aqua"], ["S", "5XL"])
    const variants = medusaVariantsFor(sync)

    const out = await enrichVariantsWithDesign(variants, sync, {
      syncProductId: "100",
      // The probe answers with size S for both.
      getCatalogVariant: async () => teeCatalog("Aqua", "#008db5", "S"),
    })

    const first = out[0].metadata[DESIGN_METADATA_KEY] as Record<string, string>
    const second = out[1].metadata[DESIGN_METADATA_KEY] as Record<
      string,
      string
    >
    expect(first.size).toBe("S")
    expect(second.size).toBe("5XL")
    // The colour hex is genuinely shared and must survive.
    expect(second.colorHex).toBe("#008db5")
  })
})
