# Roadmap

From catalog sync to a complete Printful backend.

Five releases, each closing one coherent Printful capability and leaving the
plugin in a working state. The testing strategy tightens as the API surface grows.

## Where we are

|                       |                                          |
| --------------------- | ---------------------------------------- |
| Published version     | `0.7.0`                                  |
| Tests                 | 341 (320 unit, 21 integration)           |
| Printful API coverage | 6 of 15 endpoint groups                  |
| Test layers           | unit + integration against real Postgres |

The plugin covers products, orders, order cancellation, webhook configuration,
order status, live shipping rates, stock-driven publication, and order costs.

Still unwired: **taxes** (Printful's `/tax/rates` has no documented contract),
**returns** (API v1 has no endpoint for them at all — only a `package_returned`
webhook reporting one that already happened), and **mockups**. Returns are
therefore held to `1.0.0` with API v2; the rest are releases below.

Since `0.7.0` the shipping method the customer selected is confirmed with
Printful and sent on the order — when Printful confirms it. See the 0.7.0
entry in `CHANGELOG.md` for what happens when it does not.

---

## 0.1.0 — Foundation `shipped`

Catalog sync, order creation on payment capture, a fulfillment provider, and an
admin widget. Duplicate protection and variant upsert.

**Testing — unit.** 23 tests: client (retries, pagination, confirm payload),
mappers (prices, markup, options, ISO state codes), order-claim uniqueness guard.

---

## 0.2.0 — Webhooks and order status `shipped`

The link was one-way: we pushed an order to Printful and never heard back, so a
customer was never told their parcel shipped. Now Printful's state flows back.

### API surface

| Endpoint           | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `POST /webhooks`   | Register the callback URL and event list |
| `GET /webhooks`    | Inspect the current configuration        |
| `DELETE /webhooks` | Disable webhook delivery                 |
| `GET /orders/{id}` | The authoritative state for every event  |

### What shipped

- Public route `POST /hooks/printful/:token`, authenticated by a path secret —
  Printful v1 accepts only a URL, with no header support, so the secret must
  travel in the path
- Handles `package_shipped`, `order_failed`, `order_canceled`, `package_returned`
- A Medusa fulfillment and shipment **per parcel**, carrying tracking; Printful
  splits orders across facilities, so each parcel covers only its own line items
- `printful_webhook_event` log keyed by a derived `event_id` under a unique index
- Scheduled retry every 5 minutes for events that arrive before their order link
- Admin order widget with status and per-parcel tracking; webhook config route

### Testing — unit + integration against real Postgres

- **Verification-first:** a payload claiming `shipped` while the API reports
  `pending` creates nothing. Printful v1 does not sign webhooks, so the payload
  is only a trigger and every decision comes from `GET /orders/{id}`
- **Idempotency:** the same `event_id` twice yields one row and one fulfillment
- **Filter operators:** `$in` / `$lte` / `$lt` in the retry query verified against
  real SQL, since typecheck cannot see them
- `medusaIntegrationTestRunner` proved unusable here — it boots a full app from a
  root `medusa-config.ts`, which a plugin repo does not have. The suite drives
  the service and route directly against a real database instead

---

## 0.3.0 — Live shipping rates `shipped`

Shipping was set by hand, so international orders either lost money or
overcharged. Printful now computes the rate for the address and cart contents.

### API surface

| Endpoint               | Purpose                           |
| ---------------------- | --------------------------------- |
| `POST /shipping/rates` | Rates for an address and item set |

### What shipped

- `calculatePrice` implemented behind a `liveShippingRates` option, structured so
  **no path can throw** — Medusa blocks checkout if it does, so a Printful outage
  degrades the price rather than the ability to buy
- Fallback chain: fresh cache → stale cache → flat rate. A day-old real quote
  outranks a typed-in constant
- One API call serves every shipping option on a cart — the whole response is
  cached under a key that excludes the method
- Australian state codes, which Printful requires and `resolveStateCode` lacked
- Option ids are Printful's own (`STANDARD`), replacing ids that matched nothing
  the API returns — a **breaking change** for existing shipping options

### Testing — adds contract tests

- Printful unavailable (timeout, 500, 429), method absent, currency unusable,
  config incomplete → checkout still completes on a fallback
- Cache: two options on one cart cost one API call; a corrupt entry is a miss,
  not a landmine; entries are written with the stale TTL so the stale tier exists
- Contract fixture, verified by mutation to actually fail on schema drift
- Country matrix: US / CA / AU / DE / GB / JP

### What it did not solve

The method the customer selected was priced correctly but **was not passed to
Printful**, which picked its own. Medusa carries no provider data from price
calculation onto the shipping method — the intended mechanism was implemented,
found to be dead code, and removed rather than left looking functional.

Closed in `0.7.0` through a different seam: `validateFulfillmentData`, which
receives the whole cart and whose return value Medusa does persist.

---

## 0.4.0 — Queued sync and catalog awareness `shipped`

Sync ran inside the HTTP request and hit the admin timeout on a large catalog,
and Printful stock was invisible: an item could sell out while the store kept
selling it.

### What shipped

- Background sync: the step is `async` + `backgroundExecution`, and the route
  claims the sync **before** answering `202`, so a double-click cannot start two
- One sync at a time, enforced by a partial unique index on `status = 'running'`
  rather than a check-then-insert; a second request gets `409`
- Heartbeat and progress in `printful_sync_log`, polled by the admin widget
- A product with no available variant is set to `draft` and republished on
  restock — the plugin marks what it unpublished so a merchant's own draft is
  left alone (**the marker was not actually wired until `0.5.1`**)
- `OrphanTracker` + step compensation: a product created but not linked is
  deleted on failure (**the swallowed-error path leaked until `0.5.1`**)
- Options: `syncStaleMinutes`, `onDiscontinued`

### Not built as originally scoped

- `allow_backorder: false` on sold-out variants. Variants are synced with
  `manage_inventory: false`, so Medusa never blocks the sale; publication state
  is the lever instead. A storefront that wants to hide a sold-out variant
  reads `printful_availability_status` from variant metadata.
- `onRemovedFromPrintful` with a `delete` mode. The plugin never deletes a
  merchant's products; `onDiscontinued` flags them instead.
- Resume after a crash. A reclaimed sync restarts from the beginning.

### Testing — adds load and concurrency

- **Concurrency:** simultaneous claims against real Postgres — exactly one wins
- **Compensation:** which products a failed sync may delete, mutation-proved
- Stale reaping: a claim whose heartbeat lapsed is reclaimed by the next attempt

---

## 0.5.0 — Order economics `shipped`

What each order cost and what it earned, on the order page.

**Scope changed during implementation.** Returns and taxes were planned here and
moved out for reasons found in Printful's API, recorded below.

### Shipped

- Printful `costs` and `retail_costs` stored on the Medusa order in minor units
- Margin on the order page, withheld when the two currencies differ
- Costs refreshed on every webhook, since Printful finalizes fees at fulfillment

### Moved out, and why

- **Returns → `1.0.0`.** Printful API v1 has **no returns endpoint** — verified
  against their OpenAPI spec (zero paths matching `return`) and their published
  docs. Only a `package_returned` webhook, reporting one that already happened.
  `createReturnFulfillment` stays a stub until API v2.
- **Tax Provider → deferred.** `/tax/rates` and `/tax/countries` exist, but
  their schemas are empty in the OpenAPI spec and the docs do not describe the
  fields — not even whether a rate or an amount is returned. Implementing
  `ITaxProvider` against an unknown contract risks charging customers the wrong
  tax, so it needs a live-API investigation first.
- **`/orders/estimate-costs` → not needed.** The created order already carries
  `costs`, so using the real figure avoids both a second call and any
  estimate-versus-actual drift.
- **Admin statistics page → its own release.** Independent subsystem.

### Testing — adds monetary precision

- **Rounding:** no float drift across 1000 generated amounts, mutation-proved
  (`Math.trunc` produces 69 mismatches)
- Multi-currency: an EUR order against USD Printful pricing

---

## 0.7.0 — Shipping method agreement `shipped`

The customer paid for a method Printful never saw. Closes the gap `0.3.0` opened
and could not close.

### What shipped

- The method is confirmed with Printful in `validateFulfillmentData` — the one
  hook that receives the whole cart and whose return value Medusa persists
- A `shipping` override on the Printful order, sent **only** when Printful
  confirmed that method for that cart
- `shipping_method.data` records the outcome either way, naming the reason when
  confirmation failed
- A 15-second deadline on every Printful request, since the confirmation call
  runs inside the customer's own request

### Testing

- Both polarities of the gate: live + id + allowlist sends the override; each
  condition missing individually sends none, mutation-proved
- Soft-fail reasons produce data without `printful_shipping`
- A fresh cache hit confirms without an API call; a stale entry never confirms

---

## 1.0.0 — Stable API and v2 migration `next`

Freeze the plugin's public contract and migrate to Printful API v2, already in
open beta: signed webhooks, real-time stock, detailed tracking with estimated
delivery dates.

### Scope

- Client abstraction layer: v1 and v2 behind one interface, switchable by option
- **Real returns** with a return label — impossible on v1, which has no returns endpoint
- Multi-store support — `storeId` already exists in the link models; finish it
- Mockup Generator: generate previews during sync (`/mockups`)
- Public contract: exported types, documented option semantics, deprecation policy
- Automated npm publishing on git tag via a granular access token

### Testing — adds E2E and compatibility

- **E2E:** full path against a Printful sandbox store — sync → cart → payment →
  order → shipment → return
- **v1/v2 parity:** one scenario across both clients yields identical results
- Compatibility: upgrading 0.5.x → 1.0.0 on a real database, migrations preserve links
- Medusa version matrix 2.18 → 2.2x in CI

---

## How testing tightens

| Version | Layer added                | What it catches                          |
| ------- | -------------------------- | ---------------------------------------- |
| `0.1.0` | Unit                       | Mapper logic, client retries, races      |
| `0.2.0` | Route integration          | HTTP contract, webhook idempotency       |
| `0.3.0` | Contract + resilience      | Printful schema drift, checkout breakage |
| `0.4.0` | Load + concurrency         | Timeouts, compensation, concurrent sync  |
| `0.5.0` | Property-based on money    | Rounding drift, multi-currency margin    |
| `1.0.0` | E2E + compatibility matrix | Upgrade regressions, v1/v2 parity        |

## Why this order

Releases are ordered by **what breaks for the customer soonest**, not by
implementation difficulty. Silence after payment (`0.2.0`) is more visible than
imprecise shipping (`0.3.0`), which in turn is more visible than an admin sync
timeout (`0.4.0`) that only the store owner sees. Economics (`0.5.0`) comes once
the order flow is dependable — measuring margin on an unreliable flow is pointless.

Every release stands alone: the plugin remains usable if work stops at any version.
The Printful API v2 migration is deliberately held back to `1.0.0` — it is in beta
and still subject to change, so building on it earlier means writing it twice.

## References

- [Printful API v1](https://developers.printful.com/docs/)
- [Printful API v2 (beta)](https://developers.printful.com/docs/v2-beta/)
- [Medusa Fulfillment Provider](https://docs.medusajs.com/resources/references/fulfillment/provider)
- [Medusa Tax Provider](https://docs.medusajs.com/resources/commerce-modules/tax/tax-provider)
