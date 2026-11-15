import { MedusaError } from "@medusajs/framework/utils"
import { PrintfulApiError } from "./errors"

/**
 * Printful's cap on `external_id`. Documented as up to 32 characters of
 * digits, Latin letters, dashes and underscores.
 *
 * A Medusa order id is `order_` plus a 26-character ULID — exactly 32, with
 * nothing to spare. That fits, but only just, so the length is asserted before
 * every create rather than assumed: a host app with a longer id prefix would
 * otherwise have Printful silently truncate or reject the key that order
 * creation depends on for idempotency.
 */
export const PRINTFUL_EXTERNAL_ID_MAX = 32

/** Characters Printful accepts in an external id. */
const EXTERNAL_ID_ALLOWED = /^[A-Za-z0-9_-]+$/

/**
 * Check that a Medusa order id can serve as Printful's `external_id`.
 *
 * Deliberately throws instead of truncating or hashing. `external_id` is the
 * only key that can tell a retry "this order already exists at Printful", and
 * a silently altered key is worse than a failed create: it reads as a missing
 * order and invites a duplicate.
 */
export function assertUsableExternalId(orderId: string): void {
  if (!orderId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Printful external_id: order id is empty"
    )
  }
  if (orderId.length > PRINTFUL_EXTERNAL_ID_MAX) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Printful external_id accepts at most ${PRINTFUL_EXTERNAL_ID_MAX} ` +
        `characters; order id "${orderId}" is ${orderId.length}. Refusing to ` +
        `truncate — a shortened key cannot identify the order on retry.`
    )
  }
  if (!EXTERNAL_ID_ALLOWED.test(orderId)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Printful external_id accepts letters, digits, "-" and "_" only; ` +
        `order id "${orderId}" does not qualify.`
    )
  }
}

/**
 * What a failed `POST /orders` tells us about whether the order exists.
 *
 * - `not_created` — Printful rejected the request outright. Safe to release
 *   the claim and let a retry create the order.
 * - `unknown` — a timeout, a dropped connection, a 5xx, a 429, or a 409. The
 *   order may or may not exist, so the caller must ask Printful before doing
 *   anything that could create a second one.
 */
export type CreateFailureOutcome = "not_created" | "unknown"

export function classifyCreateFailure(err: unknown): CreateFailureOutcome {
  if (err instanceof PrintfulApiError && err.provesNotCreated) {
    return "not_created"
  }
  // Anything else — including a plain network error with no status at all —
  // is unknown by construction. Guessing "not created" here is what prints a
  // second shirt.
  return "unknown"
}

/** True when a link row is a claim with no real Printful order behind it yet. */
export function isUnresolvedLink(
  link: { printful_order_id?: string | null } | null | undefined,
  pendingSentinel: string
): boolean {
  return !!link && (link.printful_order_id ?? "") === pendingSentinel
}

/**
 * How long a fresh claim is presumed to belong to a create still in progress.
 *
 * A claim is written immediately before `POST /orders`, so for the length of
 * that call it looks exactly like one abandoned by a crash. Settling it then —
 * looking the order up, getting 404 because the POST has not landed yet, and
 * deleting the claim — hands the order to a second create running alongside.
 * That is the normal case on a capture-on-place store, where `order.placed`
 * and `payment.captured` arrive together.
 *
 * Ten minutes is far beyond one create (never retried, 15s deadline) plus its
 * reconcile lookup. Anything older is a crash, and the order sweep settles it.
 */
export const CLAIM_IN_FLIGHT_MS = 10 * 60 * 1000

/** Wait after the first failed attempt before the sweep tries again. */
export const CLAIM_RETRY_BASE_MS = 10 * 60 * 1000

/** Longest wait between attempts, however many have failed. */
export const CLAIM_RETRY_MAX_MS = 2 * 60 * 60 * 1000

/**
 * How long to wait after the `attempts`-th failed attempt: doubling from
 * CLAIM_RETRY_BASE_MS, capped at CLAIM_RETRY_MAX_MS.
 *
 * A transient failure clears on the first retry or two. One that does not is
 * usually something a person must fix — an address Printful rejects, a
 * variant it no longer stocks — and the cap keeps such an order retrying, and
 * logging, a dozen times a day rather than on every 15-minute sweep. It is
 * never given up on: once the cause is fixed, the next retry sends it.
 */
export function claimRetryDelayMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1
  // Past 2^5 the cap has long applied; stopping there keeps the power finite.
  return Math.min(
    CLAIM_RETRY_MAX_MS,
    CLAIM_RETRY_BASE_MS * 2 ** Math.min(n - 1, 5)
  )
}

export type PendingClaimState =
  /** A create may be running right now; leave the claim alone. */
  | "in_flight"
  /** An attempt failed recently; wait out its backoff before the next. */
  | "backoff"
  /** No create can still own this claim; ask Printful what became of it. */
  | "settle"

/**
 * Decide whether an unresolved claim may be reconciled now.
 *
 * `last_attempt_at` is stamped only when an attempt ended — failed, or without
 * an answer — so its presence alone proves no create still holds the claim.
 * It is then due once the backoff for its `attempts` has passed. Without it,
 * age is the only evidence. An unreadable timestamp is treated as due,
 * because a claim nothing can ever settle is worse than one settled early.
 */
export function classifyPendingClaim(
  link: {
    created_at?: Date | string | null
    last_attempt_at?: Date | string | null
    attempts?: number | null
  },
  now: number = Date.now()
): PendingClaimState {
  if (link.last_attempt_at) {
    const last = new Date(link.last_attempt_at).getTime()
    if (!Number.isFinite(last)) {
      return "settle"
    }
    return now - last < claimRetryDelayMs(link.attempts ?? 0)
      ? "backoff"
      : "settle"
  }
  const created = link.created_at ? new Date(link.created_at).getTime() : NaN
  if (!Number.isFinite(created)) {
    return "settle"
  }
  return now - created < CLAIM_IN_FLIGHT_MS ? "in_flight" : "settle"
}
