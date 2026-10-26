import { describe, expect, it } from "vitest"
import {
  applyMarkup,
  diffVariantsForUpsert,
  mapSyncProductToMedusa,
  parsePriceToAmount,
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

  // Medusa v2 stores money in the currency's main unit: $25.00 is 25, not
  // 2500 (the admin formats `amount` as-is; payment providers multiply it up
  // to the smallest unit themselves). Writing cents makes a $25 tee cost $2500.
  it("parses prices to Medusa amounts in the main unit", () => {
    expect(parsePriceToAmount("25.00")).toBe(25)
    expect(parsePriceToAmount("25.5")).toBe(25.5)
    expect(parsePriceToAmount("4.99", "USD")).toBe(4.99)
    expect(parsePriceToAmount(null)).toBe(0)
    expect(parsePriceToAmount("abc")).toBe(0)
  })

  it("rounds to the currency's own precision", () => {
    expect(parsePriceToAmount("1500", "JPY")).toBe(1500)
    expect(parsePriceToAmount("1500.4", "jpy")).toBe(1500)
    expect(parsePriceToAmount("1.2345", "KWD")).toBe(1.235)
    expect(parsePriceToAmount("25.005", "USD")).toBe(25.01)
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

  it("applies markup to a zero-decimal amount without fractional yen", () => {
    expect(applyMarkup(1500, 30, "JPY")).toBe(1950)
    expect(applyMarkup(999, 15, "JPY")).toBe(1149)
  })

  it("applies markup and rounds to cents", () => {
    expect(applyMarkup(25, 30, "USD")).toBe(32.5)
    expect(applyMarkup(19.99, 15, "USD")).toBe(22.99)
    expect(applyMarkup(10)).toBe(10)
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
    expect(mapped.variants[0].prices[0].amount).toBe(25)
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

describe("mapSyncProductToMedusa multi-currency", () => {
  const rates = { date: "2026-10-26", perEur: { EUR: 1, USD: 1.1188 } }

  it("adds a converted price for each additional currency", () => {
    // Printful prices in the store's currency only. A region in euros with no
    // euro price shows the product at zero.
    const mapped = mapSyncProductToMedusa(sample, {
      markupPercent: 0,
      additionalCurrencies: ["eur"],
      fxRates: rates,
    })
    expect(mapped.variants[0].prices).toEqual([
      { amount: 25, currency_code: "usd" },
      // $25 / 1.1188 = €22.35 → charm-rounded up to €22.99
      { amount: 22.99, currency_code: "eur" },
    ])
    expect(mapped.pricesComplete).toBe(true)
  })

  it("converts after markup, so both currencies carry it", () => {
    const mapped = mapSyncProductToMedusa(sample, {
      markupPercent: 20,
      additionalCurrencies: ["EUR"],
      fxRates: rates,
      convertedPriceRounding: "exact",
    })
    expect(mapped.variants[0].prices).toEqual([
      { amount: 30, currency_code: "usd" },
      { amount: 26.81, currency_code: "eur" },
    ])
  })

  it("flags the prices incomplete when there is no rate to convert with", () => {
    const mapped = mapSyncProductToMedusa(sample, {
      additionalCurrencies: ["eur"],
      fxRates: null,
    })
    expect(mapped.variants[0].prices).toEqual([
      { amount: 25, currency_code: "usd" },
    ])
    expect(mapped.pricesComplete).toBe(false)
  })

  it("skips an additional currency equal to the base one", () => {
    const mapped = mapSyncProductToMedusa(sample, {
      additionalCurrencies: ["usd"],
      fxRates: null,
    })
    expect(mapped.variants[0].prices).toHaveLength(1)
    expect(mapped.pricesComplete).toBe(true)
  })
})

describe("mapSyncProductToMedusa presentation", () => {
  it("titles a variant by its options, not the product name again", () => {
    // Printful names a variant "Unisex t-shirt / Heather Slate / L"; next to
    // the product title in a cart that reads twice.
    const mapped = mapSyncProductToMedusa(sample)
    expect(mapped.variants.map((v) => v.title)).toEqual([
      "Black / M",
      "Black / L",
    ])
  })

  it("lists Color before Size", () => {
    const mapped = mapSyncProductToMedusa(sample)
    expect(mapped.options.map((o) => o.title)).toEqual(["Color", "Size"])
  })

  it("records each variant's own mockup for the storefront", () => {
    const mapped = mapSyncProductToMedusa(sample)
    expect(mapped.variants[0].metadata.printful_preview_url).toBe(
      "https://cdn.example/v1.png"
    )
    expect(mapped.variants[1].metadata.printful_preview_url).toBeUndefined()
  })

  it("prefers the preview file's mockup over a print file", () => {
    const mapped = mapSyncProductToMedusa({
      ...sample,
      sync_variants: [
        {
          ...sample.sync_variants[0],
          files: [
            { type: "default", preview_url: "https://cdn.example/art.png" },
            { type: "preview", preview_url: "https://cdn.example/mock.png" },
          ],
        },
      ],
    })
    expect(mapped.variants[0].metadata.printful_preview_url).toBe(
      "https://cdn.example/mock.png"
    )
  })
})

describe("variant names without size and colour fields", () => {
  it("takes colour and size from the last two parts of the name", () => {
    const mapped = mapSyncProductToMedusa({
      ...sample,
      sync_variants: [
        {
          ...sample.sync_variants[0],
          name: "Unisex t-shirt / Heather Slate / L",
          size: null,
          color: null,
        },
      ],
    })
    expect(mapped.variants[0].options).toEqual({
      Color: "Heather Slate",
      Size: "L",
    })
    expect(mapped.variants[0].title).toBe("Heather Slate / L")
  })
})
