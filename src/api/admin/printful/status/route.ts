import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const latest = await printful.getLatestSyncLog()
  const storeId = await printful.getStoreId()

  res.status(200).json({
    store_id: storeId,
    latest_sync: latest,
    running: latest?.status === "running",
  })
}
