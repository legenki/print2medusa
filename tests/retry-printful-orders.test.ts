import { beforeEach, describe, expect, it, vi } from "vitest"

const run = vi.fn()
vi.mock("../src/workflows/create-printful-order", () => ({
  default: () => ({ run }),
}))

import retryPrintfulOrders from "../src/jobs/retry-printful-orders"
import { CLAIM_IN_FLIGHT_MS } from "../src/utils/order-idempotency"

function container(links: unknown[]) {
  const logger = { info: vi.fn(), error: vi.fn() }
  const printful = {
    listUnresolvedOrderLinks: vi.fn().mockResolvedValue(links),
  }
  return {
    logger,
    container: {
      resolve: (key: string) => (key === "printful" ? printful : logger),
    } as never,
  }
}

const old = new Date(Date.now() - CLAIM_IN_FLIGHT_MS - 60_000)

describe("retryPrintfulOrders", () => {
  beforeEach(() => {
    run.mockReset()
    run.mockResolvedValue({ result: { skipped: true, reason: "x" } })
  })

  it("re-runs the create workflow for a stranded claim", async () => {
    const { container: c } = container([
      { medusa_order_id: "order_1", created_at: old, last_attempt_at: null },
    ])
    await retryPrintfulOrders(c)
    expect(run).toHaveBeenCalledWith({ input: { order_id: "order_1" } })
  })

  it("leaves a claim that may belong to a create still running", async () => {
    const { container: c } = container([
      { medusa_order_id: "order_1", created_at: new Date() },
    ])
    await retryPrintfulOrders(c)
    expect(run).not.toHaveBeenCalled()
  })

  it("keeps going when one order fails", async () => {
    run.mockRejectedValueOnce(new Error("printful down"))
    const { container: c, logger } = container([
      { medusa_order_id: "order_1", created_at: old },
      { medusa_order_id: "order_2", created_at: old },
    ])
    await retryPrintfulOrders(c)
    expect(run).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
