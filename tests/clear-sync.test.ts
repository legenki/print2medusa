import { describe, expect, it } from "vitest"
import {
  CLEAR_SYNC_CONFIRMATION,
  CLEARED_BY_OPERATOR,
  planSyncClear,
  type ClearableSyncLog,
} from "../src/utils/clear-sync"

const NOW = new Date("2026-06-01T12:00:00.000Z")
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000)

function running(over: Partial<ClearableSyncLog> = {}): ClearableSyncLog {
  return {
    id: "sync_1",
    status: "running",
    started_at: minutesAgo(90),
    heartbeat_at: minutesAgo(90),
    ...over,
  }
}

describe("planSyncClear", () => {
  it("clears a running sync whose heartbeat went stale", () => {
    // The scenario the route exists for: the process died 90 minutes ago and
    // the row still says `running`, blocking the catalog.
    const decision = planSyncClear({
      log: running(),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.sync_id).toBe("sync_1")
    // The marker leads, with the evidence the operator acted on appended.
    expect(decision.error_message).toContain(CLEARED_BY_OPERATOR)
    expect(decision.error_message).toContain("90m")
  })

  it("refuses a sync that is actively heartbeating", () => {
    // THE guard. A live sync keeps writing to the row it owns. Marking it
    // failed underneath does not stop it — it produces a `failed` row that a
    // running process is still updating, and frees the claim so a SECOND sync
    // can start against the same catalog.
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(0) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("alive")
  })

  it("refuses a sync heartbeating just inside the stale window", () => {
    // Boundary: 4 minutes of silence with a 5 minute window is still alive.
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(4) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("alive")
  })

  it("clears once silence passes the stale window exactly", () => {
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(5) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(true)
  })

  it("clears a running sync that never got a heartbeat", () => {
    // A crash between the claim insert and the first heartbeat leaves null.
    // Fall back to started_at so this is not permanently unclearable.
    const decision = planSyncClear({
      log: running({ heartbeat_at: null, started_at: minutesAgo(30) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(true)
  })

  it("refuses a just-claimed sync that has no heartbeat yet", () => {
    // Same null heartbeat, but the claim is seconds old — that sync is very
    // probably starting up, not dead.
    const decision = planSyncClear({
      log: running({ heartbeat_at: null, started_at: minutesAgo(1) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("alive")
  })

  it("refuses without the confirmation phrase", () => {
    // Clearing is destructive, so it must not be reachable by a bare POST.
    const decision = planSyncClear({
      log: running(),
      confirmation: undefined,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("unconfirmed")
  })

  it("refuses a confirmation phrase that does not match exactly", () => {
    const decision = planSyncClear({
      log: running(),
      confirmation: "yes",
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("unconfirmed")
  })

  it("checks the confirmation before the heartbeat", () => {
    // An unconfirmed request against a live sync should be told it is
    // unconfirmed; reporting `alive` would imply that confirming is enough.
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(0) }),
      confirmation: undefined,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("unconfirmed")
  })

  it("reports nothing to clear when no sync is running", () => {
    const decision = planSyncClear({
      log: null,
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("nothing_running")
  })

  it("reports nothing to clear when the latest sync already finished", () => {
    const decision = planSyncClear({
      log: running({ status: "success", heartbeat_at: minutesAgo(90) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("nothing_running")
  })

  it("records a marker distinct from the timeout reaper's", () => {
    // Six months later the log has to say which happened. `reapStaleSyncLogs`
    // writes "stale_running"; a human-cleared row must not be mistaken for
    // one the timeout reclaimed on its own.
    const decision = planSyncClear({
      log: running(),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.error_message).not.toBe("stale_running")
    expect(decision.error_message).toContain("cleared_by_operator")
  })

  it("carries how long the sync had been silent into the audit trail", () => {
    // So the log records not just that a human cleared it, but the evidence
    // they acted on.
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(42) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 5,
      now: NOW,
    })

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.silent_minutes).toBe(42)
  })

  it("treats a non-positive stale window as still requiring silence", () => {
    // Guards against the obvious foot-gun of calling reapStaleSyncLogs(0):
    // a zero window must not make a live sync clearable.
    const decision = planSyncClear({
      log: running({ heartbeat_at: minutesAgo(0) }),
      confirmation: CLEAR_SYNC_CONFIRMATION,
      staleMinutes: 0,
      now: NOW,
    })

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.reason).toBe("alive")
  })
})
