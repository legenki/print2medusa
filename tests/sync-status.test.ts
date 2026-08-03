import { describe, expect, it } from "vitest"
import { planSyncLogStatus } from "../src/utils/sync-status"

describe("planSyncLogStatus", () => {
  it("reports success when nothing failed", () => {
    expect(planSyncLogStatus({ created: 5, updated: 3, failed: 0 })).toBe(
      "success"
    )
  })

  it("reports failed when everything failed", () => {
    expect(planSyncLogStatus({ created: 0, updated: 0, failed: 12 })).toBe(
      "failed"
    )
  })

  it("reports partial when something failed but something also succeeded", () => {
    // The bug this pins: 100 failures plus a single successful update used to
    // report a green "success", so the admin widget claimed a healthy sync
    // while most of the catalog never imported.
    expect(planSyncLogStatus({ created: 0, updated: 1, failed: 100 })).toBe(
      "partial"
    )
    expect(planSyncLogStatus({ created: 1, updated: 0, failed: 100 })).toBe(
      "partial"
    )
    expect(planSyncLogStatus({ created: 4, updated: 7, failed: 2 })).toBe(
      "partial"
    )
  })

  it("reports success for a run that did nothing at all", () => {
    // An empty Printful store is not a failure; there was simply nothing to do.
    expect(planSyncLogStatus({ created: 0, updated: 0, failed: 0 })).toBe(
      "success"
    )
  })

  it("treats a single failure beside a single success as partial", () => {
    // The boundary between "failed" and "partial" is one unit of success.
    expect(planSyncLogStatus({ created: 0, updated: 0, failed: 1 })).toBe(
      "failed"
    )
    expect(planSyncLogStatus({ created: 1, updated: 0, failed: 1 })).toBe(
      "partial"
    )
  })
})
