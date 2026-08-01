# @legenki/print2medusa

[![npm version](https://img.shields.io/npm/v/@legenki/print2medusa.svg)](https://www.npmjs.com/package/@legenki/print2medusa)
[![npm downloads](https://img.shields.io/npm/dm/@legenki/print2medusa.svg)](https://www.npmjs.com/package/@legenki/print2medusa)
[![license](https://img.shields.io/npm/l/@legenki/print2medusa.svg)](./LICENSE)

Printful → Medusa v2 plugin: **sync Store Products**, **auto-create Printful orders** on payment capture, and a **Fulfillment Provider** for admin shipping options.

Published on npm as [`@legenki/print2medusa`](https://www.npmjs.com/package/@legenki/print2medusa). MIT licensed.

## Requirements

- Node.js ≥ 20
- Medusa **2.18.x** (peer dependency)
- Printful store on the **Manual order / API** platform with a private token (`orders`, `sync_products` scopes)

## Install

```bash
npm install @legenki/print2medusa
```

Or add it to a Medusa app the plugin-native way:

```bash
npx medusa plugin:add @legenki/print2medusa
```

Register the plugin and fulfillment provider in `medusa-config.ts`:

```ts
plugins: [
  {
    resolve: "@legenki/print2medusa",
    options: {
      apiToken: process.env.PRINTFUL_API_TOKEN,
      storeId: process.env.PRINTFUL_STORE_ID, // required for account-level tokens
      // autoSubmitOrders: true,
      // createOnOrderPlaced: false,
      // allowPartialOrders: false,
      // markupPercent: 30,
      // defaultCurrency: "USD",
    },
  },
],
modules: [
  {
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [
        {
          resolve: "@medusajs/medusa/fulfillment-manual",
          id: "manual",
        },
        {
          resolve: "@legenki/print2medusa/providers/printful-fulfillment",
          id: "printful",
          options: {
            apiToken: process.env.PRINTFUL_API_TOKEN,
            storeId: process.env.PRINTFUL_STORE_ID,
          },
        },
      ],
    },
  },
],
```

Then migrate:

```bash
npx medusa db:migrate
```

See `examples/basic-store/` for a fuller snippet.

## What it does (MVP)

| Feature | How |
|--------|-----|
| Product sync | Admin **Sync Now** or `POST /admin/printful/sync` → workflow pulls Printful Sync Products into Medusa |
| Links | `printful_product_link` / `printful_variant_link` (+ metadata IDs) |
| Orders | On `payment.captured` → creates Printful order with **`sync_variant_id`** |
| Fulfillment provider | Select Printful shipping option in Admin locations |
| Status | `GET /admin/printful/status` + product list widget |

### Idempotency

- Re-sync updates existing products via link tables (no duplicates) and **upserts variants** — price and assortment changes in Printful reach Medusa; manually-added Medusa variants are left untouched.
- Concurrent / re-fired payment events will not create a second Printful order: the order is **claimed insert-first** via a unique index on `printful_order_link.medusa_order_id` before the Printful API is called.
- Shipping `province` is normalized to the 2-letter `state_code` Printful expects for US/CA.

## Webhooks

Printful notifies the store of fulfillment progress (`package_shipped`,
`order_failed`, `order_canceled`, `package_returned`) at:

```
POST /hooks/printful/<webhookSecret>
```

Set the secret as a plugin option, then register the endpoint with Printful:

```ts
options: {
  apiToken: process.env.PRINTFUL_API_TOKEN,
  webhookSecret: process.env.PRINTFUL_WEBHOOK_SECRET, // long, random
}
```

```bash
curl -X POST https://your-store.com/admin/printful/webhook \
  -H 'content-type: application/json' \
  -d '{"base_url":"https://your-store.com"}'
```

The payload is treated as a **trigger, not a source of truth**: the endpoint
stores the event, answers `200`, and the workflow re-reads
`GET /orders/{id}` from Printful for the authoritative state.

### The secret is in the URL path

Printful API v1's webhook configuration accepts only `url`, `types` and
`params` — there is no custom-header support — so the shared secret has to
travel as a path segment. That has consequences worth planning around.

**Treat the secret as rotatable, and expect it in access logs.** Any reverse
proxy, load balancer, or CDN in front of Medusa logs request paths by default,
and that is entirely outside this plugin's control. Anyone who can read those
logs can forge webhook deliveries.

Mitigations, in rough order of value:

- **Scope it.** The secret only authenticates Printful's callback. It grants no
  API access, and because payloads are re-verified against Printful's API, a
  forged delivery cannot invent a shipment — at worst it triggers a redundant
  re-read.
- **Strip it at the proxy.** If your proxy supports rewriting logged paths, mask
  the segment after `/hooks/printful/`.
- **Rotate it** on any suspected log exposure, and on staff offboarding.

### Rotating the secret

1. Change `webhookSecret` to a new random value and restart Medusa.
2. Re-register with Printful so it stops calling the old URL:
   ```bash
   curl -X POST https://your-store.com/admin/printful/webhook \
     -H 'content-type: application/json' \
     -d '{"base_url":"https://your-store.com"}'
   ```

Printful keeps **one webhook configuration per store**, so step 2 replaces the
previous URL outright — the old secret stops being accepted as soon as Medusa
restarts. Deliveries in flight during the swap are retried by Printful, and
duplicate events are absorbed by the stored `event_id`, so rotation is safe to
perform in production.

`GET /admin/printful/webhook` shows the registered URL with the secret masked,
so the admin UI can confirm the configuration without re-exposing the token.

### Request logging

Errors raised by this route (`404` bad token, `400` malformed payload, `500`
storage failure) are logged with the secret replaced by `[redacted]`, since
Medusa's error handler logs the request path verbatim.

One gap remains and cannot be closed from plugin code: errors thrown by
Medusa's **global body parser** — an oversized body or malformed JSON — reach
the error handler without running any route-scoped middleware, so those log
lines contain the real path. The endpoint's body limit is therefore raised to
**1 MB**, well above the largest realistic delivery (a 50-line-item
`package_shipped` measures ~262 KB; the framework default of 100 KB is in fact
exceeded by roughly a 25-item order), so genuine Printful traffic does not
reach that path. This is another reason to treat the secret as rotatable.

## Admin usage

1. Create products in Printful (Store Products).
2. Open Medusa Admin → Products list → **Printful → Sync Now**.
3. Configure a location shipping option using the **Printful** fulfillment provider.
4. Place a test order and capture payment → Printful receives the order.

## Local plugin development

```bash
npm install
npm run build
npm run dev          # watch + yalc publish
npm test
npm run typecheck
```

In a host Medusa app:

```bash
npx medusa plugin:add @legenki/print2medusa
```

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the planned path from `0.2.0` (webhooks and
order status) through `1.0.0` (stable API and Printful v2 migration), including
the testing strategy for each release.

## Architecture notes

- **Printful is source of truth** for products; Medusa holds a copy + links.
- Printful API **v1** (`https://api.printful.com`).
- Long-running sync runs as a Medusa **workflow** (not a blocking HTTP body only—route awaits the workflow today; can be queued later).
- Webhooks carry their secret in the URL path because Printful v1 supports no
  custom headers — see [Webhooks](#webhooks).
- Multi-store / live rates: planned Phase 2.

## Options

| Option | Description |
|--------|-------------|
| `apiToken` | Printful private token (required) |
| `storeId` | `X-PF-Store-Id` for account-level tokens |
| `autoSubmitOrders` | Confirm orders for fulfillment (default true) |
| `createOnOrderPlaced` | Also create Printful order on `order.placed` |
| `allowPartialOrders` | Allow orders that mix Printful + non-Printful items |
| `markupPercent` | Markup on retail prices during sync |
| `defaultCurrency` | Fallback currency code |
| `webhookSecret` | Shared secret for the Printful webhook path (see [Webhooks](#webhooks)) |

## License

MIT © Andy Legenki
