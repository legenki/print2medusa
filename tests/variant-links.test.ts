import { describe, expect, it } from "vitest"
import {
  planVariantLinkRepair,
  reconcileVariantLinks,
  type VariantLinkStore,
} from "../src/utils/variant-links"

describe("planVariantLinkRepair", () => {
  it("refreshes a link that already exists", () => {
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101"],
      existingLinks: [{ id: "link_1", printful_sync_variant_id: "101" }],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
      ],
    })

    expect(plan.toRefresh).toEqual([{ id: "link_1" }])
    expect(plan.toCreate).toEqual([])
  })

  it("creates the missing link for a stranded variant", () => {
    // The gap this exists to close: the product's link row was written, so the
    // next sync takes the update path, but the variant's link row never was.
    // diffVariantsForUpsert matches on variant metadata, so the variant looks
    // already-synced and is never re-created — nothing else repairs this.
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101", "102"],
      existingLinks: [{ id: "link_1", printful_sync_variant_id: "101" }],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
        { id: "var_2", metadata: { printful_sync_variant_id: "102" } },
      ],
    })

    expect(plan.toRefresh).toEqual([{ id: "link_1" }])
    expect(plan.toCreate).toEqual([
      { printful_sync_variant_id: "102", medusa_variant_id: "var_2" },
    ])
  })

  it("skips a sync variant with no Medusa variant to point at", () => {
    // Without a Medusa variant carrying the sync id there is nothing to link
    // to. Inventing a link row here would point order creation at a variant
    // that does not exist, which is worse than the missing row.
    const plan = planVariantLinkRepair({
      syncVariantIds: ["103"],
      existingLinks: [],
      medusaVariants: [],
    })

    expect(plan.toCreate).toEqual([])
    expect(plan.toRefresh).toEqual([])
  })

  it("ignores Medusa variants without a sync id", () => {
    // Manually-added Medusa variants must never be linked to Printful.
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101"],
      existingLinks: [],
      medusaVariants: [
        { id: "var_manual", metadata: {} },
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
      ],
    })

    expect(plan.toCreate).toEqual([
      { printful_sync_variant_id: "101", medusa_variant_id: "var_1" },
    ])
  })

  it("matches sync ids across number and string forms", () => {
    // Printful sends numeric ids; link rows and metadata store strings.
    const plan = planVariantLinkRepair({
      syncVariantIds: [101],
      existingLinks: [],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: 101 } },
      ],
    })

    expect(plan.toCreate).toEqual([
      { printful_sync_variant_id: "101", medusa_variant_id: "var_1" },
    ])
  })

  it("repairs every missing link in one pass", () => {
    // A create path that threw on its first variant strands all of them.
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101", "102", "103"],
      existingLinks: [],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
        { id: "var_2", metadata: { printful_sync_variant_id: "102" } },
        { id: "var_3", metadata: { printful_sync_variant_id: "103" } },
      ],
    })

    expect(plan.toCreate).toEqual([
      { printful_sync_variant_id: "101", medusa_variant_id: "var_1" },
      { printful_sync_variant_id: "102", medusa_variant_id: "var_2" },
      { printful_sync_variant_id: "103", medusa_variant_id: "var_3" },
    ])
    expect(plan.toRefresh).toEqual([])
  })

  it("does not create a second link for a variant already linked elsewhere", () => {
    // The link row is keyed by sync variant id. If one exists, refresh it —
    // never insert a duplicate, which the unique index would reject anyway.
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101"],
      existingLinks: [{ id: "link_1", printful_sync_variant_id: "101" }],
      medusaVariants: [
        { id: "var_other", metadata: { printful_sync_variant_id: "101" } },
      ],
    })

    expect(plan.toCreate).toEqual([])
    expect(plan.toRefresh).toEqual([{ id: "link_1" }])
  })

  it("ignores a null metadata bag", () => {
    const plan = planVariantLinkRepair({
      syncVariantIds: ["101"],
      existingLinks: [],
      medusaVariants: [{ id: "var_1", metadata: null }],
    })

    expect(plan.toCreate).toEqual([])
  })
})

