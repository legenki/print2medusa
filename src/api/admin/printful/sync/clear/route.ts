import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../../modules/printful"
import type PrintfulModuleService from "../../../../../modules/printful/service"
import {
  CLEAR_SYNC_CONFIRMATION,
  planSyncClear,
} from "../../../../../utils/clear-sync"

/**
 * Clear a sync that is stuck in `running`.
 *
 * Nested under `sync/` rather than living at its own top-level path because it
 * acts on exactly the resource `POST /admin/printful/sync` claims — the two
 * belong together, and the 409 body from that route is what sends an operator
 * here. POST, not DELETE: this does not remove the row, it transitions it to a
 * terminal state and writes an audit marker.
 *
 * This closes the limit recorded in 0.4.0: after a crash the log stays
 * `running` and nothing reclaims it until the next sync attempt, so with the
 * default `syncStaleMinutes: 60` the catalog is blocked for up to an hour with
 * no way to intervene.
 *
 * It deliberately does not just call `reapStaleSyncLogs(0)`. That would clear
 * any running sync unconditionally, including a healthy one mid-catalog, and
 * would stamp the row with the same `stale_running` marker the timeout reaper
 * uses — making a human intervention indistinguishable from an automatic
 * recovery in the audit trail. `planSyncClear` owns both decisions.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()

  const body = (req.body ?? {}) as { confirm?: unknown }
  const confirmation = typeof body.confirm === "string" ? body.confirm : null

  const running = await printful.getRunningSyncLog()

  const decision = planSyncClear({
    log: running,
    confirmation,
    staleMinutes: options.syncStaleMinutes ?? 60,
  })

  if (!decision.allowed) {
    if (decision.reason === "nothing_running") {
      // Not an error. The page asked to clear a stuck sync and there is no
      // sync to clear, which is the state the operator wanted.
      res.status(200).json({
        cleared: false,
        reason: "nothing_running",
        message: "No Printful sync is running",
      })
      return
    }

    if (decision.reason === "unconfirmed") {
      res.status(400).json({
        cleared: false,
        reason: "unconfirmed",
        message: `Clearing a sync is destructive. Send { "confirm": "${CLEAR_SYNC_CONFIRMATION}" } to proceed.`,
        sync_id: decision.sync_id,
      })
      return
    }

    // `alive`: the heartbeat says this sync is still running. 409 matches the
    // 409 that POST /admin/printful/sync returns for the same condition — a
    // sync is holding the claim and the caller cannot have it.
    res.status(409).json({
      cleared: false,
      reason: "alive",
      message:
        "This sync is still sending heartbeats. Clearing it would mark a live sync as failed while it keeps writing.",
      sync_id: decision.sync_id,
      silent_minutes: decision.silent_minutes,
    })
    return
  }

  // Conditional on the heartbeat we just read. If the sync emitted one more
  // between that read and this write, it was never dead and the update matches
  // nothing — see clearStuckSyncLog.
  const cleared = await printful.clearStuckSyncLog({
    id: decision.sync_id,
    observedHeartbeatAt: running?.heartbeat_at ?? null,
    errorMessage: decision.error_message,
  })

  if (!cleared) {
    res.status(409).json({
      cleared: false,
      reason: "alive",
      message:
        "This sync sent a heartbeat while the request was being handled, so it is still alive and was left running.",
      sync_id: decision.sync_id,
    })
    return
  }

  res.status(200).json({
    cleared: true,
    sync_id: decision.sync_id,
    error_message: decision.error_message,
    silent_minutes: decision.silent_minutes,
  })
}
