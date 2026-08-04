# Changelog

## Unreleased

### Added

- **`GET /admin/printful/history`** — recent sync runs, newest first (20 per
  page, `limit`/`offset`), with counters, progress and error message.
- **`GET /admin/printful/health`** — webhook delivery health: when the last
  event arrived, how many are `deferred` versus permanently `failed`, and
  whether a webhook is confirmed reaching the store. Answered entirely from
  local rows and plugin options — it makes **no** call to Printful, so the one
  page you check during a Printful outage still renders during one.
- **`POST /admin/printful/sync/clear`** — clear a sync stuck in `running`,
  closing the limit recorded in 0.4.0. Previously a crashed sync blocked the
  catalogue for up to `syncStaleMinutes` (default 60) with no way to intervene.

  Two guards, because the operation is destructive: the request must carry
  `{ "confirm": "clear-stuck-sync" }`, and the server independently verifies
  the heartbeat really is stale — a sync that is still checking in returns
  `409` and is left alone. The write is conditional on the heartbeat the
  request observed, so a sync that revives between the check and the write is
  not marked failed underneath a live process.

  A row cleared this way records `cleared_by_operator` plus how long the sync
  had been silent, so it is never confused with the `stale_running` marker the
  timeout reaper writes.

## 0.8.1

Publishing moves to CI.

### Changed

- **Releases publish from a version tag**, not from a maintainer's machine.
  Pushing `vX.Y.Z` runs the full suite — format, both typechecks, unit and
  integration against a real Postgres, build — and only then publishes. The
  tarball therefore comes from a checkout that passed, rather than whatever
  happened to be on the publisher's disk.
- The workflow **refuses to publish** when the tag and `package.json` disagree,
  or when that version already exists on npm. Both were previously ways to put
  a wrong or duplicate version on the registry with no signal until afterwards.
- Published with **`--provenance`**, so npm records the repository, commit and
  workflow that built the package.

Requires an `NPM_TOKEN` repository secret. See the release section in the
README.

## 0.8.0

Catalog hygiene, easier installs, and storefront guidance for sold-out variants.

### Added

- **`onRemovedFromPrintful`** (`"unpublish"` \| `"ignore"`, default `"unpublish"`).
  After a **full** sync, products that still have a link row but no longer
  appear in the Printful store catalogue are set to `draft` and marked with
  `printful_removed` + `printful_stock_status: "unavailable"`. A later re-add
  and sync can republish them. Partial syncs (`limit`) never run this pass —
  that would treat the unfetched rest of the catalogue as deleted.
