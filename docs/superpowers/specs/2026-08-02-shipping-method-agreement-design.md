# 0.3.1 — Making the ordered shipping method agree with the quoted one

**Status:** shipped in `0.7.0`
**Follows:** [2026-08-01-live-shipping-rates-design.md](./2026-08-01-live-shipping-rates-design.md),
section "Live rates must agree with what gets ordered"

## Problem

Orders are created without a `shipping` override, so Printful chooses its own
method regardless of which one the customer selected and paid for.

0.3.0 tried to close this and failed. The failure is documented in the previous
spec and is the reason this one exists.

## Why the 0.3.0 attempt was dead code

The intended design stamped `{ printful_shipping, rate_source }` onto the object
returned by `calculatePrice`, then had `createPrintfulOrderWorkflow` read it back
off `order.shipping_methods[].data`.

Medusa never carries that field. `add-shipping-method-to-cart.js` reads exactly
two fields off the calculated price — `calculated_amount` and
`is_calculated_price_tax_inclusive` — and takes `data` from
`validateFulfillmentData` instead. `CalculatedShippingOptionPrice` has no `data`
field, and the implementation needed an `as unknown as` cast to compile. That
cast was the warning.

The code was removed rather than left in place looking functional.

## What makes this release different

The previous spec recorded that `validateFulfillmentData` "runs without rate
context". That is true of _rate_ context and false of _cart_ context, and the
difference is the whole design.

Verified against the installed framework (`@medusajs/core-flows` 2.18.0):

**1. `validateFulfillmentData` receives the entire cart.**
`add-shipping-method-to-cart.js` builds its step input as
`context: { ...cart, from_location: shippingOption?.stock_location ?? {} }`,
where `cart` was fetched with `cartFieldsForRefreshSteps`. That field list
includes `id`, `currency_code`, `shipping_address.*`, `items.*` and
`items.variant.id` — the same inputs `calculatePrice` uses to build a rate
request. So the hook can re-quote.

**2. Its return value is persisted verbatim, and it is the only thing that is.**
The chain was read end to end:

| Step                                       | Code                                         |
| ------------------------------------------ | -------------------------------------------- |
| `validateAndReturnShippingMethodsDataStep` | returns `{ [option.id]: validated }`         |
| `addShippingMethodToCartWorkflow`          | writes `data: methodData?.[option.id] ?? {}` |
| `completeCartWorkflow`                     | copies `data: sm.data` onto the order        |

**3. The never-throw constraint does not bind it.** `calculatePrice` runs on
every cart refresh; `validateFulfillmentData` runs once, when the customer
commits to a method. The existing code already throws there deliberately, for an
unrecognized option id.

Together these make `validateFulfillmentData` the confirmation point: the moment
the customer commits, with everything needed to ask Printful, and the only
writer whose answer survives to the order.

## The property that governs this release

**A `shipping` override is sent to Printful only when Printful itself confirmed
that method for this cart.** A fallback price was never confirmed by Printful, so
insisting on that method risks an order Printful rejects — which is worse than
letting Printful choose.

Everything below follows from that, plus the inherited constraint that
`calculatePrice` must never throw.

## Design decisions

1. **Confirm in `validateFulfillmentData`, not at order creation.** It is where
   the customer commits, it can still influence the outcome, and its return is
   the only value that persists. Re-quoting at order creation would also work
   but happens after the customer has already paid for the method.
2. **Failure is always soft.** Any inability to confirm returns the data
   _without_ `printful_shipping`. Checkout proceeds and the order is created
   with no override — exactly today's behaviour, never worse.
3. **One shared seam builds the rate request.** `calculatePrice` and
   `validateFulfillmentData` must compute the same cache key or the handoff rots
   silently.
4. **Order creation trusts the recorded override.** It is a pure read, with no
   Printful call on the order path.

## Flow

```
Customer selects a shipping method
  → Medusa calls validateFulfillmentData(optionData, data, context)
  → option id in the allowlist?        → no: throw (unchanged, misconfiguration)
  → build rate request from the cart   (shared seam — same key as calculatePrice)
  → query bridged? items resolvable?   → no: stamp non-live, no override
  → cache entry fresh AND offers it?   → yes: stamp live, no API call
  → POST /shipping/rates               → once
  → method present, currency usable?   → yes: stamp live
  → anything above failed              → stamp non-live, no override

payment.captured → createPrintfulOrderWorkflow
  → read order.shipping_methods[].data
  → rate_source === "live" AND printful_shipping set AND in allowlist?
      → yes: send shipping: <id>
      → no:  send no override, Printful chooses
```

