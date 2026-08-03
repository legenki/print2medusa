# Changelog

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
  product prices a hundredfold too large as well. The order page cancels the
  error for costs by dividing by 100; nothing cancels it for catalog prices.
  The fix must change storage, catalog pricing and the widget together, and
  stamp a scale version so already-written values can be told apart.

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
  that metadata gets a hundredfold overstatement. **Wider than first recorded:**
  catalog prices share the same converter, so a JPY store's product prices are
  affected too. See 0.5.3.
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

- The shipping method the customer selected is not passed to Printful, which picks its own. Medusa does not carry provider data from price calculation onto the shipping method; closing this needs a different mechanism and its own release.
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