- **[Storefront availability guide](https://github.com/legenki/print2medusa/blob/main/docs/storefront-availability.md)** —
  how to read `printful_availability_status` so a sold-out size is not still
  orderable when `manage_inventory` is false.

### Changed

- **Peer dependencies are `^2.18.0`** (and `^4.2.0` for `@medusajs/ui`) so a
  host on 2.19+ can install without an exact-pin fight. DevDependencies stay
  pinned for reproducible CI builds of this package.

### Fixed

- Removal markers are cleared when a product is seen on Printful again during
  a normal update sync.

## 0.7.0

Printful now ships the method the customer paid for.

### Fixed

- **The selected shipping method reaches Printful.** Orders were created with no
  `shipping` override, so Printful chose its own method regardless of what the
  customer selected and paid for — the delivery speed sold and the cost incurred
  could both differ from what was quoted.

  0.3.0 attempted this and shipped dead code: it stamped fields onto the object
  returned by `calculatePrice`, which Medusa discards — it reads only
  `calculated_amount` and `is_calculated_price_tax_inclusive` from a calculated
  price. That attempt needed a type cast to compile and was removed rather than
  left looking functional.

  The method is now confirmed in `validateFulfillmentData`, which receives the
  whole cart and whose return value Medusa persists verbatim onto the shipping
  method and then onto the order.

- **Every Printful request has a deadline.** Node's `fetch` bounds headers and
  body at 300 seconds each and imposes no overall deadline, so a Printful that
  hung rather than failed could stall a request indefinitely — four times over,
  once per retry. Tolerable on a background sync; not on the confirmation call,
  which runs inside the customer's own request. Now 15 seconds per attempt.

### The rule that governs it

**A `shipping` override is sent only when Printful itself confirmed that method
for this cart.** A fallback price was never confirmed by Printful, so insisting
on that method risks an order Printful rejects — worse than letting Printful
choose. Confirmation failure is always soft: checkout proceeds exactly as before,
and the order is created with no override.

`shipping_method.data` records the outcome: `printful_shipping` and
`rate_source: "live"` on success, or `rate_source` naming the reason
(`printful_unreachable`, `method_unavailable`, `currency_mismatch`,
`no_printful_items`, `query_unavailable`) on failure. The order path is a pure
read of that record — no Printful call when the order is created.

A **stale cache entry never confirms**, and a failed re-fetch does not fall back
to one. A stale price is defensible; a stale method confirmation is not, because
the method may no longer be offered.

### Known limits

- **The price shown and the method confirmed can disagree.** The cart may have
  priced from a flat or stale-cache fallback while confirmation moments later
  succeeded live. The customer is then charged an amount that is not the live
  quote, for a method that is. Both halves are individually honest, and it needs
  a failure at pricing time followed by a success seconds later. Re-pricing on
  selection is a separate decision.
- **Selecting a method costs one Printful call on a cache miss.** Bounded — once
  per selection, not per cart refresh — and the common case is a fresh-cache hit,
  because pricing populated that exact key moments earlier.
- **Confirmation needs `dependencies: ["query"]`**, the same requirement live
  rates already have. Without it, confirmation soft-fails to no override.
- **A cart mixing shipping profiles is not narrowed.** Medusa hands the pricing
  path only the items under the option's profile but hands the confirmation path
  the whole cart, and the option's profile id is not among the arguments the
  provider receives. Both paths use the same unfiltered lines, so they agree with
  each other; the quote for a mixed cart simply includes non-Printful items.

## 0.6.0

Money is scaled by the currency instead of always by 100.

### Fixed

Most currencies have 100 minor units to the major unit — $12.34 stores as
`1234`. Zero-decimal currencies have none: ¥1500 is fifteen hundred yen, and
Medusa stores `1500`. The plugin multiplied by 100 regardless, so a store
selling in JPY, KRW, HUF, ISK, CLP or any of the other 38 zero-decimal
currencies got values a hundredfold wrong.

Five places crossed between major and minor units. All now consult the
currency, using Medusa's own `defaultCurrencies` table rather than a
hand-written list:

- **Order costs** stored on the Medusa order
- **Catalog prices** written during sync — this one had no compensating error
  anywhere, so a JPY store's product prices were simply wrong
- **The order page**, which divided by 100 unconditionally. This cancelled the
  cost error, which is why the order page looked correct while the stored data
  was not
- **Shipping rates** returned to Medusa from a Printful quote
- **Cart line values sent to Printful** when requesting a quote, which
  under-reported a JPY cart's value by 100× and affects both the rate Printful
  calculates and the customs value it declares

### Added

- **`printful_money_scale` on order metadata.** Orders stamped before 0.6.0
  carry no marker, and nothing in the data distinguishes a JPY order holding
  `150000` from a correct `150000` in a currency that has minor units. The
  order page reads the marker and keeps the old rule for unmarked orders, so
  they still display correctly.

### Upgrading

**Nothing migrates automatically, by design.** A store that has only ever sold
in USD, EUR or any other two-decimal currency has nothing wrong and needs to do
nothing.

If you have sold in a zero-decimal currency:

- **Order costs** correct themselves the next time a webhook re-reads the
  order, which restamps both the amounts and the marker.
- **Catalog prices** correct themselves on the next sync.
- Values written before this release stay as they are until then. A blind
  division by 100 was deliberately not shipped: it would corrupt anything a
  merchant had already corrected by hand, and there is no way to tell the two
  apart.

## 0.5.3

Order visibility and honest sync reporting, from a second external review.

### Fixed

- **The Printful panel appears as soon as the order is created.** The create
  path wrote only cost keys, but the order widget gates on
  `printful_order_id` — so the order existed in Printful, its costs were
  stored, and the merchant saw nothing until the first webhook arrived.
- **A sync with failures no longer reports success.** The old rule demanded
  zero creates _and_ zero updates before calling a run failed, so 100 failures
  beside one successful update showed a green sync. Such a run is now
  `partial`.
- **A fee Printful stops reporting is cleared.** Fee keys were merged per-key,
  so a shipping fee that dropped out of a later response kept its old value
  beside a fresh total. A refresh now clears the fee keys it did not write.
- **The create path takes the same advisory lock as webhooks.** Both do a
  read-modify-write of order metadata, and a webhook arriving between the link
  becoming resolvable and this write could have its newer `printful_status`
  clobbered back to the status captured at creation.

### Known limits

- **Zero-decimal currencies are wrong in more places than 0.5.0 recorded.**
  `parsePriceToMinorUnits` — which prices the **catalog** — carries the same
  unconditional ×100 as the cost converter, so a JPY Printful store gets
  product prices a hundredfold too large as well. **Fixed in 0.6.0.**

## 0.5.2

Closes the known limit 0.5.1 left open.

### Fixed

- **A variant whose link row failed to write is repaired on the next sync.**
  The update path only refreshed link rows it already found, and
  `diffVariantsForUpsert` matches on variant metadata rather than link rows —
  so a variant that lost its row looked already-synced and was never written
  again. It stayed permanently unlinked, and order creation resolves
  `sync_variant_id` through those rows, so a customer ordering it could fail to
  map. The sync now creates any missing link whose Medusa variant carries the
  matching `printful_sync_variant_id`.
- **Variant linking is resumable instead of best-effort.** A failure part-way
  through used to abandon every remaining variant for that product, and because
  the product's own link row already existed, the next sync took the update
  path and never went back for them. One unwritable row now costs only that
  row.

## 0.5.1

Two correctness fixes found by an external review of the released code, both
in the catalog sync.

### Fixed

- **A product you drafted by hand is no longer re-published by the next sync.**
  `resolvePublication` was written and unit-tested in 0.4.0 but **never
  called** — the sync force-set status from Printful stock alone. The plugin
  now marks the products it unpublishes for being sold out, and re-publishes
  only those, leaving a merchant's own draft alone. A product created while
  sold out is marked too, so it is republished when it comes back.
- **A product created but never linked is no longer stranded.** If the link
  write failed, the per-product error handler swallowed it and the sync step
  still succeeded — and compensation only runs when a step _fails_, so the
  orphan was never deleted. The next sync could not see it either, so it
  created a duplicate. The failing product is now cleaned up where the error is
  caught.
- **A return shipping option can now be used.** `validateOption` accepted
  `PRINTFUL_RETURN` and `canCalculate` excluded it from live rates on purpose,
  but `validateFulfillmentData` rejected it — so the option could be created
  and priced, never added to a cart.

### Docs

- The ROADMAP intro said live rates, stock and taxes "remain unwired" at
  version 0.5.0. Rewritten to say what is actually shipped, what is not, and
  why returns are held to 1.0.0.
- The README install snippet omitted `liveShippingRates`,
  `fallbackShippingRates` and `dependencies: ["query"]`. Without the last one
  every quote silently falls back to the flat rate.

## 0.5.0

What each order cost and what it earned, visible on the order page.

### Added

- **Printful costs on the Medusa order.** The cost breakdown and retail totals
  are stored in order metadata in minor units, taken from the order response
  Printful already returns — no extra API call.
- **Margin on the order page**, when the Printful currency matches the order's.
- **Costs refresh from webhooks**, so the figures reflect the shipping and fees
  Printful finalizes at fulfillment rather than the provisional ones.

### Known limits

- **No currency conversion.** When Printful bills in a different currency than
  the order, both totals are stored but the margin is withheld.
- **Zero-decimal currencies are stored 100× too large.** A ¥1500 order stores
  `printful_cost_total: 150000`, because JPY, KRW and the other ISO 4217
  exponent-0 currencies have no minor unit. The order page displays the correct
  figure — it divides by 100, cancelling the error — but any other reader of
  that metadata gets a hundredfold overstatement. **Fixed in 0.6.0**, which
  scales by the currency and stamps `printful_money_scale` so values written
  before it can still be read correctly.
- **The per-fee breakdown can drift from the total.** Fee keys are merged
  per-key, so a fee absent from a later Printful response keeps its previous
  value beside a fresh total. The order page shows only the two totals and the
  margin, which are always written together, and never the breakdown.
  **Fixed in 0.5.3.**
- **An unparseable fee is indistinguishable from a fee of zero** — both simply
  omit the key. An unparseable _total_ is handled properly: it suppresses the
  margin rather than fabricating one.
- **Returns are not implemented.** Printful API v1 has no endpoint for creating
  a return or generating a return label — only a `package_returned` webhook
  reporting one that already happened. `createReturnFulfillment` therefore
  remains a stub. Real returns need API v2 and are deferred to 1.0.0.
- **No tax provider.** `/tax/rates` exists in Printful API v1, but its request
  and response contract is undocumented, so `ITaxProvider` is deferred until
  the contract can be established against the live API.

## 0.4.0

The catalog sync runs in the background, one at a time, and Printful stock
decides whether a product is published.

### Added

- **Background sync.** `POST /admin/printful/sync` responds `202 {sync_id}`
  immediately instead of holding the request open for the whole catalog. The
  admin widget polls progress and disables **Sync Now** while a sync runs.
- **One sync at a time.** A second request gets `409` with the running sync's
  `started_at`; the scheduled job skips quietly. Enforced by a partial unique
  index on `status = 'running'` rather than a check-then-insert, so a
  double-click cannot start two syncs.
- **Stale claim recovery.** A sync whose process died is reclaimed after
  `syncStaleMinutes` (default 60) by the next sync attempt.
- **Stock-driven publication.** A product with no available variant is set to
  `draft` and republished on restock. Only products the plugin unpublished are
  republished — a draft you set by hand stays draft.
- **Discontinued marker.** `printful_discontinued` in product metadata, and
  `printful_availability_status` per variant. `onDiscontinued: "ignore"` turns
  the marker off (it does not turn off hiding).
- **Rollback of half-created products.** Products created but not yet linked are
  deleted if the sync fails, so a crash leaves nothing stranded.
- Options: `syncStaleMinutes`, `onDiscontinued`.

### Known limits

- **Recovery is lazy, not scheduled.** After a crash the sync log stays
  `running` and the widget shows a sync that is not alive. Nothing reclaims it
  until the next sync attempt, so with the default 60 minutes a crash shortly
  after the nightly job means the catalog is blocked until someone tries again.
  _(Addressed in Unreleased by `POST /admin/printful/sync/clear`, which lets an
  operator clear a stuck sync without waiting out the window.)_
- **No resume.** A reclaimed sync restarts from the beginning of the catalog
  rather than continuing where it stopped.
- **The compensation is unit-tested, not integration-tested.** Which products a
  failed sync may delete is covered by `tests/orphans.test.ts`, but the
  end-to-end rollback is not exercised against a live database:
  `createProductsWorkflow` transitively needs the Inventory module, remote
  links, sales-channel association and the event bus, and `@medusajs/product`'s
  initial migration branches on a live query result, which the plugin test
  harness cannot run.

## 0.3.0

Shipping is priced from Printful's live rates instead of by hand.

### Breaking

- **Fulfillment option ids are now Printful's own method ids.** `printful-standard`
  and `printful-return` are replaced by `STANDARD` and `PRINTFUL_RETURN`, because
  the old ids matched nothing Printful returns and could never price from a live
  quote.

  **A shipping option created against an old id will price at zero — free
  shipping — until you recreate it.** The plugin logs an error naming the option
  each time it happens, but nothing blocks checkout, because Medusa cannot
  complete a cart whose shipping price fails to resolve.

- **Live rates require `dependencies: ["query"]`** on the `@medusajs/medusa/fulfillment`
  module. See the README. Without it every quote falls back to the flat rate.

### Added

- Live shipping rates via `POST /shipping/rates`, behind the `liveShippingRates` option
- Rate caching through Medusa's caching module, with a stale tier that outranks the flat fallback — a day-old real quote beats a typed-in constant
- One Printful call serves every shipping option on a cart; the whole response is cached and each option is selected from it locally
- Australian state codes in `resolveStateCode` — Printful requires `state_code` for AU as well as US and CA, and quotes were going out without it
- `fallbackShippingRates`, `shippingRateCacheTtlSeconds`, and `shippingRateStaleSeconds` options

### Fixed

- `calculatePrice` never throws. Medusa blocks checkout when it does, so a Printful outage no longer prevents customers completing an order
- Rate and catalog-id strings are validated in full rather than through `parseFloat`/`parseInt`, which accepted `"-4.99"` as a negative price and turned catalog id `"40.12"` into variant `40` — a quote for a different product
- The rate cache key hashes a JSON array rather than a delimiter-joined string, so a `|` typed into an address field can no longer collide two different addresses onto one quote
- Configured rates are read as own properties and type-checked, so a shipping option named `toString` no longer returns a function as the price
- A malformed cache entry is treated as a miss instead of throwing before the API call, where it would have pinned every matching cart to the flat rate for the full stale window while Printful was healthy

### Known limits

- The shipping method the customer selected is not passed to Printful, which picks its own. Medusa does not carry provider data from price calculation onto the shipping method; closing this needs a different mechanism and its own release. **Fixed in 0.7.0**, by confirming the method in `validateFulfillmentData` instead.
- Return shipping options are never priced live — Printful quotes outbound shipping only.

## 0.2.0

Printful order state now flows back into Medusa, so customers see tracking and
store owners see failures without opening the Printful dashboard.

### Added

- **Webhook endpoint** `POST /hooks/printful/:token` for `package_shipped`, `order_failed`, `order_canceled`, and `package_returned`
- **Medusa fulfillment and shipment per parcel**, with tracking number and carrier URL. Printful splits orders across facilities, so each parcel gets its own fulfillment covering only its line items
- **`printful_webhook_event` log** — every inbound event stored with a derived `event_id` under a unique index, which is what absorbs Printful's redeliveries
- **Scheduled retry job** every 5 minutes for events that arrived before their order link existed, with exponential backoff to a 6-hour cap and a 20-attempt limit
- **Admin order widget** showing Printful status and per-parcel tracking; reshipments are marked distinctly
- **Webhook configuration route** `GET`/`POST /admin/printful/webhook`, warning that Printful replaces the whole config on save
- Integration tests against real Postgres covering redelivery absorption, the retry query's filter operators, and that a forged payload creates nothing

### Security

- The payload is a **trigger, not a source of truth**. Printful API v1 does not sign webhooks, so every decision comes from re-reading `GET /orders/{id}`
- Constant-time token comparison; a bad token returns `404`, never `401`
- The secret is redacted from `req.path` before Medusa's error handler can log it, and the body-parser limit is sized so real deliveries never trip a 413 that would bypass that redaction
- `canonicalize` is depth-limited, so a deeply nested payload cannot overflow the stack

### Fixed

- Per-order **transaction-scoped advisory lock**. The session-scoped variant leaked under Medusa's connection pooling — lock and unlock could land on different pooled connections, turning a rare duplicate into a permanent hang
- `isUniqueViolation` now recognizes the `MedusaError` that `dbErrorMapper` substitutes for a raw 23505, without which **every redelivered webhook returned 500**

## 0.1.1

### Fixed

- Re-sync now **upserts product variants** (price + new variants), not just core product fields
- Printful order creation is **insert-first** to prevent duplicate orders on concurrent `payment.captured` events
- Shipping `province` is mapped to the ISO `state_code` Printful requires for US/CA (avoids rejected orders)
- Placeholder order link is released if the Printful API call fails, so retries are not permanently blocked

## 0.1.0

### Added

- Printful client (API v1) with retry / rate-limit handling
- Plugin module with product/variant/order links and sync logs
- `printful-sync-products` workflow (Store Products → Medusa)
- `printful-create-order` workflow (Medusa order → Printful via `sync_variant_id`)
- Subscribers: `payment.captured` (primary), optional `order.placed`
- Fulfillment provider `printful-fulfillment`
- Admin routes `POST /admin/printful/sync`, `GET /admin/printful/status`
- Admin widget “Sync Now” on product list
- Optional scheduled daily sync job
- Unit tests for client and mappers
