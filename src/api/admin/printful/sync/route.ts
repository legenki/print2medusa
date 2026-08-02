import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import syncProductsWorkflow from "../../../../workflows/sync-products"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const limit =
    typeof req.body === "object" &&
    req.body &&
    "limit" in req.body &&
    req.body.limit != null
      ? Number((req.body as { limit?: number }).limit)
      : undefined

  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()
  const claim = await printful.claimSyncLog(options.syncStaleMinutes ?? 60)

  if (!claim) {
    const running = await printful.getRunningSyncLog()
    res.status(409).json({
      message: "A Printful sync is already running.",
      sync_log: running,
    })
    return
  }

  const { result } = await syncProductsWorkflow(req.scope).run({
    input: {
      sync_log_id: claim.id,
      limit: Number.isFinite(limit) ? limit : undefined,
    },
  })

  res.status(200).json({
    sync_log: result.sync_log,
    counters: result.counters,
  })
}
