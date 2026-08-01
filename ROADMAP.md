# Roadmap

From catalog sync to a complete Printful backend.

Five releases, each closing one coherent Printful capability and leaving the
plugin in a working state. The testing strategy tightens as the API surface grows.

## Where we are

|                       |                                          |
| --------------------- | ---------------------------------------- |
| Published version     | `0.2.0`                                  |
| Tests                 | 113 (100 unit, 13 integration)           |
| Printful API coverage | 5 of 15 endpoint groups                  |
| Test layers           | unit + integration against real Postgres |

The plugin covers products, orders, order cancellation, webhook configuration,
and order status. Out of the fifteen groups Printful exposes that is still a
narrow band — live shipping rates, stock, taxes, and mockups remain unwired, and
each is a release below.

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

## 0.3.0 — Live shipping rates `next`

`canCalculate` currently returns `false`, so shipping is set by hand and
international orders either lose money or overcharge. Printful computes the exact
rate for the address and cart contents.

### API surface

| Endpoint               | Purpose                             |
| ---------------------- | ----------------------------------- |
| `POST /shipping/rates` | Rates for an address and item set   |
| `GET /countries`       | Validate countries and region codes |

### Scope

- Flip `canCalculate` to `true` and implement `calculatePrice` for real
- Rate cache (~10 min TTL) keyed by address + cart contents — `calculatePrice`
  runs on every cart refresh
- **Graceful fallback:** a Printful failure must not break checkout; fall back to
  a flat rate from plugin options
- Extend `resolveStateCode` to AU and the remaining countries from `/countries`

### Testing — adds contract tests

- **Critical:** Printful unavailable (timeout, 500, 429) → checkout still
  completes on the fallback rate. Medusa blocks the operation if `calculatePrice`
  throws or omits `calculated_amount`.
- Cache: two identical requests hit the API once; a changed address refetches
- Contract: recorded real `/shipping/rates` responses as fixtures, so a schema
  change breaks the suite
- Country matrix: US / CA / AU / DE / GB / JP — correct `state_code` and a rate returned

---

## 0.4.0 — Queued sync and catalog awareness

Sync runs inside the HTTP request and hits the admin timeout on a large catalog.
We also cannot see Printful stock: an item can sell out while the store keeps selling it.

### API surface

| Endpoint                     | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `GET /products/variant/{id}` | Blank availability and pricing             |
| `GET /products/{id}/sizes`   | Size guides for descriptions               |
| `stock_updated` webhook      | Real-time stock (v2 refreshes every 5 min) |

### Scope

- Background sync: a step with `async: true`; the route returns `202` and a job id immediately
- Progress tracked in `printful_sync_log` with status polling in the admin widget
- Step compensations (absent today) so a partial failure leaves no orphaned products
- Stock sync: out of stock in Printful → unpublish or set `allow_backorder: false`
- New `onRemovedFromPrintful` option: `unpublish` | `ignore` | `delete`

### Testing — adds load and concurrency

- **Volume:** 500 mocked products complete a sync without linear memory growth
- **Compensation:** failure on product 3 of 5 leaves no half-written rows
- **Concurrency:** two simultaneous syncs — the second is rejected or queued, never duplicating
- Resumption: restarting the process mid-sync does not corrupt state

---

## 0.5.0 — Returns, taxes, and cost

Order economics: what the store actually earned, who owes tax, what happens on a
return. `createReturnFulfillment` is a stub today.

### API surface

| Endpoint                      | Purpose                             |
| ----------------------------- | ----------------------------------- |
| `POST /tax/rates`             | Address-based tax (Tax Provider)    |
| `GET /tax/countries`          | Where Printful calculates tax       |
| `POST /orders/estimate-costs` | Cost of goods before order creation |
| `GET /reports/statistics`     | Sales summary for the admin         |

### Scope

- Real returns through `createReturnFulfillment` with a return label
- Optional Tax Provider (`ITaxProvider.getTaxLines`) backed by Printful rates
- Store cost of goods in order metadata so margin is visible in the admin
- Dedicated "Printful" admin page: statistics, sync history, webhook health

### Testing — adds monetary precision

- **Rounding:** tax and margin in minor units — no float drift across 1000 generated amounts
- Multi-currency: an EUR order against USD Printful pricing
- Returns: partial (1 of 3 items) and full, both idempotent
- Reconciliation: Medusa order total equals Printful order total plus markup

---

## 1.0.0 — Stable API and v2 migration

Freeze the plugin's public contract and migrate to Printful API v2, already in
open beta: signed webhooks, real-time stock, detailed tracking with estimated
delivery dates.

### Scope

- Client abstraction layer: v1 and v2 behind one interface, switchable by option
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
| `0.5.0` | Property-based on money    | Rounding, multi-currency                 |
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
