/**
 * The subset of a `printful_webhook_event` row the health summary reads.
 *
 * Deliberately narrow: the summary must be testable against plain objects,
 * without a database or the module service's generated row type.
 */
export type WebhookHealthRow = {
  status: string
  created_at?: Date | string | null
  processed_at?: Date | string | null
}

export type WebhookHealthSummary = {
  /** Rows inspected. */
  total: number
  /** Stored, not yet attempted. */
  received: number
  /** Arrived before its order link existed; still retrying. */
  deferred: number
  /** Out of attempts. Will never be retried without intervention. */
  failed: number
  /** Applied successfully. */
  processed: number
  /** Newest arrival, or null when nothing has ever landed. */
  last_event_at: Date | null
  /** Whether any event has ever arrived — the "none yet" signal for the page. */
  ever_received: boolean
  /** Whether a webhookSecret is configured at all. */
  secret_set: boolean
  /**
   * Whether we can say Printful is actually reaching this store. Requires both
   * a configured secret and at least one delivered event — see below.
   */
  registered: boolean
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Summarise the webhook event table for the admin page.
 *
 * This is intentionally derived from LOCAL rows only. The obvious alternative
 * is to call `client.getWebhookConfig()` and report Printful's registered URL
 * verbatim, and this route deliberately does not: a health panel whose job is
 * to tell the owner whether Printful is reaching them must not itself go dark
 * when Printful is down. `/admin/printful/webhook` already exposes the live
 * config for the moment an admin actually wants to inspect or change it.
 *
 * The cost of that choice is that `registered` is evidence-based rather than
 * authoritative. A configured secret proves the owner intended to register a
 * webhook; it does not prove the URL was ever pushed to Printful. So
 * `registered` requires a secret AND a delivered event — the one thing that
 * genuinely proves the round trip works. A store that has a secret but no
 * events reads as "configured, nothing received yet", which is the honest
 * statement and is exactly the state a misconfigured webhook leaves behind.
 */
export function summarizeWebhookHealth(
  rows: ReadonlyArray<WebhookHealthRow>,
  config: { secret_set: boolean }
): WebhookHealthSummary {
  let received = 0
  let deferred = 0
  let failed = 0
  let processed = 0
  let lastEventAt: Date | null = null

  for (const row of rows) {
    switch (row.status) {
      case "received":
        received += 1
        break
      case "deferred":
        deferred += 1
        break
      case "failed":
        failed += 1
        break
      case "processed":
        processed += 1
        break
      // A status added by a later release counts toward `total` only. Guessing
      // it is a failure would show the owner an alarm that is not real.
      default:
        break
    }

    const createdAt = toDate(row.created_at)
    if (createdAt && (!lastEventAt || createdAt > lastEventAt)) {
      lastEventAt = createdAt
    }
  }

  return {
    total: rows.length,
    received,
    deferred,
    failed,
    processed,
    last_event_at: lastEventAt,
    // Based on row count, not on the timestamp: a row with an unreadable
    // created_at still proves something arrived.
    ever_received: rows.length > 0,
    secret_set: config.secret_set,
    registered: config.secret_set && rows.length > 0,
  }
}