## What gets written to `shipping_method.data`

On a confirmed method:

```ts
{ ...data, printful_option_id: id, printful_shipping: id, rate_source: "live" }
```

On any failure to confirm, `printful_shipping` is absent and `rate_source`
records why (`printful_unreachable`, `method_unavailable`, `currency_mismatch`,
`no_printful_items`, `query_unavailable`).

`printful_option_id` is retained unchanged — it is pre-existing and independent
of confirmation.

### The type this field carries

Those failure values are `FallbackReason`s, not `RateSource`s, so the field is
neither of the existing types on its own. A new named type states the union
once rather than letting each call site widen it by hand:

```ts
/** What `shipping_method.data.rate_source` may hold after confirmation. */
export type MethodConfirmation = "live" | FallbackReason
```

Introducing the name is the point: it is what stops `"live"` from being written
by a path that never called Printful.

`misconfigured_zero` is in `FallbackReason` but cannot arise here — it describes
a missing flat rate, which is a pricing concern. Confirmation never consults
`fallbackShippingRates`. The union stays whole rather than hand-pruned, but no
branch should be written to produce it.

### `rate_source: "live"` means something stronger here

In `calculatePrice`, `live` described a _price_. Here it asserts that Printful
named this method for this cart at selection time. A fresh-cache confirmation
still counts as live: the quote came from Printful and named the method.

The two uses share a spelling but not a claim, and only this one gates an
override.

## Details that would otherwise be ambiguous

**Return options are never confirmed.** `PRINTFUL_RETURN_OPTION_ID` is not in
`PRINTFUL_SHIPPING_METHODS`, so it already throws in `validateFulfillmentData`
before reaching the confirm path, and `canCalculate` already excludes it.
Printful's rate API quotes outbound shipping only. No new branch is added; the
confirm path simply never runs for returns.

**A stale cache entry cannot confirm a method.** Only a _fresh_ hit skips the
API call. A stale entry triggers one re-fetch, and only that fetch can stamp
live. If the re-fetch fails, the result is a soft-fail to no override — it must
**not** fall back to the stale entry the way `calculatePrice`'s `staleOrFlat`
does. A stale price is defensible; a stale method confirmation is not.

**The order gate requires both fields.** `shipping` is sent only when
`data.printful_shipping` is set _and_ `data.rate_source === "live"` _and_ the id
is in `PRINTFUL_SHIPPING_METHODS`. Never trust `live` without an id, and never
trust an id that survived from an older release.

**Item building is not duplicated.** Catalog id resolution and the `value` field
come from the same shared seam `calculatePrice` uses, not a second branch.

## Known and accepted: price and confirmation can disagree

The cart may have shown a flat or stale-cache price while the confirmation at
selection is live. The customer is then charged an amount that is not the live
quote, for a method that _is_ live.

This is accepted for 0.3.x. It is rare — it needs a fallback at pricing time and
a success moments later — and both halves are individually honest. Re-pricing on
selection is a separate decision and must not be folded in here.

## Behaviour changes

**New traffic on the checkout path.** Selecting a method costs one Printful call
on a cache miss. It is bounded — once per selection, not per refresh — and the
common case is a fresh-cache hit, because `calculatePrice` populated that exact
key moments earlier. It soft-fails.

**`query` is needed for confirmation too.** The same `dependencies: ["query"]`
the live rates already require. No new operator burden; without it, confirmation
soft-fails to no override.

## Testing

The integration test is the point of this release. 0.3.0 shipped a defect
precisely because nothing drove a real cart through the workflow and read
`shipping_method.data` back.

**Integration (Postgres-backed), both polarities:**

- a confirmed method persists `printful_shipping` and `rate_source: "live"` to
  `shipping_method.data`, read back from the database
- Printful unreachable persists a row with **no** `printful_shipping`, and
  checkout still completes

**Unit:**

- soft-fail reasons produce data without `printful_shipping` — at minimum
  `printful_unreachable` and `method_unavailable`
- a fresh cache hit confirms without calling the API
- a stale entry re-fetches, and a failed re-fetch does not stamp live
- the order gate: live + id + allowlist sends `shipping`; each missing condition
  sends no override

## Not changed

- soft-fail everywhere except the unknown-option-id throw
- no override when unconfirmed
- releasing the order-link claim when Printful rejects the order
- the `dependencies: ["query"]` requirement
