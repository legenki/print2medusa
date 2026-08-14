import { describe, expect, it, vi } from "vitest"
import { reconcileClaim } from "../src/workflows/create-printful-order"
import { PrintfulApiError } from "../src/utils/errors"

/**
 * These cover the decision that costs real money.
 *
 * A create whose outcome is unknown must never lead to a second POST: the
 * customer's item gets printed and shipped twice. Holding a claim that turns
 * out to be unnecessary only stalls one order, visibly, and is recoverable.
 * Every branch below is that trade-off.
 */

const ORDER_ID = "order_01JQ8ZK3M9XN2VWTB7YHRF"
const CLAIM_ID = "pol_01"

function harness(clientImpl: { getOrderByExternalId: () => Promise<unknown> }) {
  const updates: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const errors: string[] = []

  const printful = {
    updatePrintfulOrderLinks: vi.fn(async (patch: Record<string, unknown>) => {
      updates.push(patch)
    }),
    deletePrintfulOrderLinks: vi.fn(async (id: string) => {
      deleted.push(id)
    }),
  }

  const logger = {
    info: vi.fn(),
    error: vi.fn((m: string) => errors.push(m)),
  }

  return {
    updates,
    deleted,
    errors,
    printful,
    logger,
    call: () =>
      reconcileClaim({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        printful: printful as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: clientImpl as any,
        logger,
        medusaOrderId: ORDER_ID,
        claimId: CLAIM_ID,
        cause: new Error("socket hang up"),
      }),
  }
}

describe("reconcileClaim", () => {
  it("adopts an order that exists — the response was lost, not the order", async () => {
    const h = harness({
      getOrderByExternalId: async () => ({ id: 55501, status: "pending" }),
    })

    const out = await h.call()

    expect(out.status).toBe("found")
    expect(out.status === "found" && out.order.id).toBe(55501)
    // The claim is completed in place; nothing is created a second time.
    expect(h.deleted).toEqual([])
    expect(h.updates).toEqual([
      {
        id: CLAIM_ID,
        printful_order_id: "55501",
        status: "pending",
        error_message: null,
        last_attempt_at: null,
      },
    ])
  })

  it("releases the claim when Printful says the order does not exist", async () => {
    // 404 is an authoritative answer, so a retry may safely create it.
    const h = harness({
      getOrderByExternalId: async () => {
        throw new PrintfulApiError("not found", { status: 404 })
      },
    })

    const out = await h.call()

    expect(out.status).toBe("released")
    expect(h.deleted).toEqual([CLAIM_ID])
  })

  it("holds the claim when the lookup itself fails", async () => {
    // The outcome is still unknown. Releasing here is exactly what would let
    // the next payment.captured print a duplicate.
    const h = harness({
      getOrderByExternalId: async () => {
        throw new PrintfulApiError("gateway timeout", { status: 504 })
      },
    })

    const out = await h.call()

    expect(out.status).toBe("held")
    expect(h.deleted).toEqual([])
  })

  it("marks a held claim so an operator can find it", async () => {
    const h = harness({
      getOrderByExternalId: async () => {
        throw new Error("ETIMEDOUT")
      },
    })

    await h.call()

    expect(h.updates).toHaveLength(1)
    const patch = h.updates[0]
    expect(patch.id).toBe(CLAIM_ID)
    expect(patch.status).toBe("unverified")
    expect(String(patch.error_message)).toContain("socket hang up")
    expect(String(patch.error_message)).toContain("ETIMEDOUT")
    expect(patch.last_attempt_at).toBeInstanceOf(Date)
  })

  it("still holds the claim when the audit write fails", async () => {
    // The claim row is what prevents the duplicate; failing to annotate it
    // must not escalate into releasing it.
    const h = harness({
      getOrderByExternalId: async () => {
        throw new Error("ECONNRESET")
      },
    })
    h.printful.updatePrintfulOrderLinks.mockRejectedValueOnce(
      new Error("db unavailable")
    )

    const out = await h.call()

    expect(out.status).toBe("held")
    expect(h.deleted).toEqual([])
  })

  it("logs enough to act on when holding a claim", async () => {
    const h = harness({
      getOrderByExternalId: async () => {
        throw new Error("ECONNRESET")
      },
    })

    await h.call()

    expect(h.errors.join("\n")).toContain(ORDER_ID)
    expect(h.errors.join("\n")).toContain("ECONNRESET")
  })

  it("is idempotent: two concurrent recoveries settle on the same order", async () => {
    // Both read the same order and write the same id onto the same row, so a
    // duplicated recovery is harmless.
    const h = harness({
      getOrderByExternalId: async () => ({ id: 777, status: "draft" }),
    })

    const [a, b] = await Promise.all([h.call(), h.call()])

    expect(a).toEqual(b)
    expect(h.deleted).toEqual([])
    expect(h.updates[0]).toEqual(h.updates[1])
  })

  it("falls back to 'created' when Printful returns no status", async () => {
    const h = harness({
      getOrderByExternalId: async () => ({ id: 1, status: "" }),
    })

    await h.call()

    expect(h.updates[0].status).toBe("created")
  })
})
