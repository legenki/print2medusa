import { describe, expect, it, vi } from "vitest"
import prunePrintfulWebhookEvents, {
  config,
} from "../src/jobs/prune-webhook-events"
import { WEBHOOK_EVENT_RETENTION_DAYS } from "../src/modules/printful/service"
import { WEBHOOK_HEALTH_WINDOW } from "../src/utils/webhook-health"

const DAY_MS = 24 * 60 * 60 * 1000

function container(removed: number) {
  const logger = { info: vi.fn() }
  const printful = { pruneWebhookEvents: vi.fn().mockResolvedValue(removed) }
  return {
    logger,
    printful,
    container: {
      resolve: (key: string) => (key === "printful" ? printful : logger),
    } as never,
  }
}

describe("prunePrintfulWebhookEvents", () => {
  it("prunes past the retention period and keeps the health window", async () => {
    const { container: c, printful } = container(0)
    const before = Date.now()
    await prunePrintfulWebhookEvents(c)
    const after = Date.now()

    expect(printful.pruneWebhookEvents).toHaveBeenCalledTimes(1)
    const [cutoff, keepNewest] = printful.pruneWebhookEvents.mock.calls[0]
    const retention = WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS
    expect((cutoff as Date).getTime()).toBeGreaterThanOrEqual(
      before - retention
    )
    expect((cutoff as Date).getTime()).toBeLessThanOrEqual(after - retention)
    expect(keepNewest).toBe(WEBHOOK_HEALTH_WINDOW)
  })

  it("logs what it removed", async () => {
    const { container: c, logger } = container(3)
    await prunePrintfulWebhookEvents(c)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("removed 3 settled webhook event(s)")
    )
  })

  it("stays quiet when there was nothing to remove", async () => {
    const { container: c, logger } = container(0)
    await prunePrintfulWebhookEvents(c)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it("runs once a day", () => {
    expect(config.schedule.split(" ").slice(2)).toEqual(["*", "*", "*"])
  })
})
