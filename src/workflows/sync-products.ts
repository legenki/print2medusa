import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  batchProductVariantsWorkflow,
  createProductsWorkflow,
} from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import { diffVariantsForUpsert, mapSyncProductToMedusa } from "../utils/mappers"
import { OrphanTracker } from "../utils/orphans"
import { reconcileVariantLinks } from "../utils/variant-links"
import { planSyncLogStatus } from "../utils/sync-status"
import {
  planStockActions,
  resolveExistingProductWrite,
  STOCK_MARKER_KEY,
} from "../utils/stock"
import {
  findMissingSyncProductLinks,
  planRemovedProductWrite,
  shouldRunRemovalPass,
  type OnRemovedFromPrintful,
} from "../utils/removed"
import { CatalogVariantCache, enrichVariantsWithDesign } from "../utils/design"
import { planBundlePass, type ProductForBundlePass } from "../utils/bundle"
import type {
  PrintfulSyncProductSummary,
  PrintfulSyncProductDetail,
  PrintfulPluginOptions,
} from "../utils/types"
import type { ProductDTO } from "@medusajs/framework/types"

export type SyncProductsInput = {
  sync_log_id: string
  limit?: number
}

type SyncCounters = {
  created: number
  updated: number
  failed: number
  errors: string[]
}
type CreateProductInput = NonNullable<
  Parameters<typeof createProductsWorkflow.runAsStep>[0]
>["input"]["products"][0]
type CreateVariantInput = NonNullable<
  NonNullable<
    Parameters<typeof batchProductVariantsWorkflow.runAsStep>[0]
  >["input"]["create"]
>[0]
type UpdateVariantInput = NonNullable<
  NonNullable<
    Parameters<typeof batchProductVariantsWorkflow.runAsStep>[0]
  >["input"]["update"]
>[0]

const fetchPrintfulProductsStep = createStep(
  {
    name: "printful-fetch-products",
    async: true,
    backgroundExecution: true,
  },
  async (input: SyncProductsInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const client = await printful.getClient()
    const options = await printful.getOptions()
    const storeId = await printful.getStoreId()

    const summaries = await client.listAllSyncProducts({
      limit: 100,
    })

    const toProcess =
      input.limit != null ? summaries.slice(0, input.limit) : summaries

    await printful.heartbeatSyncLog(input.sync_log_id, {
      products_total: toProcess.length,
    })

    const detailsMap = new Map<string, PrintfulSyncProductDetail>()
    let processed = 0
    const errors: string[] = []
    let failed = 0

    for (const summary of toProcess) {
      if (summary.is_ignored) {
        continue
      }
      try {
        const detail = await client.getSyncProduct(summary.id)
        if (!detail.sync_variants?.length) {
          failed += 1
          errors.push(`Product ${summary.id} has no variants`)
          continue
        }
        detailsMap.set(String(summary.id), detail)
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`Product ${summary.id}: ${message}`)
      } finally {
        processed += 1
        await printful.heartbeatSyncLog(input.sync_log_id, {
          products_processed: processed,
          products_total: toProcess.length,
        })
      }
    }

    return new StepResponse({
      toProcess,
      details: Array.from(detailsMap.entries()),
      options,
      storeId,
      initialCounters: {
        created: 0,
        updated: 0,
        failed,
        errors,
      } satisfies SyncCounters,
    })
  }
)

