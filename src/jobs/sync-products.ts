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

  logger.info(`Printful scheduled sync ${claim.id} starting`)
  try {
    // The workflow's steps run in the background, so `run` returns once it is
    // under way — not when it finishes, and with no counters to report. The
    // workflow logs its own outcome when it finalizes the sync log, and marks
    // the log failed if any step throws.
    await syncProductsWorkflow(container).run({
      input: { sync_log_id: claim.id },
    })
  } catch (err) {
    logger.error(
      `Printful scheduled sync ${claim.id} failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    await printful
      .failRunningSyncLog(claim.id, "workflow_failed_to_start")
      .catch(() => undefined)
  }
}

export const config = {
  name: "printful-sync-products",
  schedule: "0 3 * * *",
}
