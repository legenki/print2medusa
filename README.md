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

| Feature              | How                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Product sync         | Admin **Sync Now** or `POST /admin/printful/sync` → workflow pulls Printful Sync Products into Medusa |
| Links                | `printful_product_link` / `printful_variant_link` (+ metadata IDs)                                    |
| Orders               | On `payment.captured` → creates Printful order with **`sync_variant_id`**                             |
| Fulfillment provider | Select Printful shipping option in Admin locations                                                    |
| Status               | `GET /admin/printful/status` + product list widget                                                    |

### Idempotency

- Re-sync updates existing products via link tables (no duplicates) and **upserts variants** — price and assortment changes in Printful reach Medusa; manually-added Medusa variants are left untouched.
- Concurrent / re-fired payment events will not create a second Printful order: the order is **claimed insert-first** via a unique index on `printful_order_link.medusa_order_id` before the Printful API is called.
- Shipping `province` is normalized to the 2-letter `state_code` Printful expects for US/CA.

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
- Webhooks / multi-store / live rates: planned Phase 2.

## Options

| Option                | Description                                         |
| --------------------- | --------------------------------------------------- |
| `apiToken`            | Printful private token (required)                   |
| `storeId`             | `X-PF-Store-Id` for account-level tokens            |
| `autoSubmitOrders`    | Confirm orders for fulfillment (default true)       |
| `createOnOrderPlaced` | Also create Printful order on `order.placed`        |
| `allowPartialOrders`  | Allow orders that mix Printful + non-Printful items |
| `markupPercent`       | Markup on retail prices during sync                 |
| `defaultCurrency`     | Fallback currency code                              |

## License

MIT © Andy Legenki