const mapToMedusaProductsStep = createStep(
  {
    name: "printful-map-products",
    async: true,
    backgroundExecution: true,
  },
  async (
    input: {
      sync_log_id: string
      toProcess: PrintfulSyncProductSummary[]
      details: [string, PrintfulSyncProductDetail][]
      options: PrintfulPluginOptions
      storeId: string
      initialCounters: SyncCounters
    },
    { container }
  ) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const client = await printful.getClient()

    const counters: SyncCounters = {
      created: input.initialCounters.created,
      updated: input.initialCounters.updated,
      failed: input.initialCounters.failed,
      errors: [...input.initialCounters.errors],
    }

    const detailsMap = new Map(input.details)
    const catalogCache = new CatalogVariantCache((id) =>
      client.getCatalogVariant(id)
    )

    const productsToCreate: CreateProductInput[] = []
    const productsToUpdate: {
      productId: string
      data: Record<string, unknown>
    }[] = []
    const variantsToCreate: CreateVariantInput[] = []
    const variantsToUpdate: UpdateVariantInput[] = []
    const linksToCreate: { syncProductId: string }[] = []
    const linksToUpdate: {
      linkId: string
      syncProductId: string
      medusaProductId: string
    }[] = []
    const reconcileItems: {
      syncProductId: string
      medusaProductId?: string
      syncVariantIds: number[]
      isCreate: boolean
    }[] = []
    let processed = 0

    for (const summary of input.toProcess) {
      if (summary.is_ignored) continue
      const detail = detailsMap.get(String(summary.id))
      if (!detail) continue

      try {
        const mapped = mapSyncProductToMedusa(detail, input.options)

        mapped.variants = await enrichVariantsWithDesign(
          mapped.variants,
          detail.sync_variants,
          {
            syncProductId: String(summary.id),
            getCatalogVariant: (id) => client.getCatalogVariant(id),
            cache: catalogCache,
          }
        )

        const existingLink = await printful.findProductLink(String(summary.id))

        if (existingLink?.medusa_product_id) {
          const productId = existingLink.medusa_product_id

          const product = await productModule.retrieveProduct(productId, {
            relations: ["variants"],
          })

          const publication = resolveExistingProductWrite({
            plan: planStockActions(detail.sync_variants),
            currentStatus:
              product.status === "published" ? "published" : "draft",
            currentMetadata: (product.metadata ?? {}) as Record<
              string,
              unknown
            >,
            mappedMetadata: mapped.metadata,
          })

          productsToUpdate.push({
            productId,
            data: {
              title: mapped.title,
              thumbnail: mapped.thumbnail,
              metadata: publication.metadata,
              status: publication.status,
            },
          })

          const { toCreate, toUpdate } = diffVariantsForUpsert(
            mapped.variants,
            (product.variants ?? []).map((pv) => ({
              id: pv.id,
              metadata: pv.metadata,
            }))
          )

          for (const u of toUpdate) {
            variantsToUpdate.push({
              id: u.id,
              title: u.title,
              prices: u.prices,
              metadata: u.metadata,
            })
          }

          for (const c of toCreate) {
            variantsToCreate.push({
              product_id: productId,
              title: c.title,
              sku: c.sku,
              options: c.options,
              prices: c.prices,
              metadata: c.metadata,
              manage_inventory: c.manage_inventory,
              allow_backorder: c.allow_backorder,
            })
          }

          linksToUpdate.push({
            linkId: existingLink.id,
            syncProductId: String(summary.id),
            medusaProductId: productId,
          })

          reconcileItems.push({
            syncProductId: String(summary.id),
            medusaProductId: productId,
            syncVariantIds: detail.sync_variants.map((v) => v.id),
            isCreate: false,
          })
        } else {
          let handle = mapped.handle
          try {
            const existing = await productModule.listProducts(
              { handle: [handle] },
              { take: 1 }
            )
            if (existing.length) {
              handle = `${handle}-pf-${summary.id}`
            }
          } catch {
            // ignore
          }

          const createStock = planStockActions(detail.sync_variants)
          const createMetadata: Record<string, unknown> = {
            ...mapped.metadata,
            ...(createStock.allUnavailable
              ? { [STOCK_MARKER_KEY]: "unavailable" }
              : {}),
          }

          productsToCreate.push({
            title: mapped.title,
            handle,
            status: mapped.status,
            thumbnail: mapped.thumbnail,
            images: mapped.images,
            options: mapped.options,
            variants: mapped.variants.map((v) => ({
              title: v.title,
              sku: v.sku,
              options: v.options,
              prices: v.prices,
              metadata: v.metadata,
              manage_inventory: v.manage_inventory,
              allow_backorder: v.allow_backorder,
            })),
            metadata: createMetadata,
            external_id: mapped.external_id,
          })

          linksToCreate.push({ syncProductId: String(summary.id) })

          reconcileItems.push({
            syncProductId: String(summary.id),
            syncVariantIds: detail.sync_variants.map((v) => v.id),
            isCreate: true,
          })
        }
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(`Product ${summary.id}: ${message}`)
      } finally {
        processed += 1
        await printful.heartbeatSyncLog(input.sync_log_id, {
          products_processed: processed,
          products_total: input.toProcess.length,
        })
      }
    }

    logger.info(
      `Printful sync: ${catalogCache.calls} catalog variant call(s) for design parameters`
    )

    return new StepResponse({
      productsToCreate,
      productsToUpdate,
      variantsToCreate,
      variantsToUpdate,
      linksToCreate,
      linksToUpdate,
      reconcileItems,
      counters,
      catalogCacheCalls: catalogCache.calls,
    })
  }
)

const updateMedusaProductsStep = createStep(
  "printful-update-medusa-products",
  async (
    productsToUpdate: { productId: string; data: Record<string, unknown> }[],
    { container }
  ) => {
    const productModule = container.resolve(Modules.PRODUCT)
    for (const update of productsToUpdate) {
      await productModule.updateProducts(update.productId, update.data)
    }
    return new StepResponse(null)
  }
)

