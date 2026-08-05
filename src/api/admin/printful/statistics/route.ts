import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"

/** Days of history when the caller does not ask for a range. */
const DEFAULT_DAYS = 30

/**
 * Reports the admin page renders. Asking for only these keeps the response
 * small; Printful also offers per-product and per-variant breakdowns, which
 * nothing displays yet and which would be paid for on every page load.
 */
const REPORT_TYPES = "profit,total_paid_orders,average_fulfillment_time"

const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * Sales statistics for the admin page.
 *
 * Unlike `/health`, this one genuinely has to call Printful — the figures do
 * not exist locally. So the failure is handled rather than propagated: an
 * outage answers `200` with an empty list and a `reason`, not a `500`. The
 * page fetches three panels independently and a thrown error here would take
 * out the one screen an owner opens *because* something is wrong.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  const query = req.query as Record<string, unknown>
  const now = new Date()
  const from = new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000)

  const dateFrom =
    typeof query.date_from === "string" && query.date_from
      ? query.date_from
      : isoDate(from)
  const dateTo =
    typeof query.date_to === "string" && query.date_to
      ? query.date_to
      : isoDate(now)

  try {
    const client = await printful.getClient()
    const statistics = await client.getStatistics({
      dateFrom,
      dateTo,
      reportTypes: REPORT_TYPES,
    })

    res.status(200).json({ statistics, date_from: dateFrom, date_to: dateTo })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Printful statistics unavailable: ${message}`)

    // 200 with an empty list, not an error status: the page treats this as
    // "nothing to show" and keeps rendering sync history and webhook health,
    // which are exactly what an operator needs during a Printful outage.
    res.status(200).json({
      statistics: [],
      date_from: dateFrom,
      date_to: dateTo,
      reason: "printful_unreachable",
    })
  }
}
