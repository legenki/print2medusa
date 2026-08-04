import { describe, expect, it } from "vitest"
import {
  summarizeWebhookHealth,
  type WebhookHealthRow,
} from "../src/utils/webhook-health"

const at = (iso: string) => new Date(iso)

function row(over: Partial<WebhookHealthRow> = {}): WebhookHealthRow {
  return {
    status: "processed",
    created_at: at("2026-01-01T00:00:00.000Z"),
    processed_at: null,
    ...over,
  }
}

describe("summarizeWebhookHealth", () => {
  it("reports a store that has never received a webhook as none yet", () => {
    // The empty case is the one that must not render as a broken page: a
    // freshly installed plugin has no rows at all, and that is normal.
    const summary = summarizeWebhookHealth([], { secret_set: true })

    expect(summary.total).toBe(0)
    expect(summary.last_event_at).toBeNull()
    expect(summary.ever_received).toBe(false)
    expect(summary.deferred).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.processed).toBe(0)
  })

  it("counts deferred and permanently failed separately", () => {
    // Two very different operator stories. `deferred` is retrying and will
    // likely resolve itself; `failed` has exhausted MAX_WEBHOOK_ATTEMPTS and
    // will never be retried again without intervention. Collapsing them into
    // one "unhealthy" number hides which of the two is happening.
    const summary = summarizeWebhookHealth(
      [
        row({ status: "deferred" }),
        row({ status: "deferred" }),
        row({ status: "failed" }),
        row({ status: "processed" }),
        row({ status: "received" }),
      ],
      { secret_set: true }
    )

    expect(summary.total).toBe(5)
    expect(summary.deferred).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.processed).toBe(1)
    expect(summary.received).toBe(1)
  })

  it("takes the newest arrival regardless of row order", () => {
    // Rows arrive in whatever order the query returned them; the summary must
    // not depend on that.
    const summary = summarizeWebhookHealth(
      [
        row({ created_at: at("2026-01-02T00:00:00.000Z") }),
        row({ created_at: at("2026-03-09T12:30:00.000Z") }),
        row({ created_at: at("2026-02-01T00:00:00.000Z") }),
      ],
      { secret_set: true }
    )

    expect(summary.last_event_at?.toISOString()).toBe(
      "2026-03-09T12:30:00.000Z"
    )
    expect(summary.ever_received).toBe(true)
  })

  it("survives rows with no created_at", () => {
    // Defensive: a null timestamp must not become an Invalid Date on the page.
    const summary = summarizeWebhookHealth(
      [
        row({ created_at: null }),
        row({ created_at: at("2026-04-01T00:00:00.000Z") }),
      ],
      { secret_set: true }
    )

    expect(summary.last_event_at?.toISOString()).toBe(
      "2026-04-01T00:00:00.000Z"
    )
    expect(summary.total).toBe(2)
  })

  it("reports no last event when every row lacks a timestamp", () => {
    const summary = summarizeWebhookHealth([row({ created_at: null })], {
      secret_set: true,
    })

    expect(summary.last_event_at).toBeNull()
    // A row still arrived, even if we cannot say when.
    expect(summary.ever_received).toBe(true)
  })

  it("treats an unknown status as neither deferred nor failed", () => {
    // Forward compatibility: a status added later must not be silently
    // counted as a failure and alarm the owner.
    const summary = summarizeWebhookHealth([row({ status: "quarantined" })], {
      secret_set: true,
    })

    expect(summary.deferred).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.processed).toBe(0)
    expect(summary.total).toBe(1)
  })

  it("says the webhook is not registered when no secret is configured", () => {
    // Without webhookSecret there is no URL to register, so Printful cannot be
    // reaching us at all — regardless of what old rows exist.
    const summary = summarizeWebhookHealth([row()], { secret_set: false })

    expect(summary.secret_set).toBe(false)
    expect(summary.registered).toBe(false)
  })

  it("counts a configured secret with a delivered event as registered", () => {
    const summary = summarizeWebhookHealth([row()], { secret_set: true })

    expect(summary.registered).toBe(true)
  })

  it("does not claim registration from a secret alone", () => {
    // A secret set in config proves intent, not that the URL was ever pushed
    // to Printful. Until an event actually lands we cannot confirm delivery,
    // and the page must say so rather than show a false green.
    const summary = summarizeWebhookHealth([], { secret_set: true })

    expect(summary.secret_set).toBe(true)
    expect(summary.registered).toBe(false)
  })
})
