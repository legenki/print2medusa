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

export type PendingClaimState =
  /** A create may be running right now; leave the claim alone. */
  | "in_flight"
  /** No create can still own this claim; ask Printful what became of it. */
  | "settle"

/**
 * Decide whether an unresolved claim may be reconciled now.
 *
 * `last_attempt_at` is stamped only when an attempt ended without an answer,
 * so its presence alone proves no create still holds the claim. Without it,
 * age is the only evidence — and an unreadable timestamp is treated as old,
 * because a claim nothing can ever settle is worse than one settled late.
 */
export function classifyPendingClaim(
  link: {
    created_at?: Date | string | null
    last_attempt_at?: Date | string | null
  },
  now: number = Date.now()
): PendingClaimState {
  if (link.last_attempt_at) {
    return "settle"
  }
  const created = link.created_at ? new Date(link.created_at).getTime() : NaN
  if (!Number.isFinite(created)) {
    return "settle"
  }
  return now - created < CLAIM_IN_FLIGHT_MS ? "in_flight" : "settle"
}
