# Changelog

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