const syncLinksStep = createStep(
  "printful-sync-links",
  async (
    input: {
      createdProducts: ProductDTO[]
      linksToCreate: { syncProductId: string }[]
      linksToUpdate: {
        linkId: string
        syncProductId: string
        medusaProductId: string
      }[]
      reconcileItems: {
        syncProductId: string
        medusaProductId?: string
        syncVariantIds: number[]
        isCreate: boolean
      }[]
      storeId: string
      counters: SyncCounters
    },
    { container }
  ) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const counters = {
      created: input.counters.created,
      updated: input.counters.updated,
      failed: input.counters.failed,
      errors: [...input.counters.errors],
    }

    const orphans = new OrphanTracker()

    const createdBySyncId = new Map<string, ProductDTO>()
    if (input.createdProducts && Array.isArray(input.createdProducts)) {
      for (const cp of input.createdProducts) {
        if (cp.external_id) {
          createdBySyncId.set(cp.external_id, cp)
        }
      }
    }

    for (const lc of input.linksToCreate) {
      const created = createdBySyncId.get(lc.syncProductId)
      if (!created) {
        counters.failed += 1
        counters.errors.push(
          `Product ${lc.syncProductId} created but not found in output`
        )
        continue
      }

      orphans.track(created.id)

      try {
        await printful.createPrintfulProductLinks({
          printful_store_id: input.storeId,
          printful_sync_product_id: lc.syncProductId,
          medusa_product_id: created.id,
          last_synced_at: new Date(),
        })
        orphans.release(created.id)
        counters.created += 1
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(`Product ${lc.syncProductId}: ${message}`)

        try {
          await productModule.deleteProducts([created.id])
          orphans.release(created.id)
        } catch (deleteErr) {
          logger.error(
            `Printful sync: could not delete orphaned product ${created.id} after a failed link write: ${
              deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
            }`
          )
        }
      }
    }

    for (const lu of input.linksToUpdate) {
      try {
        await printful.updatePrintfulProductLinks({
          id: lu.linkId,
          last_synced_at: new Date(),
        })
        counters.updated += 1
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(
          `Product update link ${lu.syncProductId}: ${message}`
        )
      }
    }

    for (const item of input.reconcileItems) {
      try {
        const medusaProductId = item.isCreate
          ? createdBySyncId.get(item.syncProductId)?.id
          : item.medusaProductId

        if (!medusaProductId) continue

        const linked = await productModule.retrieveProduct(medusaProductId, {
          relations: ["variants"],
        })

        await reconcileVariantLinks(printful, {
          storeId: input.storeId,
          syncProductId: item.syncProductId,
          syncVariantIds: item.syncVariantIds,
          medusaVariants: (linked.variants ?? []).map((pv) => ({
            id: pv.id,
            metadata: pv.metadata,
          })),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(
          `Failed to reconcile variant links for ${item.syncProductId}: ${message}`
        )
      }
    }

    return new StepResponse(
      { counters, orphanProductIds: orphans.toDelete() },
      { orphanProductIds: orphans.toDelete() }
    )
  },
  async (
    compensateInput: { orphanProductIds: string[] } | undefined,
    { container }
  ) => {
    if (!compensateInput?.orphanProductIds?.length) {
      return
    }
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    for (const id of compensateInput.orphanProductIds) {
      try {
        await productModule.deleteProducts([id])
      } catch (err) {
        logger.error(
          `Printful sync rollback: could not delete orphaned product ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    logger.info(
      `Printful sync rolled back ${compensateInput.orphanProductIds.length} orphaned product(s)`
    )
  }
)

const removalsAndBundlesStep = createStep(
  {
    name: "printful-removals-bundles",
    async: true,
    backgroundExecution: true,
  },
  async (
    input: {
      sync_log_id: string
      limit?: number
      storeId: string
      options: PrintfulPluginOptions
      summaries: PrintfulSyncProductSummary[]
      counters: SyncCounters
    },
    { container }
  ) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const counters = {
      created: input.counters.created,
      updated: input.counters.updated,
      failed: input.counters.failed,
      errors: [...input.counters.errors],
    }

    const removalPolicy: OnRemovedFromPrintful =
      input.options.onRemovedFromPrintful ?? "unpublish"

    if (shouldRunRemovalPass({ policy: removalPolicy, limit: input.limit })) {
      try {
        const seenIds = input.summaries.map((s) => String(s.id))
        const links = await printful.listPrintfulProductLinks(
          { printful_store_id: input.storeId },
          { take: 100_000 }
        )
        const missing = findMissingSyncProductLinks(links, seenIds)

        for (const link of missing) {
          try {
            const product = await productModule.retrieveProduct(
              link.medusa_product_id
            )
            const plan = planRemovedProductWrite({
              policy: removalPolicy,
              currentStatus:
                product.status === "published" ? "published" : "draft",
              currentMetadata: (product.metadata ?? {}) as Record<
                string,
                unknown
              >,
            })

            if (plan.action === "unpublish") {
              await productModule.updateProducts(link.medusa_product_id, {
                status: plan.status,
                metadata: plan.metadata,
              })
              counters.updated += 1
            }
          } catch (err) {
            counters.failed += 1
            const message = err instanceof Error ? err.message : String(err)
            counters.errors.push(
              `Removed product ${link.printful_sync_product_id}: ${message}`
            )
          }

          await printful.heartbeatSyncLog(input.sync_log_id, {
            products_processed: input.summaries.length,
            products_total: input.summaries.length,
          })
        }
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(`Removal pass failed: ${message}`)
        logger.error(`Printful sync removal pass failed: ${message}`)
      }
    }

    if (!input.limit) {
      try {
        const products = await productModule.listProducts(
          {},
          { take: 100_000, relations: ["variants"] }
        )

        const variantsById = new Map(
          products.flatMap((p) =>
            (p.variants ?? []).map((v) => [
              v.id,
              { metadata: v.metadata as Record<string, unknown> | null },
            ])
          )
        )

        const writes = planBundlePass({
          bundles: products as ProductForBundlePass[],
          variantsById,
        })

        for (const write of writes) {
          try {
            await productModule.updateProducts(write.product_id, {
              status: write.status,
              metadata: write.metadata,
            })
            counters.updated += 1
            logger.info(
              `Printful sync: bundle ${write.product_id} → ${write.status}` +
                (write.missing.length
                  ? ` (unavailable: ${write.missing.join(", ")})`
                  : "")
            )
          } catch (err) {
            counters.failed += 1
            const message = err instanceof Error ? err.message : String(err)
            counters.errors.push(`Bundle ${write.product_id}: ${message}`)
          }
        }
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(`Bundle pass failed: ${message}`)
        logger.error(`Printful sync bundle pass failed: ${message}`)
      }
    }

    return new StepResponse(counters)
  }
)

const finalizeSyncLogStep = createStep(
  "printful-finalize-sync-log",
  async (input: { logId: string; counters: SyncCounters }, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    try {
      const status = planSyncLogStatus(input.counters)
      const log = await printful.updatePrintfulSyncLogs({
        id: input.logId,
        status,
        finished_at: new Date(),
        products_created: input.counters.created,
        products_updated: input.counters.updated,
        products_failed: input.counters.failed,
        error_message:
          input.counters.errors.length > 0
            ? input.counters.errors.slice(0, 20).join("\n")
            : null,
      })
      logger.info(
        `Printful sync completed with status ${status}: ` +
          `${input.counters.created} created, ` +
          `${input.counters.updated} updated, ` +
          `${input.counters.failed} failed`
      )
      return new StepResponse(log)
    } catch (err) {
      logger.error(
        `Printful sync could not finalize log ${input.logId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      throw err
    }
  }
)

export const syncProductsWorkflow = createWorkflow(
  "printful-sync-products",
  (input: SyncProductsInput) => {
    const fetchRes = fetchPrintfulProductsStep(input)

    const mapRes = mapToMedusaProductsStep({
      sync_log_id: input.sync_log_id,
      toProcess: fetchRes.toProcess,
      details: fetchRes.details,
      options: fetchRes.options,
      storeId: fetchRes.storeId,
      initialCounters: fetchRes.initialCounters,
    })

    const createProductsInput = transform(
      { productsToCreate: mapRes.productsToCreate },
      (data) => ({
        input: { products: data.productsToCreate },
      })
    )
    const createdProducts =
      createProductsWorkflow.runAsStep(createProductsInput)

    updateMedusaProductsStep(mapRes.productsToUpdate)

    const batchVariantsInput = transform(
      {
        variantsToCreate: mapRes.variantsToCreate,
        variantsToUpdate: mapRes.variantsToUpdate,
      },
      (data) => ({
        input: {
          create: data.variantsToCreate,
          update: data.variantsToUpdate,
        },
      })
    )
    batchProductVariantsWorkflow.runAsStep(batchVariantsInput)

    const linkRes = syncLinksStep({
      createdProducts,
      linksToCreate: mapRes.linksToCreate,
      linksToUpdate: mapRes.linksToUpdate,
      reconcileItems: mapRes.reconcileItems,
      storeId: fetchRes.storeId,
      counters: mapRes.counters,
    })

    const finalCounters = removalsAndBundlesStep({
      sync_log_id: input.sync_log_id,
      limit: input.limit,
      storeId: fetchRes.storeId,
      options: fetchRes.options,
      summaries: fetchRes.toProcess,
      counters: linkRes.counters,
    })

    const finalizeInput = transform(
      { input, counters: finalCounters },
      (data) => ({
        logId: data.input.sync_log_id,
        counters: data.counters as SyncCounters,
      })
    )

    const finalLog = finalizeSyncLogStep(finalizeInput)

    return new WorkflowResponse({
      sync_log: finalLog,
      counters: finalCounters,
    })
  }
)

export default syncProductsWorkflow
