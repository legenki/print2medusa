import { describe, expect, it } from "vitest"
import { OrphanTracker } from "../src/utils/orphans"

describe("OrphanTracker", () => {
  it("keeps a created-but-unlinked product", () => {
    const tracker = new OrphanTracker()
    tracker.track("prod_1")
    expect(tracker.toDelete()).toEqual(["prod_1"])
  })

  it("drops a product once its link row exists", () => {
    const tracker = new OrphanTracker()
    tracker.track("prod_1")
    tracker.release("prod_1")
    expect(tracker.toDelete()).toEqual([])
  })

  it("leaves already-synced products alone when a later product fails", () => {
    // The scenario the compensation exists for: a catalog of five, dying on
    // the third. Products 1 and 2 are created AND linked. Product 3 is created
    // and then the sync throws before its link row is written.
    const tracker = new OrphanTracker()

    for (const id of ["prod_1", "prod_2"]) {
      tracker.track(id)
      tracker.release(id)
    }
    tracker.track("prod_3")

    // Only the unlinked one. If this returned prod_1 or prod_2, the rollback
    // would delete two products that synced fine — the failure mode that
    // matters, because those are live and reachable by their link rows.
    expect(tracker.toDelete()).toEqual(["prod_3"])
  })

  it("has nothing to delete when every product linked", () => {
    const tracker = new OrphanTracker()
    for (const id of ["prod_1", "prod_2", "prod_3"]) {
      tracker.track(id)
      tracker.release(id)
    }
    expect(tracker.toDelete()).toEqual([])
  })

  it("ignores a release for an untracked id", () => {
    // Defensive: a release must never remove the wrong entry.
    const tracker = new OrphanTracker()
    tracker.track("prod_1")
    tracker.release("prod_unknown")
    expect(tracker.toDelete()).toEqual(["prod_1"])
  })

  it("does not let the caller mutate the pending list", () => {
    const tracker = new OrphanTracker()
    tracker.track("prod_1")
    tracker.toDelete().push("prod_2")
    expect(tracker.toDelete()).toEqual(["prod_1"])
  })
})
