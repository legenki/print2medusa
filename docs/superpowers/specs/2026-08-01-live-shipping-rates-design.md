# 0.3.0 — Live shipping rates

**Status:** approved design
**Issue:** [#3](https://github.com/legenki/print2medusa/issues/3)

## Problem

`canCalculate` returns `false`, so shipping is priced by hand. Every
international order either loses money or overcharges the customer, and the
store owner has no way to know which without checking Printful by hand.

## Design decisions

Four decisions were settled before this spec; everything below follows from them.

1. **Fixed options mapped to Printful methods.** Printful returns a _list_ of
   shipping methods; Medusa prices _one_ shipping option per call. We expose a
   fixed set of options (standard, express) and match the requested one against
   Printful's response. Delivery speed often matters more than price for printed
   goods, and Medusa shipping options are admin-created database rows — they
   cannot be generated per cart.
2. **Cache first, then a flat fallback.** Never let a Printful failure block
   checkout.
3. **Medusa's cache module**, not our own table. The store owner picks the
   backing infrastructure (memory in dev, Redis in production); we do not
   impose a table or write our own eviction.
4. **We never convert currency ourselves.** Sourcing exchange rates would add
   staleness, provider limits, and "which rate applied at purchase time"
   disputes to a print plugin. Printful's own `currency` request parameter
   turns out to do the conversion for us, so we pass the cart's currency and
   treat a mismatched response as a fallback condition rather than something to
   correct.

## The property that governs everything

**`calculatePrice` must never throw and must always return a
`calculated_amount`.** Medusa's documentation is explicit: if it throws, or
returns a result without that field, the shipping option's price cannot be
resolved and the operation is blocked — the customer cannot check out.

So every failure mode converges on one fallback path: Printful unreachable,
timeout, 429, empty method list, the requested method absent for that country,
or a currency mismatch.

## Flow

```
Cart updated
  → Medusa calls calculatePrice(optionData, data, context)
  → address complete enough to quote?  → no: incomplete_address
  → resolve Printful variant ids via query
  → any Printful items left?           → no: no_printful_items
  → cache key from address + items + currency   (no method)
  → cached quote, and fresh?           → select method from it, done
  → POST /shipping/rates               → ShippingInfo[], cache the whole list
  → select the requested method
  → currency usable?                   → amount
  → anything above failed              → stale cache, then flat rate
```

### Fallback order

1. **Fresh cache** — within the TTL
2. **Stale cache** — past the TTL but still stored
3. **Flat rate** from `fallbackShippingRates`

Stale cache ranks above the configured flat rate deliberately: a real quote from
last week is almost always closer to the truth than a constant someone typed
once.

**The cache entry's TTL is the stale window, not the freshness window.** Writing
`cache.set(key, value, shippingRateCacheTtlSeconds)` would delete the entry after
ten minutes and leave nothing to fall back to — the stale path would be dead code
and the integration test for it impossible to write. So:

- store with `ttl = shippingRateStaleSeconds` (the retention window)
- decide freshness in application code: `now - cached_at < shippingRateCacheTtlSeconds`

That is why `CachedQuote` carries `cached_at`; the cache never decides freshness
for us.

### Fallback reasons

Every fallback records a machine-readable reason, returned in the result's
`data` and logged. They are not interchangeable — one of them is a genuine
mispricing risk rather than a degradation:

| Reason                 | Meaning                                                              | Log level |
| ---------------------- | -------------------------------------------------------------------- | --------- |
| `printful_unreachable` | Timeout, 5xx, 429                                                    | `warn`    |
| `method_unavailable`   | API answered, but this method is not offered for that destination    | `warn`    |
| `currency_mismatch`    | Quote returned in a currency the cart cannot use                     | `warn`    |
| `incomplete_address`   | Not enough address to quote; Printful never called                   | `debug`   |
| `no_printful_items`    | No cart line resolved to a Printful catalog variant                  | `debug`   |
| `query_unavailable`    | `dependencies: ["query"]` missing from the fulfillment module config | `error`   |
| `misconfigured_zero`   | `fallbackShippingRates` missing — returns 0                          | `error`   |

`method_unavailable` deserves attention: the customer is charged the flat
express rate for a method **Printful will not actually offer on the order**. The
price is collected but the promised service may not exist. Order creation must
therefore handle it — see below.

## Live rates must agree with what gets ordered

A quoted method that Printful will not accept at order time is worse than a
wrong price: the customer paid for a service they will not receive.

So the shipping method's `data` records what was quoted:

```ts
{
  printful_shipping: "STANDARD",   // the id we quoted
  rate_source: "live" | "stale_cache" | "flat_fallback" | "misconfigured_zero",
}
```

`createPrintfulOrderWorkflow` then passes `shipping` to Printful when the source
is `live`. When it is anything else, the order is created **without** a shipping
override — Printful picks its own default — and the discrepancy is logged, since
we have no basis to insist on a method we never successfully quoted.

Full reconciliation (refunding or re-quoting when Printful's actual method
differs from what was charged) is deliberately left to a follow-up; this release
guarantees only that a fallback quote never forces an invalid order.

## Getting the Printful variant id — the constraint that shapes this release

Reconnaissance against the installed framework settled three things that the
TypeScript types alone do not tell you. Each was verified by reading Medusa's
own field lists and, where possible, by running code.

**1. Variant metadata is not in the context.** `calculatePrice` receives
`cartFieldsForCalculateShippingOptionsPrices`, which selects
`items.variant.{id,weight,length,height,width,material}` and
`items.variant.product.id` — nothing else. This is a strict projection, not a
loose type: unlisted columns are absent from the runtime object, confirmed by
reading the same variant twice with and without `metadata` in the select.

`validateFulfillmentData` is no better. It runs off
`cartFieldsForRefreshSteps`, which lists the same variant fields. So the
otherwise-attractive idea of resolving ids during validation and stashing them
in `data` does not work either — the metadata is absent at both points.

**2. `context.currency_code` does exist at runtime**, even though the type omits
it. The cart workflow appends `currency_code` to its field list and spreads the
whole cart into the context, and a validation step asserts it is present. We
read it, but defensively: it is an undeclared contract that a minor release
could withdraw, so its absence degrades rather than throws.

**3. A fulfillment provider cannot resolve other modules by default.** Module
providers receive a fresh container with only an allowlist bridged from the app
container — `manager`, `pg_connection`, `logger`, `configModule`, `caching`,
`event_bus`. Resolving `printful`, `query`, or the product module throws.

Medusa's supported escape hatch is the `dependencies` array on the module
registration, which bridges additional keys into that container.

### What this requires from the store owner

```ts
{
  resolve: "@medusajs/medusa/fulfillment",
  dependencies: ["query"],        // required for live rates
  options: { providers: [ /* ... */ ] },
}
```

The provider resolves `query` and reads variant metadata by id:

```ts
query.graph({
  entity: "product_variant",
  filters: { id: variantIds },
  fields: ["id", "metadata"],
})
```

One query per rate calculation, batched across all line items — not one per
item.

**A missing `dependencies` entry resolves to `undefined` rather than throwing**,
which would make live rates fail silently. So the provider checks at
construction: if `liveShippingRates` is on and `query` is unavailable, it logs
an `error` naming the exact config change needed, and every calculation falls
back with reason `query_unavailable`. Loud and diagnosable, never silent.

The README documents this as a required installation step for live rates, beside
the `fallbackShippingRates` requirement.

### Which Printful id we send

`ItemInfo` accepts `variant_id` (Catalog), `external_variant_id` (a _sync_
platform's id), or `warehouse_product_variant_id`. We send `variant_id` from
`printful_catalog_variant_id`.

We do **not** substitute `printful_sync_variant_id` when the catalog id is
missing. A sync variant id is not a catalog variant id, and `/shipping/rates`
has no `sync_variant_id` field — unlike the Orders API, which is why
`create-printful-order.ts` can use it there but this cannot. Sending it in
`external_variant_id` would be claiming an id we never registered with Printful.
Items without a catalog id are skipped, exactly like non-Printful items.

## Components

Pure logic stays testable without a Medusa container, following `order-state.ts`
from 0.2.0.

### `src/utils/shipping-rates.ts` (new)

| Export                                      | Responsibility                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PRINTFUL_SHIPPING_METHODS`                 | The method allowlist we expose as fulfillment options                                                        |
| `buildRateCacheKey(input)`                  | Deterministic key: normalized address, sorted items, currency. **No method** — one call serves every option  |
| `selectRate(rates, methodId, cartCurrency)` | Find the method in a quote list, verify currency, convert the rate to minor units                            |
| `CachedQuote`                               | `{ rates: ShippingInfo[], currency, cached_at }` — the whole response, timestamped so staleness is decidable |

`buildRateCacheKey` must produce the same key for carts that differ only in
incidental ways — item order, address casing, surrounding whitespace. A key that
varies with item order means the cache never hits, which is indistinguishable
from having no cache at all except for the wasted code.

`selectRate` converts through the existing `parsePriceToMinorUnits`. Printful
sends the rate as a _string_ (`"4.99"`); `parseFloat("4.99") * 100` yields
`498.99999999999994`. That helper already handles it correctly and is already
tested — reuse it rather than writing the same conversion a second time.

### `src/utils/printful-client.ts` (modified)

Add `getShippingRates(recipient, items, currency?)` → `POST /shipping/rates`,
going through the existing `request()` helper so retry and rate-limit handling
apply unchanged.

### `src/providers/printful-fulfillment/service.ts` (modified)

- `canCalculate` → `true`
- `calculatePrice` → the real implementation, structured so no path can throw
- `getFulfillmentOptions` → one option per entry in `PRINTFUL_SHIPPING_METHODS`

### `src/utils/types.ts` (modified)

`ShippingInfo`, `ShippingRatesRequest`, and the new plugin options.

## Printful's response shape

Confirmed against the v1 OpenAPI spec. `POST /shipping/rates` returns
`ShippingInfo[]`:

| Field                                 | Notes                                     |
| ------------------------------------- | ----------------------------------------- |
| `id`                                  | Method id — what we match against         |
| `name`                                | Human-readable label                      |
| `rate`                                | **String**, e.g. `"4.99"`                 |
| `currency`                            | Set by the Printful store's own settings  |
| `minDeliveryDays` / `maxDeliveryDays` | Estimates; the spec marks them unreliable |

The recipient requires `country_code`; `state_code` is required for **US, AU,
and CA**. `resolveStateCode` from 0.1.1 normalizes a Medusa `province` into that
code and is reused here — but **it currently covers only US and CA**. Australia
must be added to its state table as part of this release, or every AU quote goes
out missing a field Printful requires. That gap is why the country matrix test
below names AU explicitly.

### Request body

`required: ["recipient", "items"]`, plus two optional fields that matter:

| Field       | Notes                                                        |
| ----------- | ------------------------------------------------------------ |
| `recipient` | `ShippingRatesAddress`                                       |
| `items`     | Array of `ItemInfo`                                          |
| `currency`  | 3-letter code — "required if the rates need to be converted" |
| `locale`    | Language for method names                                    |

`ItemInfo` requires only `quantity`, and identifies the product by **one of**
`variant_id` (Catalog Variant ID), `external_variant_id`, or
`warehouse_product_variant_id`. It also accepts `value`, the item's retail price,
which Printful uses to compute duties more accurately.

We send `variant_id` + `quantity` + `value`. The catalog variant id is stored
during sync as `printful_catalog_variant_id` in each Medusa variant's metadata
(`mappers.ts`) and is fetched through `query` at calculation time — see the
constraint section above for why it cannot come from the context.

`value` is the item's unit price, available on the line item itself
(`items.*` is selected, so the line item's own fields are present even though
the variant's metadata is not).

**When a variant has no `printful_catalog_variant_id`, skip it.** That covers
two real cases: a non-Printful product in a mixed store, and a Printful variant
synced before the mapper stored that id — it writes `undefined` whenever
Printful's `variant_id` was absent. Skipping keeps the quote valid for the part
of the cart Printful actually fulfills. If skipping leaves **no items at all**,
do not call the API — fall back with reason `no_printful_items`, since a rate
request with an empty cart is meaningless.

### Currency: Printful can convert

The request accepts a `currency` parameter — "required if the rates need to be
converted" — so Printful converts at its own rate and we never source an
exchange rate ourselves.

We pass the cart's currency when we know it. `currency_mismatch` stays as a
guard: if the response still comes back in a currency the cart cannot use, the
quote is discarded rather than displayed.

## Plugin options

```ts
liveShippingRates: true,
fallbackShippingRates: {           // required when live rates are on
  STANDARD: 500,                   // minor units, keyed by Printful method id
  EXPRESS: 1500,
},
shippingRateCacheTtlSeconds: 600,  // freshness window, default 10 minutes
shippingRateStaleSeconds: 86400,   // how long a stale quote stays usable
```

### One id, three places

The Printful method id is the single identifier used throughout. Medusa's
fulfillment option id, the `fallbackShippingRates` key, and Printful's
`ShippingInfo.id` are the **same string**, so they cannot drift apart:

| Medusa option id | Printful `ShippingInfo.id` | Fallback key |
| ---------------- | -------------------------- | ------------ |
| `STANDARD`       | `STANDARD`                 | `STANDARD`   |

The existing provider exposes `printful-standard` and `printful-return`, which
match nothing Printful returns. Those ids are replaced. This is a **breaking
change** for any store that already created a shipping option against them: the
option must be recreated. The CHANGELOG must say so under a `Changed` heading —
a silently renamed option id would leave a store with a shipping method that
never prices.

**The allowlist is fixed from the contract fixture, not guessed.** The OpenAPI
spec documents `ShippingInfo.id` as a free-form string with the single example
`STANDARD`; it publishes no enum. The first implementation task therefore
records a real response and derives `PRINTFUL_SHIPPING_METHODS` from it. Until
that fixture exists, treat `STANDARD` as the only id we know to be real.

The return option keeps `is_return: true` and does **not** calculate live rates —
return shipping belongs to `0.5.0`.

### `canCalculate` follows the flag

`canCalculate` returns `!!liveShippingRates`. With the flag off the provider
behaves exactly as it does today (flat, admin-set prices) and
`fallbackShippingRates` is not required. It is required only when live rates are
switched on, which is the only situation where a Printful failure could block a
cart.

### Result shape

`CalculatedShippingOptionPrice` needs both fields:

```ts
{
  calculated_amount: number,
  is_calculated_price_tax_inclusive: false,
}
```

`false` is correct here: Printful quotes shipping exclusive of tax, and Medusa's
tax module applies tax separately.

Enabling `liveShippingRates` without `fallbackShippingRates` is a configuration
error, reported on the first calculation rather than at boot because a provider
has no boot hook.

When it happens and no cached quote exists, the calculation returns **zero**,
with `rate_source: "misconfigured_zero"` recorded in the result data so the
cause is visible on the order rather than only in a log line.

That is a deliberate, uncomfortable choice: free shipping is a silent loss for
the store, but throwing would block checkout entirely, and a lost sale costs
more than one under-priced delivery. It is logged at `error` — not `warn` —
because unlike the other fallbacks this one is never correct, only survivable.

`fallbackShippingRates` must contain an entry for **every** id in
`PRINTFUL_SHIPPING_METHODS`. One `STANDARD` entry does not cover an `EXPRESS`
option; the missing key would silently price express shipping at zero. The
README states this explicitly.

## Do not call Printful with an incomplete address

`calculatePrice` runs on every cart refresh, including long before a shipping
address exists. Quoting needs at minimum a `country_code`, plus a `state_code`
for US, AU, and CA.

When the address is not complete enough, **do not call the API at all** — fall
back immediately with reason `incomplete_address`, logged at `debug` rather than
`warn` because it is the expected state of an early cart, not a problem. Calling
anyway would mean a burst of 400s on every storefront visit and a cache filled
with failures.

## Cache is optional

The provider resolves `Modules.CACHE` defensively. If it is unavailable, live
rates still work — every request simply goes to Printful and the fallback chain
loses its stale tier, degrading to `live → flat`. A missing cache module must
never prevent the provider from pricing.

## One API call per cart, not per option

A store offering standard and express calls `calculatePrice` once per option, on
every cart refresh. Keying the cache per method would multiply Printful calls by
the number of options for no benefit — the API returns _all_ methods in a single
response.

So the cache stores the **whole `ShippingInfo[]`** under a key of address +
items + currency, with no method in it. `selectRate` then picks the requested
method from that cached list locally. Two options on one cart cost one API call;
the second is a cache hit.

This matters for rate limits, and it is why `buildRateCacheKey` deliberately
excludes the method id.

## Currency

The cart's currency comes from `context.currency_code`, not from plugin options —
a customer may pay in EUR at a store whose default is USD. Printful expects an
uppercase 3-letter code while Medusa stores it lowercase, so it is upper-cased on
the way out.

If Printful's quoted currency differs from the cart's, the rate is unusable:
the provider logs a warning naming both currencies and falls back. It never
converts, and never returns a number denominated in the wrong currency.

## Testing

**Unit**

- `buildRateCacheKey`: stable across item reordering, address casing, and
  whitespace; distinct across genuinely different addresses, carts, and
  currencies. **Not** varied by method — one quote serves every option
- `selectRate`: method found; method absent; currency mismatch; malformed or
  missing rate; money conversion without float drift
- Item building: variants without `printful_catalog_variant_id` are skipped; an
  all-skipped cart yields `no_printful_items` rather than an empty API call
- Address completeness: missing country, and a missing state for US/AU/CA, both
  short-circuit to `incomplete_address` without calling Printful

**Resilience — the most valuable tests here**

Each of these must yield a number, never an exception: Printful times out,
returns 500, returns 429, returns an empty list, omits the requested method,
`query` is unavailable, or `fallbackShippingRates` is missing entirely. The
assertion is on `calculated_amount` being present, because that is precisely
what Medusa requires to not block the cart.

Each case must also report the right `rate_source`, since that is what tells a
store owner whether they are pricing from a live quote, a stale one, or a
constant.

**Freshness, not just presence**

A cached entry older than `shippingRateCacheTtlSeconds` but within
`shippingRateStaleSeconds` must be used only after a live attempt fails — never
in place of one. Writing the entry with the freshness TTL instead of the stale
TTL would delete it too early and make this untestable, which is the bug this
test exists to catch.

**Contract**

A recorded real `/shipping/rates` response as a fixture, so a schema change on
Printful's side breaks the suite instead of silently producing wrong prices.

**Country matrix**

US / CA / AU / DE / GB / JP — correct `state_code` handling and a rate returned
for each. AU is the one that fails today: `resolveStateCode` has no Australian
state table, so "New South Wales" resolves to nothing and the quote goes out
without a field Printful requires. Write that test first and watch it fail
before adding the table.

**Integration**

Against the cache module: two identical requests hit Printful once; a changed
address refetches; a stale entry is preferred over the flat fallback.

## Settle these before building on them

Two assumptions survive the reconnaissance unverified. Both are cheap to test
and expensive to be wrong about, so the first implementation task resolves them
against the live API and the allowlist follows from the answers.

1. **The exact `ShippingInfo.id` values.** No `PRINTFUL_API_TOKEN` was
   available, so the contract fixture (`tests/fixtures/printful-shipping-rates.json`)
   is derived from the OpenAPI schema (`components.schemas.ShippingInfo`)
   rather than recorded from a live call. The spec documents `id` as a
   free-form string with the single example `STANDARD` and publishes no enum,
   so `STANDARD` is the only id known to be real and `PRINTFUL_SHIPPING_METHODS`
   allowlists only that one. Recording a live response later — for a US and a
   non-US address — may reveal more ids that can be added to the allowlist
   without rework.

2. **That `context.currency_code` survives a full app boot.** It was traced
   through the workflow's field list and proven to pass through the module
   service unchanged, but not observed end-to-end in a running checkout. The
   code reads it defensively regardless: absent currency means we omit the
   parameter and let Printful quote in the store's own currency, where the
   existing `currency_mismatch` guard catches any discrepancy.

## Out of scope

Currency conversion (decision 4). Return shipping rates — `createReturnFulfillment`
is still a stub and belongs to `0.5.0`. Delivery-date display in the storefront:
the values are returned and cached, but the spec marks them unreliable, so
surfacing them to customers needs its own decision.
