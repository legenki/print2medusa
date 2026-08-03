import { describe, expect, it } from "vitest"
import {
  applyMarkup,
  diffVariantsForUpsert,
  mapSyncProductToMedusa,
  parsePriceToMinorUnits,
  resolveStateCode,
  slugify,
} from "../src/utils/mappers"
import type { MedusaVariantInput } from "../src/utils/mappers"
import type { PrintfulSyncProductDetail } from "../src/utils/types"

const sample: PrintfulSyncProductDetail = {
  sync_product: {
    id: 100,
    external_id: "ext-1",
    name: "Cool Tee!",
    variants: 2,
    synced: 2,
    thumbnail_url: "https://cdn.example/t.png",
  },
  sync_variants: [
    {
      id: 1001,
      sync_product_id: 100,
      name: "Cool Tee! - Black / M",
      retail_price: "25.00",
      currency: "USD",
      size: "M",
      color: "Black",
      sku: "TEE-BLK-M",
      files: [{ preview_url: "https://cdn.example/v1.png" }],
    },
    {
      id: 1002,
      sync_product_id: 100,
      name: "Cool Tee! - Black / L",
      retail_price: "25.50",
      currency: "USD",
      size: "L",
      color: "Black",
    },
  ],
}

describe("mappers", () => {
  it("slugifies titles", () => {
    expect(slugify("Cool Tee!")).toBe("cool-tee")
  })

  it("parses prices to minor units", () => {
    expect(parsePriceToMinorUnits("25.00")).toBe(2500)
    expect(parsePriceToMinorUnits("25.5")).toBe(2550)
    expect(parsePriceToMinorUnits(null)).toBe(0)
  })

  it("leaves a zero-decimal price at its major unit", () => {
    expect(parsePriceToMinorUnits("1500", "JPY")).toBe(1500)
    expect(parsePriceToMinorUnits("1500", "jpy")).toBe(1500)
  })

  it("still scales a two-decimal price", () => {
    expect(parsePriceToMinorUnits("25.00", "USD")).toBe(2500)
    expect(parsePriceToMinorUnits("1500", "USD")).toBe(150000)
  })

  it("maps a JPY sync product without inflating its price", () => {
    const jpy = {
      sync_product: sample.sync_product,
      sync_variants: [
        { ...sample.sync_variants[0], currency: "JPY", retail_price: "1500" },
      ],
    } as typeof sample

    const mapped = mapSyncProductToMedusa(jpy, { markupPercent: 0 })
    expect(mapped.variants[0].prices[0]).toEqual({
      amount: 1500,
      currency_code: "jpy",
    })
  })

  it("applies markup to a zero-decimal amount without rescaling it", () => {
    // applyMarkup multiplies by a ratio, so it is unit-agnostic: 1500 JPY
    // minor units plus 30% is 1950 JPY minor units, same arithmetic as cents.
    expect(applyMarkup(1500, 30)).toBe(1950)
  })

  it("applies markup", () => {
    expect(applyMarkup(1000, 30)).toBe(1300)
    expect(applyMarkup(1000)).toBe(1000)
  })

  it("maps sync product to Medusa product input", () => {
    const mapped = mapSyncProductToMedusa(sample, {
      storeId: "42",
      markupPercent: 0,
    })

    expect(mapped.title).toBe("Cool Tee!")
    expect(mapped.handle).toBe("cool-tee")
    expect(mapped.metadata.printful_sync_product_id).toBe("100")
    expect(mapped.options.map((o) => o.title).sort()).toEqual(["Color", "Size"])
    expect(mapped.variants).toHaveLength(2)
    expect(mapped.variants[0].prices[0].amount).toBe(2500)
    expect(mapped.variants[0].metadata.printful_sync_variant_id).toBe("1001")
    expect(mapped.variants[0].options.Size).toBe("M")
    expect(mapped.variants[0].options.Color).toBe("Black")
    expect(mapped.images?.length).toBeGreaterThan(0)
  })
})

describe("resolveStateCode", () => {
  it("passes through valid 2-letter codes for known countries", () => {
    expect(resolveStateCode("CA", "US")).toBe("CA")
    expect(resolveStateCode("ny", "US")).toBe("NY")
    expect(resolveStateCode("ON", "CA")).toBe("ON")
  })

  it("maps full US state names to their code", () => {
    expect(resolveStateCode("California", "US")).toBe("CA")
    expect(resolveStateCode("new york", "US")).toBe("NY")
    expect(resolveStateCode("Puerto Rico", "US")).toBe("PR")
  })

  it("maps full Canadian province names to their code", () => {
    expect(resolveStateCode("Ontario", "CA")).toBe("ON")
    expect(resolveStateCode("british columbia", "CA")).toBe("BC")
  })

  it("returns undefined for empty or unresolvable input", () => {
    expect(resolveStateCode(undefined, "US")).toBeUndefined()
    expect(resolveStateCode("", "US")).toBeUndefined()
    expect(resolveStateCode("Nowhere", "US")).toBeUndefined()
  })

  it("returns undefined for countries without a state table (raw dropped)", () => {
    // Printful only requires state_code for US/CA/AU; unknown countries omit it
    expect(resolveStateCode("Bavaria", "DE")).toBeUndefined()
  })

  it("maps Australian state and territory names to their code", () => {
    expect(resolveStateCode("New South Wales", "AU")).toBe("NSW")
    expect(resolveStateCode("victoria", "AU")).toBe("VIC")
    expect(resolveStateCode("Queensland", "AU")).toBe("QLD")
    expect(resolveStateCode("Australian Capital Territory", "AU")).toBe("ACT")
  })

  it("passes through valid Australian codes", () => {
    expect(resolveStateCode("NSW", "AU")).toBe("NSW")
    expect(resolveStateCode("wa", "AU")).toBe("WA")
  })

  it("does not resolve a code from another country's table", () => {
    // Codes are matched against the resolved country's own table. WA means
    // Washington in the US and Western Australia in AU; NT is Northwest
    // Territories in CA and Northern Territory in AU. Flattening the tables
    // into one shared set would break that, and this is what would catch it.
    expect(resolveStateCode("NSW", "US")).toBeUndefined()
    expect(resolveStateCode("ACT", "CA")).toBeUndefined()
    expect(resolveStateCode("QLD", "US")).toBeUndefined()
  })
})

