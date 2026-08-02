# Changelog

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
