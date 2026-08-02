import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import syncProductsWorkflow from "../workflows/sync-products"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"

/**
 * Optional scheduled full sync.
 * Enable by ensuring jobs are loaded (default in plugins).
 * Schedule: daily at 03:00 UTC — adjust as needed.
 */
export default async function syncPrintfulProductsJob(
  container: MedusaContainer
) {
  const logger: {
    info: (m: string) => void
    error: (m: string) => void
  } = container.resolve(ContainerRegistrationKeys.LOGGER)

  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()

  const claim = await printful.claimSyncLog(options.syncStaleMinutes ?? 60)
  if (!claim) {
    // A manual sync is already covering the catalog. Not a problem.
    logger.info("Printful scheduled sync skipped: another sync is running")
    return
  }

  logger.info("Printful scheduled sync starting")
  try {
    // Awaited on purpose, unlike the admin route in
    // src/api/admin/printful/sync/route.ts. That route must answer 202 without
    // waiting for a 500-product catalog; this job serves no HTTP response, and
    // awaiting is what gives it counters worth logging.
    const { result } = await syncProductsWorkflow(container).run({
      input: { sync_log_id: claim.id },
    })
    logger.info(
      `Printful scheduled sync done: created=${result.counters.created} updated=${result.counters.updated} failed=${result.counters.failed}`
    )
  } catch (err) {
    logger.error(
      `Printful scheduled sync failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

export const config = {
  name: "printful-sync-products",
  schedule: "0 3 * * *",
}