/**
 * An in-memory stand-in for the variant-link table. Real enough to prove the
 * repair actually lands a row that `findVariantLinkByMedusaId` — the lookup
 * order creation uses — would then find.
 */
function makeStore(
  seed: Array<{
    id: string
    printful_sync_variant_id: string
    medusa_variant_id: string
    last_synced_at?: Date | null
  }> = []
): VariantLinkStore & {
  rows: Array<{
    id: string
    printful_sync_variant_id: string
    medusa_variant_id: string
    last_synced_at?: Date | null
  }>
} {
  const rows = seed.map((r) => ({ last_synced_at: null, ...r }))
  let next = rows.length + 1

  return {
    rows,
    async findVariantLink(syncVariantId: string) {
      return (
        rows.find(
          (r) => r.printful_sync_variant_id === String(syncVariantId)
        ) ?? null
      )
    },
    async createPrintfulVariantLinks(input) {
      const row = {
        id: `link_${next++}`,
        printful_sync_variant_id: input.printful_sync_variant_id,
        medusa_variant_id: input.medusa_variant_id,
        last_synced_at: input.last_synced_at ?? null,
      }
      rows.push(row)
      return row
    },
    async updatePrintfulVariantLinks(input) {
      const row = rows.find((r) => r.id === input.id)
      if (row) {
        row.last_synced_at = input.last_synced_at ?? row.last_synced_at
      }
      return row
    },
  }
}

describe("reconcileVariantLinks", () => {
  it("restores a missing variant link on the next sync", async () => {
    // The regression this whole change exists for. Product 900 synced once and
    // got its product link row, but the create path threw partway through its
    // variant-link loop: variant 101 was linked, 102 was stranded. The next
    // sync takes the update path — which, before this, only refreshed links it
    // already found and left 102 unlinked forever.
    const store = makeStore([
      {
        id: "link_1",
        printful_sync_variant_id: "101",
        medusa_variant_id: "var_1",
      },
    ])

    await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["101", "102"],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
        { id: "var_2", metadata: { printful_sync_variant_id: "102" } },
      ],
    })

    const repaired = await store.findVariantLink("102")
    expect(repaired).not.toBeNull()
    expect(repaired?.medusa_variant_id).toBe("var_2")
  })

  it("stamps the repaired link with the store and product it belongs to", async () => {
    const store = makeStore()

    await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["101"],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
      ],
    })

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]).toMatchObject({
      printful_sync_variant_id: "101",
      medusa_variant_id: "var_1",
    })
  })

  it("refreshes an existing link rather than duplicating it", async () => {
    const store = makeStore([
      {
        id: "link_1",
        printful_sync_variant_id: "101",
        medusa_variant_id: "var_1",
      },
    ])

    await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["101"],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
      ],
    })

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].last_synced_at).toBeInstanceOf(Date)
  })

  it("reports how many links it had to repair", async () => {
    const store = makeStore()

    const result = await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["101", "102"],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
        { id: "var_2", metadata: { printful_sync_variant_id: "102" } },
      ],
    })

    expect(result).toEqual({ created: 2, refreshed: 0 })
  })

  it("keeps repairing after one link fails to write", async () => {
    // Best-effort per link: one bad row must not strand the rest, which is the
    // very failure mode that created the gap in the first place.
    const store = makeStore()
    const original = store.createPrintfulVariantLinks
    store.createPrintfulVariantLinks = async (input) => {
      if (input.printful_sync_variant_id === "101") {
        throw new Error("insert failed")
      }
      return original(input)
    }

    const result = await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["101", "102"],
      medusaVariants: [
        { id: "var_1", metadata: { printful_sync_variant_id: "101" } },
        { id: "var_2", metadata: { printful_sync_variant_id: "102" } },
      ],
    })

    expect(result.created).toBe(1)
    expect(await store.findVariantLink("102")).not.toBeNull()
  })

  it("leaves a sync variant with no Medusa variant unlinked", async () => {
    const store = makeStore()

    const result = await reconcileVariantLinks(store, {
      storeId: "store_1",
      syncProductId: "900",
      syncVariantIds: ["103"],
      medusaVariants: [],
    })

    expect(result).toEqual({ created: 0, refreshed: 0 })
    expect(store.rows).toEqual([])
  })
})
