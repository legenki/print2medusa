/**
 * Reconcile a Printful product's sync variants against the variant link rows
 * that should exist for them.
 *
 * Why this needs to repair and not just refresh: a variant link row can go
 * missing without the product link row going missing. The create path writes
 * the product link first, then loops writing variant links; a throw partway
 * through that loop leaves a product that the next sync correctly finds and
 * takes the *update* path for, with some of its variants unlinked. Nothing
 * else closes that gap — `diffVariantsForUpsert` matches on variant metadata
 * (`printful_sync_variant_id`), not on link rows, so a stranded variant looks
 * already-synced and is never re-created.
 *
 * The stakes are order creation: `findVariantLinkByMedusaId` resolves the
 * `sync_variant_id` Printful needs through these rows, so a stranded variant
 * can fail to map when a customer orders it.
 *
 * Pure: decides intent, writes nothing. That keeps the boundary testable
 * without a container or a database, the same way OrphanTracker is.
 */

export type ExistingVariantLink = {
  id: string
  printful_sync_variant_id: string
}

export type LinkableMedusaVariant = {
  id: string
  metadata?: Record<string, unknown> | null
}

export type VariantLinkRepairPlan = {
  /** Links that exist and only need their `last_synced_at` bumped. */
  toRefresh: Array<{ id: string }>
  /** Links that should exist but do not. */
  toCreate: Array<{
    printful_sync_variant_id: string
    medusa_variant_id: string
  }>
}

export function planVariantLinkRepair(input: {
  syncVariantIds: Array<string | number>
  existingLinks: ExistingVariantLink[]
  medusaVariants: LinkableMedusaVariant[]
}): VariantLinkRepairPlan {
  const linkBySyncId = new Map<string, ExistingVariantLink>()
  for (const link of input.existingLinks) {
    linkBySyncId.set(String(link.printful_sync_variant_id), link)
  }

  // Only variants carrying a sync id are candidates. A manually-added Medusa
  // variant has none, and must never be linked to Printful.
  const variantBySyncId = new Map<string, LinkableMedusaVariant>()
  for (const variant of input.medusaVariants) {
    const syncId = variant.metadata?.printful_sync_variant_id
    if (syncId != null && syncId !== "") {
      variantBySyncId.set(String(syncId), variant)
    }
  }

  const toRefresh: Array<{ id: string }> = []
  const toCreate: VariantLinkRepairPlan["toCreate"] = []

  for (const rawSyncId of input.syncVariantIds) {
    const syncId = String(rawSyncId)

    const existing = linkBySyncId.get(syncId)
    if (existing) {
      toRefresh.push({ id: existing.id })
      continue
    }

    // No link row. Repair it only when there is a Medusa variant to point at —
    // inventing a row for a variant that does not exist would send order
    // creation to a dangling id, which is worse than the missing row.
    const variant = variantBySyncId.get(syncId)
    if (!variant) {
      continue
    }

    toCreate.push({
      printful_sync_variant_id: syncId,
      medusa_variant_id: variant.id,
    })
  }

  return { toRefresh, toCreate }
}

/**
 * The slice of the Printful module service this reconciliation needs. Narrow on
 * purpose: it is what lets the repair be tested against an in-memory table
 * instead of a container and a database.
 */
export type VariantLinkStore = {
  findVariantLink(
    syncVariantId: string
  ): Promise<{ id: string; medusa_variant_id?: string } | null>
  createPrintfulVariantLinks(input: {
    printful_store_id: string
    printful_sync_product_id: string
    printful_sync_variant_id: string
    medusa_variant_id: string
    last_synced_at: Date
  }): Promise<unknown>
  updatePrintfulVariantLinks(input: {
    id: string
    last_synced_at: Date
  }): Promise<unknown>
}

/**
 * Bring a product's variant link rows up to date, creating any that are
 * missing.
 *
 * Each link is written independently and a failure on one does not abort the
 * rest. That is deliberate: an all-or-nothing loop is exactly what stranded
 * these rows to begin with, and a partial repair still strictly improves on
 * leaving every later variant unlinked. Whatever this pass could not write is
 * simply retried by the next sync, because the plan is recomputed from the
 * rows that actually exist rather than from anything this run recorded.
 */
export async function reconcileVariantLinks(
  store: VariantLinkStore,
  input: {
    storeId: string
    syncProductId: string
    syncVariantIds: Array<string | number>
    medusaVariants: LinkableMedusaVariant[]
  }
): Promise<{ created: number; refreshed: number }> {
  // Read the current rows through the same lookup the workflow used before, so
  // the store filter (`printful_store_id`) keeps applying.
  const existingLinks: ExistingVariantLink[] = []
  for (const rawSyncId of input.syncVariantIds) {
    const syncId = String(rawSyncId)
    const link = await store.findVariantLink(syncId)
    if (link) {
      existingLinks.push({ id: link.id, printful_sync_variant_id: syncId })
    }
  }

  const plan = planVariantLinkRepair({
    syncVariantIds: input.syncVariantIds,
    existingLinks,
    medusaVariants: input.medusaVariants,
  })

  let created = 0
  let refreshed = 0

  for (const link of plan.toRefresh) {
    await store.updatePrintfulVariantLinks({
      id: link.id,
      last_synced_at: new Date(),
    })
    refreshed += 1
  }

  for (const link of plan.toCreate) {
    try {
      await store.createPrintfulVariantLinks({
        printful_store_id: input.storeId,
        printful_sync_product_id: input.syncProductId,
        printful_sync_variant_id: link.printful_sync_variant_id,
        medusa_variant_id: link.medusa_variant_id,
        last_synced_at: new Date(),
      })
      created += 1
    } catch {
      // Swallowed so one unwritable row cannot strand the ones after it. The
      // next sync recomputes the plan from the table and tries again.
    }
  }

  return { created, refreshed }
}
