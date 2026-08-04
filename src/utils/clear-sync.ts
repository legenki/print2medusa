/**
 * Exact phrase the caller must send to clear a stuck sync.
 *
 * Clearing is destructive, so it must not be reachable by an empty POST. A
 * typed phrase makes the operator's intent explicit and unambiguous in the
 * request itself — a boolean `force: true` is too easy to send by accident
 * from a curl line or a mis-wired button.
 */
export const CLEAR_SYNC_CONFIRMATION = "clear-stuck-sync"

/**
 * Audit marker written to `error_message` when a human clears a sync.
 *
 * `reapStaleSyncLogs` writes the bare string "stale_running" when the timeout
 * reclaims a row on its own. These two must never be confused: one says the
 * system recovered by itself after `syncStaleMinutes`, the other says a person
 * decided the sync was dead and intervened. Anyone reading this log six months
 * from now needs to be able to tell those apart.
 */
export const CLEARED_BY_OPERATOR = "cleared_by_operator"

/** The subset of a sync log row the decision needs. */
export type ClearableSyncLog = {
  id: string
  status: string
  started_at?: Date | string | null
  heartbeat_at?: Date | string | null
}

export type ClearSyncRefusal =
  /** No sync is running, so there is nothing to clear. */
  | "nothing_running"
  /** The confirmation phrase was absent or wrong. */
  | "unconfirmed"
  /** The sync is still heartbeating — clearing it would be wrong, not just risky. */
  | "alive"

export type ClearSyncDecision =
  | {
      allowed: true
      sync_id: string
      /** What to record in `error_message`, including the evidence. */
      error_message: string
      /** Minutes of silence observed, rounded down. */
      silent_minutes: number
    }
  | {
      allowed: false
      reason: ClearSyncRefusal
      /** Present when a sync exists but may not be cleared. */
      sync_id?: string
      /** Present for `alive`: how long it had been silent when we looked. */
      silent_minutes?: number
    }

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Decide whether a running sync may be cleared by hand, and what to record.
 *
 * This exists instead of simply exposing `reapStaleSyncLogs(0)`, which would
 * clear ANY running sync unconditionally. That call has no notion of whether
 * the sync is alive: a healthy run mid-catalog would be marked `failed` while
 * its process keeps writing, which both corrupts the log and frees the claim
 * so a second sync can start against the same catalog.
 *
 * Two guards, deliberately layered:
 *
 *  1. The caller must send the confirmation phrase. Checked FIRST, so an
 *     unconfirmed request against a live sync is told it is unconfirmed rather
 *     than being told it is alive — the latter would wrongly imply that
 *     confirming alone would have been enough.
 *  2. The heartbeat must actually be stale. Confirmation proves intent, not
 *     that the operator is right. An operator staring at a widget cannot see
 *     the heartbeat; the server can, and refuses on their behalf.
 *
 * The stale window is clamped to a minimum of one minute so that passing 0 —
 * the exact foot-gun this function replaces — cannot make a live sync
 * clearable.
 *
 * A row with no heartbeat at all falls back to `started_at`. A crash between
 * the claim insert and the first heartbeat leaves `heartbeat_at` null, and
 * such a row must not be permanently unclearable; but a claim made seconds ago
 * is far more likely to be a sync starting up than a dead one.
 */
export function planSyncClear(input: {
  log: ClearableSyncLog | null | undefined
  confirmation: string | null | undefined
  /** Silence required before a sync counts as dead, in minutes. */
  staleMinutes: number
  now?: Date
}): ClearSyncDecision {
  const { log, confirmation, staleMinutes } = input
  const now = input.now ?? new Date()

  if (!log || log.status !== "running") {
    return { allowed: false, reason: "nothing_running" }
  }

  if (confirmation !== CLEAR_SYNC_CONFIRMATION) {
    return { allowed: false, reason: "unconfirmed", sync_id: log.id }
  }

  // Never trust a zero or negative window: that is precisely the call this
  // function exists to prevent.
  const window = Math.max(1, Number.isFinite(staleMinutes) ? staleMinutes : 1)

  const lastSign = toDate(log.heartbeat_at) ?? toDate(log.started_at)
  const silentMs = lastSign ? now.getTime() - lastSign.getTime() : Infinity
  const silentMinutes = Number.isFinite(silentMs)
    ? Math.max(0, Math.floor(silentMs / 60_000))
    : Number.MAX_SAFE_INTEGER

  if (silentMinutes < window) {
    return {
      allowed: false,
      reason: "alive",
      sync_id: log.id,
      silent_minutes: silentMinutes,
    }
  }

  return {
    allowed: true,
    sync_id: log.id,
    error_message: `${CLEARED_BY_OPERATOR}: no heartbeat for ${silentMinutes}m`,
    silent_minutes: silentMinutes,
  }
}
