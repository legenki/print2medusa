# 0.2.0 — Webhooks and order status

**Status:** approved design
**Issue:** [#2](https://github.com/legenki/print2medusa/issues/2)

## Problem

The link to Printful is one-way: we push an order and never hear back. The
customer is never told the parcel shipped, and a failed order is invisible until
someone opens the Printful dashboard.

## Design decisions

Four decisions were settled before this spec, and everything below follows from them:

1. **Trust model:** path secret as a first barrier **plus** verification against
   `GET /orders/{id}`. Printful v1 does not sign webhooks, so the payload is
   treated as a hint, never as truth.
2. **Shipment handling:** create a Medusa fulfillment and shipment, and record
   Printful state in order metadata. Customer notification stays the store's
   responsibility — Medusa already emits `shipment.created`.
3. **Negative events:** record and surface only. Never auto-cancel or auto-refund.
   `order_put_hold` is frequently temporary, and money movement needs a human.
4. **Registration:** an admin button that reads the current config first and warns
   before overwriting. No automatic registration on boot.

## Core principle

**The webhook payload is a trigger, not a source of truth.**

Every handler reads `printful_order_id` from the payload, then calls
`GET /orders/{id}` and acts on that response. A forged webhook can cause an
extra API read and nothing else. This also removes event-ordering problems: we
always apply the current state, so a late `package_shipped` cannot regress a
newer status.

## Route and transport

**Path:** `POST /hooks/printful/:token` → `src/api/hooks/printful/[token]/route.ts`

The secret sits in the path, not the query string. Query strings leak into access
logs, proxy dashboards, and error trackers far more readily than path segments.
The token is the existing `webhookSecret` plugin option; when it is unset the
route returns `404` (feature disabled) rather than accepting unauthenticated calls.

Token comparison is constant-time (`crypto.timingSafeEqual`) over SHA-256 digests
of both values, so differing lengths cannot throw and timing cannot leak the secret.

**Logging rule:** never log the full URL, path, or token. Log the derived
`event_id` and `printful_order_id` only.

The route's own discipline is not enough. Medusa's error handler logs
`` `Error ${err.statusCode} at ${req.path}` `` for anything that reaches it, and
our path carries the secret — so a body-parser 413 or 400 on a genuine Printful
delivery would write the live token to the log in cleartext. A middleware on
`/hooks/printful/*` redacts the token segment from `req.path` before any
downstream handler or the error middleware can read it.

A header would avoid this entirely, but Printful v1 cannot send one: the webhook
configuration accepts only `url`, `types`, and `params`, and `params` is
per-event filtering (e.g. `product_ids` for `stock_updated`), not headers. The
path is the only channel available, so the secret is mitigated rather than
relocated. Operators should also expect it in reverse-proxy and CDN access logs,
and rotate it accordingly — the README says so.

### Response contract

| Condition                 | Status | Body                                   |
| ------------------------- | ------ | -------------------------------------- |
| Valid token, event stored | `200`  | `{ received: true, event_id }`         |
| Invalid or missing token  | `404`  | empty — do not confirm the path exists |
| Unknown event type        | `200`  | stored with `status: "ignored"`        |
| Storage failure           | `500`  | only case where Printful should retry  |

The route never returns `5xx` for business-logic problems. A `5xx` triggers
Printful retries and turns one bad event into a storm.

## Request lifecycle

Processing is split so that nothing meaningful happens inside the HTTP request:

```
POST /hooks/printful/:token
  1. constant-time token check                     → 404 on mismatch
  2. derive event_id, INSERT printful_webhook_event → 200 returned here
  3. enqueue: apply-printful-order-status workflow
  ────────────────────────────────────────────────── HTTP request ends
  4. workflow: GET /orders/{id}, resolve link, apply state
```

Step 2 completes the HTTP obligation. Step 3 hands work to a workflow that lives
beyond the request; a killed worker loses nothing, because the durable record from
step 2 is what the retry job reads.

**No fire-and-forget.** Work is never left dangling on a promise the request
lifecycle can cancel. A scheduled retry job (below) is the safety net, not an
optimization.

## Idempotency: deriving `event_id`

Printful v1 does not supply a stable event identifier, so we derive one. Without
an explicit rule the unique index is decorative — this is a contract, not an
abstraction.

```
event_id = sha256(
  type + "|" +
  printful_order_id + "|" +
  discriminator + "|" +
  (payload.created ?? payload_fingerprint)
)
```

Where `discriminator` is per event type:

| Event type                        | Discriminator             | Rationale                                    |
| --------------------------------- | ------------------------- | -------------------------------------------- |
| `package_shipped`                 | `shipment.id`             | Multiple parcels per order must not collapse |
| `package_returned`                | `shipment.id`             | Same                                         |
| `order_updated`                   | `order.updated` timestamp | Distinct edits are distinct events           |
| `order_failed` / `order_canceled` | `""` (empty)              | Terminal and non-repeating per order         |
| unknown types                     | `payload_fingerprint`     | Safe default                                 |

`payload_fingerprint` is `sha256` of the canonicalized **content** (keys sorted),
used whenever the preferred field is absent. The raw payload is stored regardless,
so a wrong derivation can be diagnosed and reprocessed later.

**The fingerprint must cover `{ type, data }` only — never the raw payload.**
Printful's delivery envelope carries `retries`, which increments on each
redelivery of the same event. Hashing it would give a redelivered event a new
`event_id`, bypass the unique index, and create a duplicate fulfillment — the
exact failure this mechanism exists to prevent. `store` is excluded for the same
reason.

## Data model

### New: `printful_webhook_event`

| Field                  | Type              | Notes                                                           |
| ---------------------- | ----------------- | --------------------------------------------------------------- |
| `id`                   | id                | primary key                                                     |
| `event_id`             | text              | **unique index** — idempotency key                              |
| `type`                 | text              | raw Printful event type                                         |
| `printful_order_id`    | text              | indexed                                                         |
| `printful_shipment_id` | text nullable     | indexed — fast shipment dedupe                                  |
| `payload`              | json              | raw event, retained for triage                                  |
| `status`               | text              | `received` → `deferred` \| `processed` \| `ignored` \| `failed` |
| `attempts`             | number            | default `0`                                                     |
| `next_retry_at`        | dateTime nullable | indexed                                                         |
| `processed_at`         | dateTime nullable |                                                                 |
| `error_message`        | text nullable     |                                                                 |

### Changed: `printful_order_link`

Add a unique index on `printful_order_id`. Today only `medusa_order_id` is
indexed, but webhooks arrive with the Printful id — the reverse lookup is the hot
path and must not be a full scan. The pairing is one-to-one in both directions.

## Status lifecycle and retries

`deferred` is the state that makes the race survivable. Order links are created on
`payment.captured`; a webhook can legitimately arrive before that has committed.

| Status      | Meaning                      | Next action                |
| ----------- | ---------------------------- | -------------------------- |
| `received`  | Stored, not yet processed    | Enqueued immediately       |
| `deferred`  | No `printful_order_link` yet | Retried on schedule        |
| `processed` | Applied successfully         | Terminal                   |
| `ignored`   | Type not handled             | Terminal                   |
| `failed`    | Attempts exhausted           | Terminal, visible in admin |

**Retry job** — runs every 5 minutes over rows where
`status IN ('received','deferred')` and `next_retry_at <= now()` and
`attempts < 20`. Rows reaching the cap are set to `failed` and are never picked
up again automatically; they are retried only by an explicit admin "Resync"
action:

- Backoff: `min(5min × 2^attempts, 6h)`
- Cap at 20 attempts (~2 days of coverage), then `failed` permanently
- Each attempt increments `attempts` and sets `next_retry_at` before work begins,
  so a crash mid-attempt cannot produce an infinite fast loop

Without this, a deferred event either retries forever or silently succeeds at
doing nothing.

## Concurrency

Two events for the same order can be processed in parallel — by the route and the
retry job simultaneously, or by two workers. The shipment-id check alone does not
prevent a double fulfillment, because both readers can pass the check before
either writes.

**Rule: serialize application per `printful_order_id`.** The apply step takes a
Postgres advisory lock keyed on a hash of `printful_order_id`, held for the
duration of the step. Events for different orders stay parallel; events for the
same order queue behind each other.

**It must be `pg_advisory_xact_lock` inside a transaction — never the
session-scoped `pg_advisory_lock`.** Medusa's `getActiveManager()` forks without
a transaction context, so knex checks out a fresh pool connection per statement.
A session lock and its unlock can therefore land on different connections: the
unlock silently returns `false` and the lock leaks for the life of the pooled
connection, blocking every later event for that order. Verified against Postgres
16 during implementation — four of five concurrent unlocks leaked. The
transaction-scoped variant pins all statements to one connection and is released
by Postgres on commit or rollback, so no unlock call exists to go wrong.

The 32-bit key space means unrelated orders occasionally collide (~2 per 200k
ids). A collision only serializes two unrelated orders, which is slower but never
incorrect.

## Applying state

The apply workflow reads `GET /orders/{id}` and decides from `status` and
`shipments[]`. **The webhook type is used only for triage and logging** — never
for the decision. Mixing event type and order status is what makes these
integrations drift.

```
GET /orders/{id} → { status, shipments[] }

status ∈ {fulfilled, partial}  and shipments[] non-empty
  → for each shipment not yet recorded:
      ensure a Medusa fulfillment exists for its items
      then register the shipment with tracking

status ∈ {failed, canceled, onhold, draft, pending, inprocess, ...}
  → write to order metadata, surface in admin, take no order action
```

### Fulfillment then shipment

`createOrderShipmentWorkflow` requires a `fulfillment_id`, so a fulfillment must
exist first:

1. Look for an existing Medusa fulfillment whose `data.printful_shipment_id`
   matches. Found → shipment already recorded, skip.
2. Otherwise call `createOrderFulfillmentWorkflow` with **only the items in this
   shipment**, tagging `data.printful_shipment_id` and `data.printful_order_id`.
3. Then call `createOrderShipmentWorkflow` with that `fulfillment_id`, the
   tracking number, carrier, and URL as labels.

**Partial shipments are the normal case.** Printful splits orders across
facilities routinely, so each `package_shipped` maps to its own
fulfillment + shipment covering that parcel's items — never one fulfillment that
closes the whole order.

Passing the order-wide item list to every fulfillment is not an option: Medusa
rejects it. `fulfill-item.js` throws `Cannot fulfill more items than what was
ordered` once `fulfilled_quantity` reaches `quantity`, so parcel 1 would consume
the whole order and parcel 2 would fail on every attempt — burning all 20 retries
while parcel 1's fulfillment stays committed.

Per-parcel items come from Printful: `Shipment.items` is an array of
`OrderShipmentItem { item_id, quantity, picked, printed }` (confirmed in the v1
OpenAPI spec). `item_id` is the Printful line item id, which maps back to Medusa
through the `external_id` we set on every Printful order item when the order was
created. Quantities are clamped against what Medusa still has unfulfilled —
Printful reports reshipments (`reshipment: true`) and can exceed the open
quantity after a partial cancel.

### When the apply step throws

Every failure path must leave a record. An unhandled throw is worse than a
failure, because the event ends up in a state no process owns:

- `error_message` stays empty, so there is nothing to diagnose from
- `status` remains `received`/`deferred`, which reads as "not yet processed"
- once `attempts` reaches the cap, the row stops matching the retry query —
  invisible to the job, yet indistinguishable from a fresh event

So the apply step wraps its work and, on any exception, writes `error_message`
and sets `status` to `deferred` (or `failed` at the cap) before rethrowing. That
write happens **outside** the order lock: a write inside the lock transaction
would roll back with it, destroying the only evidence of what went wrong.

### Metadata written to the order

Recorded under `order.metadata` for admin and storefront visibility:
`printful_order_id`, `printful_status`, `printful_status_updated_at`, and
`printful_shipments` (array of `{ id, carrier, service, tracking_number, tracking_url, ship_date }`).

## Webhook configuration

Printful v1 exposes **one configuration per store** — a URL plus a list of event
types. `POST` replaces the whole thing. Client methods are named for that reality:

| Method                         | Endpoint           | Purpose                        |
| ------------------------------ | ------------------ | ------------------------------ |
| `getWebhookConfig()`           | `GET /webhooks`    | Read current URL and types     |
| `setWebhookConfig(url, types)` | `POST /webhooks`   | **Replaces the entire config** |
| `disableWebhook()`             | `DELETE /webhooks` | Remove support                 |

The admin UI must state plainly that saving replaces the existing URL and event
list, and must display the current configuration before offering to overwrite it.
The full allowlist is always sent — never a partial list that would silently drop
another integration's events.

**Subscribed event allowlist (MVP):**

- `package_shipped` — the point of the release
- `order_failed`, `order_canceled` — surface problems
- `package_returned` — metadata only in this version
- `order_updated` — optional, off by default; it is noisy

## Admin surface

**Order page widget:** Printful order id and status, per-shipment tracking links,
last synced time, and a "Resync from Printful" button that re-runs the apply
workflow. Failed events for this order appear with their error.

**Settings section:** current webhook config (URL and types), a copyable target
URL for this deployment, a "Register webhook" button with the overwrite warning,
and a recent-events table with statuses.

## Testing

Test-driven throughout: each behavior gets a failing test first.

**Unit**

- Token comparison: valid, invalid, empty, differing length, unset secret
- `event_id` derivation: stable across identical payloads; distinct for two
  shipments of one order; distinct for two `order_updated` timestamps; falls back
  to fingerprint when fields are missing
- Payload parsing per handled type
- Status mapping from `GET /orders/{id}` to actions

**Idempotency**

- Same `event_id` twice → one row, one fulfillment
- Two different events describing one shipment → one fulfillment
- Replayed delivery after `processed` → no side effects

**Verification-first** (the security core)

- A payload claiming `fulfilled` while the API reports `pending` results in **no
  fulfillment** — proves the payload is not trusted

**Race and retry**

- Webhook arrives before `printful_order_link` exists → `deferred`, not `failed`
- The retry job later finds the link and completes → `processed`
- Backoff and the 20-attempt cap behave as specified
- Concurrent apply for one order → advisory lock serializes; exactly one
  fulfillment per shipment

**Route integration** (`medusaIntegrationTestRunner`)

- Real `POST` with a valid token → `200`, row written
- Invalid token → `404`, nothing written
- Unknown event type → `200`, `status: "ignored"`
- Storage failure → `500` so Printful retries

## Out of scope

Auto-cancel and auto-refund on failure (deferred until real-world event behavior
is observed), customer notifications (the store's job), stock webhooks (`0.4.0`),
and returns processing (`0.5.0`). `package_returned` is recorded but not acted on.
