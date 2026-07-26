import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import syncProductsWorkflow from "../../../../workflows/sync-products"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const limit =
    typeof req.body === "object" &&
    req.body &&
    "limit" in req.body &&
    req.body.limit != null
      ? Number((req.body as { limit?: number }).limit)
      : undefined

  const { result } = await syncProductsWorkflow(req.scope).run({
    input: {
      limit: Number.isFinite(limit) ? limit : undefined,
    },
  })

  res.status(200).json({
    sync_log: result.sync_log,
    counters: result.counters,
  })
}
