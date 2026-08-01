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
4. **A currency mismatch is a configuration error, not something to convert.**
   Fetching exchange rates would add rate staleness, provider limits, and
   "which rate applied at purchase time" disputes to a print plugin.

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
  → build cache key from address + items + currency + method
  → cache hit and fresh?           → return it
  → POST /shipping/rates           → ShippingInfo[]
  → select the method from optionData
  → currency matches the cart?     → amount, and cache it
  → anything above failed          → fallback
```

### Fallback order

1. **Fresh cache** — within the TTL
2. **Stale cache** — past the TTL but still stored
3. **Flat rate** from `fallbackShippingRates`

Stale cache ranks above the configured flat rate deliberately: a real quote from
last week is almost always closer to the truth than a constant someone typed
once. Entries are therefore stored with a timestamp and a retention window
longer than the freshness TTL, so the provider can tell "fresh" from
"emergency only" itself rather than relying on the cache to expire them.

Every fallback logs at `warn` with the reason, so a store owner can see that
live rates have been silently degraded rather than discovering it in the
month's margins.

## Components

Pure logic stays testable without a Medusa container, following `order-state.ts`
from 0.2.0.

### `src/utils/shipping-rates.ts` (new)

| Export                                      | Responsibility                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `PRINTFUL_SHIPPING_METHODS`                 | The method allowlist we expose as fulfillment options                               |
| `buildRateCacheKey(input)`                  | Deterministic key: normalized address, sorted items, currency, method               |
| `selectRate(rates, methodId, cartCurrency)` | Find the method, verify currency, convert the rate to minor units                   |
| `CachedRate`                                | `{ amount, currency, cached_at }` — the timestamp is what makes staleness decidable |

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

## Plugin options

```ts
liveShippingRates: true,
fallbackShippingRates: {           // required when live rates are on
  PRINTFUL_STANDARD: 500,          // minor units
  PRINTFUL_EXPRESS: 1500,
},
shippingRateCacheTtlSeconds: 600,  // freshness window, default 10 minutes
shippingRateStaleSeconds: 86400,   // how long a stale quote stays usable
```

Enabling `liveShippingRates` without `fallbackShippingRates` is a configuration
error, reported on the first calculation rather than at boot because a provider
has no boot hook.

When it happens and no cached quote exists, the calculation returns **zero**.
That is a deliberate, uncomfortable choice: free shipping is a silent loss for
the store, but throwing would block checkout entirely, and a lost sale costs
more than one under-priced delivery. It is logged at `error` — not `warn` —
because unlike the other fallbacks this one is never correct, only survivable.

## Currency

The cart's currency comes from `context`, not from plugin options — a customer
may pay in EUR at a store whose default is USD.

If Printful's quoted currency differs from the cart's, the rate is unusable:
the provider logs a warning naming both currencies and falls back. It never
converts, and never returns a number denominated in the wrong currency.

## Testing

**Unit**

- `buildRateCacheKey`: stable across item reordering, address casing, and
  whitespace; distinct across genuinely different addresses, carts, currencies,
  and methods
- `selectRate`: method found; method absent; currency mismatch; malformed or
  missing rate; money conversion without float drift

**Resilience — the most valuable tests here**

Each of these must yield a number, never an exception: Printful times out,
returns 500, returns 429, returns an empty list, or omits the requested method.
The assertion is on `calculated_amount` being present, because that is precisely
what Medusa requires to not block the cart.

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

## Out of scope

Currency conversion (decision 4). Return shipping rates — `createReturnFulfillment`
is still a stub and belongs to `0.5.0`. Delivery-date display in the storefront:
the values are returned and cached, but the spec marks them unreliable, so
surfacing them to customers needs its own decision.
