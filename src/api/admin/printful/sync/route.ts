import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import syncProductsWorkflow from "../../../../workflows/sync-products"

/**
 * Start a catalog sync.
 *
 * The claim completes before this responds. Doing it inside the background
 * step would let two requests both answer 202 before either reached the
 * insert, which is exactly the race the unique index exists to prevent.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const logger: { error: (msg: string) => void } = req.scope.resolve(
    ContainerRegistrationKeys.LOGGER
  )
  const options = await printful.getOptions()

  const limit =
    typeof req.body === "object" &&
    req.body &&
    "limit" in req.body &&
    req.body.limit != null
      ? Number((req.body as { limit?: number }).limit)
      : undefined

  const claim = await printful.claimSyncLog(options.syncStaleMinutes ?? 60)

  if (!claim) {
    const running = await printful.getRunningSyncLog()
    res.status(409).json({
      message: "A Printful sync is already running",
      running_sync_id: running?.id,
      started_at: running?.started_at,
      heartbeat_at: running?.heartbeat_at,
    })
    return
  }

  // Deliberately not awaited: the step is backgroundExecution, and the point
  // of this release is that the admin gets an answer immediately rather than
  // holding the request open for a 500-product catalog. The scheduled job in
  // src/jobs/sync-products.ts DOES await the same workflow — it serves no HTTP
  // response and wants the counters to log.
  void syncProductsWorkflow(req.scope)
    .run({
      input: {
        sync_log_id: claim.id,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
    })
    .catch((err) => {
      logger.error(
        `Printful sync ${claim.id} failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    })

  res.status(202).json({ sync_id: claim.id })
}
