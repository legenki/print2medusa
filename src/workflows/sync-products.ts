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

export type SyncProductsInput = {
  /** The claimed sync log. The workflow never claims — the route already did. */
  sync_log_id: string
  /** Optional limit for testing or a partial sync. */
  limit?: number
}

type SyncCounters = {
  created: number
  updated: number
  failed: number
  errors: string[]
}

const syncProductsStep = createStep(
  {
    name: "printful-sync-products",
    // Runs past the HTTP response and completes on its own — no
    // setStepSuccess needed, which is what backgroundExecution adds to async.
    async: true,
    backgroundExecution: true,
    // No timeout on purpose. Medusa schedules one only when the step sets it
    // (TransactionStep.hasTimeout() returns !!definition.timeout, and
    // transaction-orchestrator.js:637 guards on it), so omitting it is the
    // safe state. Any value we picked could be exceeded by a large enough
    // catalog, and the penalty is a SUCCESSFUL sync being reverted — deleting
    // the orphans it was about to link.
  },
  async (input: SyncProductsInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const client = await printful.getClient()
    const options = await printful.getOptions()
    const storeId = await printful.getStoreId()

    const summaries = await client.listAllSyncProducts({
      limit: 100,
    })

    const toProcess =
      input.limit != null ? summaries.slice(0, input.limit) : summaries

    const counters: SyncCounters = {
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    }

    // Products created but not yet linked. A crash leaves exactly these
    // invisible to the next sync's findProductLink, so they are the only
    // thing the compensation may delete.
    const orphans = new OrphanTracker()

    let processed = 0
    await printful.heartbeatSyncLog(input.sync_log_id, {
      products_total: toProcess.length,
    })

    for (const summary of toProcess) {
      if (summary.is_ignored) {
        continue
      }

      // Scoped to this iteration so the catch below knows which product, if
      // any, this pass created. Set the moment the product exists in Medusa
      // and cleared once its link row is written.
      let pendingProductId: string | undefined

      try {
        const detail = await client.getSyncProduct(summary.id)
        if (!detail.sync_variants?.length) {
          counters.failed += 1
          counters.errors.push(`Product ${summary.id} has no variants`)
          continue
        }

        // Pass the options wholesale rather than picking fields. Hand-building
        // this object is how `onDiscontinued` was silently dropped: every field
        // is optional, so omitting one is legal TypeScript and typecheck stayed
        // green while the option did nothing. The mapper narrows internally.
        const mapped = mapSyncProductToMedusa(detail, options)

        const existingLink = await printful.findProductLink(String(summary.id))

        if (existingLink?.medusa_product_id) {
          const productId = existingLink.medusa_product_id

          // Retrieved before the update so the current status and metadata are
          // the merchant's, not ours. `mapped.status` is derived from Printful
          // stock alone; writing it directly is what republished a product the
          // merchant had deliberately drafted.
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

          // Update core product fields.
          await productModule.updateProducts(productId, {
            title: mapped.title,
            thumbnail: mapped.thumbnail,
            metadata: publication.metadata,
            status: publication.status,
          })

          // Upsert variants so price/assortment changes in Printful reach Medusa.
          const { toCreate, toUpdate } = diffVariantsForUpsert(
            mapped.variants,
            (product.variants ?? []).map((pv) => ({
              id: pv.id,
              metadata: pv.metadata,
            }))
          )

          if (toUpdate.length) {
            await batchProductVariantsWorkflow(container).run({
              input: {
                update: toUpdate.map((u) => ({
                  id: u.id,
                  title: u.title,
                  prices: u.prices,
                  metadata: u.metadata,
                })),
              },
            })
          }

          if (toCreate.length) {
            await batchProductVariantsWorkflow(container).run({
              input: {
                create: toCreate.map((c) => ({
                  product_id: productId,
                  title: c.title,
                  sku: c.sku,
                  options: c.options,
                  prices: c.prices,
                  metadata: c.metadata,
                  manage_inventory: c.manage_inventory,
                  allow_backorder: c.allow_backorder,
                })),
              },
            })
            // No link loop here: the reconcile below re-reads the product, so
            // these new variants are in its scope and get linked there.
          }

          // Refresh existing variant links AND create any that are missing.
          // Re-read the variants so freshly-created ones are in scope; the
          // copy fetched for the diff predates the batch create above.
          //
          // The refresh-only loop this replaces could never repair a link row
          // that failed to write, because `diffVariantsForUpsert` matches on
          // variant metadata rather than link rows — so the variant looked
          // already-synced and its row was never written again.
          const linked = await productModule.retrieveProduct(productId, {
            relations: ["variants"],
          })
          await reconcileVariantLinks(printful, {
            storeId,
            syncProductId: String(summary.id),
            syncVariantIds: detail.sync_variants.map((v) => v.id),
            medusaVariants: (linked.variants ?? []).map((pv) => ({
              id: pv.id,
              metadata: pv.metadata,
            })),
          })

          await printful.updatePrintfulProductLinks({
            id: existingLink.id,
            last_synced_at: new Date(),
          })
          counters.updated += 1
        } else {
          // Ensure unique handle if collision
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
            // ignore lookup errors
          }

          // A product created already sold out is drafted by the mapper, but
          // the mapper writes no marker — so without this the restock path
          // would read it as a merchant's own draft and never republish it.
          const createStock = planStockActions(detail.sync_variants)
          const createMetadata: Record<string, unknown> = {
            ...mapped.metadata,
            ...(createStock.allUnavailable
              ? { [STOCK_MARKER_KEY]: "unavailable" }
              : {}),
          }

          const { result } = await createProductsWorkflow(container).run({
            input: {
              products: [
                {
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
                },
              ],
            },
          })

          const created = result[0]
          orphans.track(created.id)
          pendingProductId = created.id

          await printful.createPrintfulProductLinks({
            printful_store_id: storeId,
            printful_sync_product_id: String(summary.id),
            medusa_product_id: created.id,
            last_synced_at: new Date(),
          })

          // Linked — no longer an orphan, and never to be deleted.
          orphans.release(created.id)
          pendingProductId = undefined

          // Resumable rather than best-effort: a throw here used to abandon
          // every remaining variant, and because the product link row above
          // already exists, the next sync took the update path and never went
          // back for them. Now one unwritable row costs only that row, and the
          // next sync's reconcile picks it up.
          await reconcileVariantLinks(printful, {
            storeId,
            syncProductId: String(summary.id),
            syncVariantIds: detail.sync_variants.map((v) => v.id),
            medusaVariants: (created.variants ?? []).map((variant) => ({
              id: variant.id,
              metadata: variant.metadata,
            })),
          })

          counters.created += 1
        }
      } catch (err) {
        counters.failed += 1
        const message = err instanceof Error ? err.message : String(err)
        counters.errors.push(`Product ${summary.id}: ${message}`)

        // The product was created but its link write never landed. The loop
        // continues and the step still SUCCEEDS, so compensation — which runs
        // only on step failure — will never see this. Left alone it is a
        // product stranded in Medusa with no link row: invisible to the next
        // sync's findProductLink, which duplicates it.
        if (pendingProductId) {
          const orphanId = pendingProductId
          try {
            await productModule.deleteProducts([orphanId])
            // Released only after a delete that actually happened, so a
            // failure here still leaves it for the compensation to retry.
            orphans.release(orphanId)
          } catch (deleteErr) {
            // Must not mask the original error — that is what gets reported.
            logger.error(
              `Printful sync: could not delete orphaned product ${orphanId} after a failed link write: ${
                deleteErr instanceof Error
                  ? deleteErr.message
                  : String(deleteErr)
              }`
            )
          }
        }
      } finally {
        pendingProductId = undefined
        // In `finally` so it runs however the product exited — success, an
        // early `continue`, or a throw. The heartbeat is what keeps the claim
        // from being reaped, so a catalog of failures must not starve it.
        processed += 1
        await printful.heartbeatSyncLog(input.sync_log_id, {
          products_processed: processed,
          products_total: toProcess.length,
        })
      }
    }

    return new StepResponse(counters, { orphanProductIds: orphans.toDelete() })
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

    // Delete through the product module so variants, prices, and images go
    // with the product rather than being orphaned a second time.
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

const finalizeSyncLogStep = createStep(
  "printful-finalize-sync-log",
  async (input: { logId: string; counters: SyncCounters }, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const log = await printful.updatePrintfulSyncLogs({
      id: input.logId,
      status: planSyncLogStatus(input.counters),
      finished_at: new Date(),
      products_created: input.counters.created,
      products_updated: input.counters.updated,
      products_failed: input.counters.failed,
      error_message:
        input.counters.errors.length > 0
          ? input.counters.errors.slice(0, 20).join("\n")
          : null,
    })

    return new StepResponse(log)
  }
)

export const syncProductsWorkflow = createWorkflow(
  "printful-sync-products",
  (input: SyncProductsInput) => {
    const counters = syncProductsStep(input)
    const finalizeInput = transform({ input, counters }, (data) => ({
      logId: data.input.sync_log_id,
      counters: data.counters as SyncCounters,
    }))
    const finalLog = finalizeSyncLogStep(finalizeInput)

    return new WorkflowResponse({
      sync_log: finalLog,
      counters,
    })
  }
)

export default syncProductsWorkflow
