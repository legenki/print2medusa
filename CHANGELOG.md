# Changelog

## Unreleased

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
