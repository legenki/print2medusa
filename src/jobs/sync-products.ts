import type { MedusaContainer } from "@medusajs/framework/types"
import syncProductsWorkflow from "../workflows/sync-products"

/**
 * Optional scheduled full sync.
 * Enable by ensuring jobs are loaded (default in plugins).
 * Schedule: daily at 03:00 UTC — adjust as needed.
 */
export default async function syncPrintfulProductsJob(
  container: MedusaContainer
) {
  const logger = container.resolve("logger") as {
    info: (m: string) => void
    error: (m: string) => void
  }

  logger.info("Printful scheduled sync starting")
  try {
    const { result } = await syncProductsWorkflow(container).run({
      input: {},
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