describe("diffVariantsForUpsert", () => {
  const mapped: MedusaVariantInput[] = [
    {
      title: "Tee - M",
      sku: "TEE-M",
      options: { Size: "M" },
      prices: [{ amount: 2600, currency_code: "usd" }],
      metadata: { printful_sync_variant_id: "1001" },
    },
    {
      title: "Tee - L",
      sku: "TEE-L",
      options: { Size: "L" },
      prices: [{ amount: 2700, currency_code: "usd" }],
      metadata: { printful_sync_variant_id: "1002" },
    },
  ]

  it("matches existing variants by printful_sync_variant_id and updates price", () => {
    const existing = [
      {
        id: "var_1",
        metadata: { printful_sync_variant_id: "1001" },
        prices: [{ amount: 2500, currency_code: "usd" }],
      },
    ]

    const { toCreate, toUpdate } = diffVariantsForUpsert(mapped, existing)

    // 1001 exists → update; 1002 is new → create
    expect(toUpdate).toHaveLength(1)
    expect(toUpdate[0].id).toBe("var_1")
    expect(toUpdate[0].prices[0].amount).toBe(2600)
    expect(toCreate).toHaveLength(1)
    expect(toCreate[0].metadata.printful_sync_variant_id).toBe("1002")
  })

  it("creates all when there are no existing variants", () => {
    const { toCreate, toUpdate } = diffVariantsForUpsert(mapped, [])
    expect(toCreate).toHaveLength(2)
    expect(toUpdate).toHaveLength(0)
  })

  it("does not match existing variants lacking a sync id", () => {
    const existing = [{ id: "var_x", metadata: {}, prices: [] }]
    const { toCreate, toUpdate } = diffVariantsForUpsert(mapped, existing)
    expect(toUpdate).toHaveLength(0)
    expect(toCreate).toHaveLength(2)
  })
})

describe("mapSyncProductToMedusa stock", () => {
  const soldOut: PrintfulSyncProductDetail = {
    sync_product: {
      id: 200,
      external_id: null,
      name: "Sold Out Tee",
      variants: 1,
      synced: 1,
    },
    sync_variants: [
      {
        id: 2001,
        sync_product_id: 200,
        name: "Sold Out Tee - M",
        retail_price: "25.00",
        currency: "USD",
        availability_status: "out_of_stock",
      },
    ],
  }

  it("creates a sold-out product as a draft rather than publishing it", () => {
    const mapped = mapSyncProductToMedusa(soldOut, { storeId: "42" })
    expect(mapped.status).toBe("draft")
  })

  it("publishes a product with an available variant", () => {
    const mapped = mapSyncProductToMedusa(sample, { storeId: "42" })
    expect(mapped.status).toBe("published")
  })

  it("writes availability into variant metadata", () => {
    const mapped = mapSyncProductToMedusa(sample, { storeId: "42" })
    expect(mapped.variants[0].metadata.printful_availability_status).toBe(
      "active"
    )
  })

  it("flags a discontinued product so the owner can find it", () => {
    const gone: PrintfulSyncProductDetail = {
      sync_product: {
        id: 300,
        external_id: null,
        name: "Retired Tee",
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: 3001,
          sync_product_id: 300,
          name: "Retired Tee - M",
          retail_price: "25.00",
          currency: "USD",
          availability_status: "discontinued",
        },
      ],
    }

    const mapped = mapSyncProductToMedusa(gone, { storeId: "42" })
    expect(mapped.metadata.printful_discontinued).toBe(true)
  })

  it("omits the discontinued flag when the option turns it off", () => {
    const gone: PrintfulSyncProductDetail = {
      sync_product: {
        id: 301,
        external_id: null,
        name: "Retired Tee 2",
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: 3011,
          sync_product_id: 301,
          name: "Retired Tee 2 - M",
          retail_price: "25.00",
          currency: "USD",
          availability_status: "discontinued",
        },
      ],
    }

    const mapped = mapSyncProductToMedusa(gone, {
      storeId: "42",
      onDiscontinued: "ignore",
    })
    expect(mapped.metadata.printful_discontinued).toBeUndefined()
    // "ignore" turns off only the marker, not the hiding.
    expect(mapped.status).toBe("draft")
  })
})
