import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"

/** Rows per page. Enough to cover a week of hourly syncs on one screen. */
const DEFAULT_LIMIT = 20

/**
 * Hard ceiling on `limit`. The admin page never asks for more than the
 * default; this only stops a hand-crafted `?limit=100000` from paging the
 * whole table into memory to render a list nobody reads.
 */
const MAX_LIMIT = 100

function parsePositiveInt(
  value: unknown,
  fallback: number,
  max: number
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(Math.floor(parsed), max)
}

/**
 * Recent sync runs, newest first.
 *
 * Ordered by `started_at DESC` to match `getLatestSyncLog`, so the first row
 * here is always the same run the status widget calls "latest". Ordering by
 * `finished_at` instead would sort a still-running sync (finished_at null) to
 * an arbitrary end of the list.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)

  const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT)
  const offset = Math.max(0, Number(req.query.offset) || 0)

  const logs = await printful.listPrintfulSyncLogs(
    {},
    { take: limit, skip: offset, order: { started_at: "DESC" } }
  )

  res.status(200).json({
    syncs: logs.map((log) => ({
      id: log.id,
      status: log.status,
      started_at: log.started_at,
      finished_at: log.finished_at,
      heartbeat_at: log.heartbeat_at,
      products_created: log.products_created,
      products_updated: log.products_updated,
      products_failed: log.products_failed,
      products_processed: log.products_processed,
      products_total: log.products_total,
      error_message: log.error_message,
    })),
    limit,
    offset,
  })
}
