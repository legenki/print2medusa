# Live Shipping Rates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price shipping from Printful's live rates at checkout, without ever letting a Printful failure block a cart.

**Architecture:** The provider resolves variant metadata through Medusa's Query (bridged in via the fulfillment module's `dependencies`), asks Printful for all shipping methods at once, caches the whole response, and picks the requested method locally. Every failure path — unreachable API, missing method, unusable currency, missing config — converges on a fallback chain of fresh cache → stale cache → flat rate, because Medusa blocks checkout if `calculatePrice` throws.

**Tech Stack:** Medusa v2.18 (fulfillment provider, Query, cache module), TypeScript, Vitest, Printful API v1.

**Spec:** `docs/superpowers/specs/2026-08-01-live-shipping-rates-design.md`
**Issue:** [#3](https://github.com/legenki/print2medusa/issues/3)

---

## Repo conventions

- **Stage explicitly.** `git status --short` before every commit; stage by path. Never `git add -A` — an earlier commit here swept in 89,000 files.
- **Prettier is enforced.** Run `npm run format` before committing or CI fails on `format:check`.
- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement. A test never seen failing proves nothing.
- **Verify assumptions about Medusa against `node_modules`.** Three defects in 0.2.0 came from plan text asserting APIs that did not exist.

## File Structure

**Create:**

| File                                          | Responsibility                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/utils/shipping-rates.ts`                 | Pure logic: cache key, method selection, address completeness, item building |
| `tests/shipping-rates.test.ts`                | Unit tests for the above                                                     |
| `tests/fixtures/printful-shipping-rates.json` | Recorded API response — the contract fixture                                 |
| `tests/shipping-provider.test.ts`             | Provider tests: the fallback chain and `rate_source`                         |

**Modify:**

| File                                            | Change                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `src/utils/types.ts`                            | `ShippingInfo`, `ShippingRatesRequest`, `CachedQuote`, new plugin options   |
| `src/utils/printful-client.ts`                  | `getShippingRates()`                                                        |
| `src/utils/mappers.ts`                          | Australian state table in `resolveStateCode`                                |
| `src/providers/printful-fulfillment/service.ts` | `canCalculate`, `calculatePrice`, `getFulfillmentOptions`, container wiring |
| `src/workflows/create-printful-order.ts`        | Pass the quoted `shipping` method through to Printful                       |
| `README.md`                                     | The `dependencies` requirement and `fallbackShippingRates`                  |
| `CHANGELOG.md`                                  | Breaking change: option ids                                                 |

Pure logic lives in `src/utils/` so it tests without a Medusa container, matching `order-state.ts` from 0.2.0.

---

## Task 1: Settle the unknowns and record the fixture

The spec names two assumptions that must not be guessed at. This task removes them.

**Files:**

- Create: `tests/fixtures/printful-shipping-rates.json`
- Modify: `docs/superpowers/specs/2026-08-01-live-shipping-rates-design.md`

- [ ] **Step 1: Record a real response**

If a Printful API token is available in the environment (`PRINTFUL_API_TOKEN`), call the endpoint for a US address and save the response verbatim:

```bash
curl -s -X POST https://api.printful.com/shipping/rates \
  -H "Authorization: Bearer $PRINTFUL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": { "address1": "19749 Dearborn St", "city": "Chatsworth", "country_code": "US", "state_code": "CA", "zip": "91311" },
    "items": [{ "variant_id": 1, "quantity": 1 }]
  }' | tee tests/fixtures/printful-shipping-rates.json
```

**If no token is available**, do not invent one. Write the fixture from the OpenAPI schema shape instead, using `STANDARD` as the only id (the single documented example), and report clearly in your final message that the fixture is schema-derived rather than recorded — the allowlist then stays at `STANDARD` alone until someone records a real call.

- [ ] **Step 2: Derive the method allowlist**

Read the `id` values from the fixture. These are the real `ShippingInfo.id` strings.

- [ ] **Step 3: Record what you found in the spec**

In `docs/superpowers/specs/2026-08-01-live-shipping-rates-design.md`, replace the "Settle these before building on them" section's first item with the actual ids found, and note whether the fixture was recorded live or derived from the schema.

- [ ] **Step 4: Commit**

```bash
npm run format
git add tests/fixtures/printful-shipping-rates.json docs/superpowers/specs/2026-08-01-live-shipping-rates-design.md
git status --short
git commit -m "test: record Printful shipping rates fixture

Refs #3"
```

---

## Task 2: Australian state codes

`resolveStateCode` covers US and CA. Printful requires `state_code` for AU too, so every Australian quote currently ships without a required field.

**Files:**

- Modify: `src/utils/mappers.ts`
- Test: `tests/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("resolveStateCode", ...)` block in `tests/mappers.test.ts`:

```typescript
it("maps Australian state and territory names to their code", () => {
  expect(resolveStateCode("New South Wales", "AU")).toBe("NSW")
  expect(resolveStateCode("victoria", "AU")).toBe("VIC")
  expect(resolveStateCode("Queensland", "AU")).toBe("QLD")
  expect(resolveStateCode("Australian Capital Territory", "AU")).toBe("ACT")
})

it("passes through valid Australian codes", () => {
  expect(resolveStateCode("NSW", "AU")).toBe("NSW")
  expect(resolveStateCode("wa", "AU")).toBe("WA")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — `resolveStateCode("New South Wales", "AU")` returns `undefined` because there is no AU table.

- [ ] **Step 3: Add the table**

In `src/utils/mappers.ts`, add to `STATE_TABLES` after the `CA` entry:

```typescript
  AU: {
    "australian capital territory": "ACT",
    "new south wales": "NSW",
    "northern territory": "NT",
    queensland: "QLD",
    "south australia": "SA",
    tasmania: "TAS",
    victoria: "VIC",
    "western australia": "WA",
  },
```

Note the existing passthrough branch accepts a 2-letter code only when it appears in the table's values; `ACT`, `NSW`, `QLD`, and `TAS` are 3 letters, so extend that check:

```typescript
const codes = new Set(Object.values(table))
const upper = raw.toUpperCase()
if (upper.length <= 3 && codes.has(upper)) {
  return upper
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS. All previously passing tests still pass — the `length <= 3` change must not break the US/CA cases.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/mappers.ts tests/mappers.test.ts
git status --short
git commit -m "feat: resolve Australian state codes for Printful

Refs #3"
```

---

## Task 3: Types

**Files:**

- Modify: `src/utils/types.ts`

No test — types are exercised by every task that follows, and `npm run typecheck` is the check.

- [ ] **Step 1: Add the API types**

Append to `src/utils/types.ts`:

```typescript
/** One shipping method returned by POST /shipping/rates. */
export type ShippingInfo = {
  id: string
  name: string
  /** Decimal string, e.g. "4.99" — never parse this as a float for money. */
  rate: string
  currency: string
  minDeliveryDays?: number
  maxDeliveryDays?: number
  minDeliveryDate?: string
  maxDeliveryDate?: string
}

/** One item in a shipping rate request. */
export type ShippingRateItem = {
  /** Printful Catalog variant id. */
  variant_id: number
  quantity: number
  /** Item retail value; helps Printful compute duties. */
  value?: string
}

export type ShippingRatesRequest = {
  recipient: {
    address1?: string
    address2?: string
    city?: string
    state_code?: string
    country_code: string
    zip?: string
    phone?: string
  }
  items: ShippingRateItem[]
  /** Printful converts the quote into this currency when set. */
  currency?: string
  locale?: string
}

/**
 * A cached rate response. Stored with the STALE ttl, not the freshness ttl —
 * freshness is decided from `cached_at`, so an expired-but-retained quote can
 * still serve as a fallback.
 */
export type CachedQuote = {
  rates: ShippingInfo[]
  currency: string
  cached_at: number
}

/** Where a returned price came from. Recorded on the shipping method. */
export type RateSource =
  | "live"
  | "fresh_cache"
  | "stale_cache"
  | "flat_fallback"
  | "misconfigured_zero"

/** Why a live quote was not used. */
export type FallbackReason =
  | "printful_unreachable"
  | "method_unavailable"
  | "currency_mismatch"
  | "incomplete_address"
  | "no_printful_items"
  | "query_unavailable"
  | "misconfigured_zero"
```

- [ ] **Step 2: Add the plugin options**

In the same file, add to `PrintfulPluginOptions`:

```typescript
  /** Enable live shipping rates. Requires fallbackShippingRates. */
  liveShippingRates?: boolean
  /** Flat rate per method id, in minor units. Required when live rates are on. */
  fallbackShippingRates?: Record<string, number>
  /** How long a quote counts as fresh. Default 600. */
  shippingRateCacheTtlSeconds?: number
  /** How long a quote is retained for emergency use. Default 86400. */
  shippingRateStaleSeconds?: number
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
npm run format
git add src/utils/types.ts
git status --short
git commit -m "feat: types for Printful shipping rates

Refs #3"
```

---

## Task 4: Cache key

**Files:**

- Create: `src/utils/shipping-rates.ts`
- Create: `tests/shipping-rates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { buildRateCacheKey } from "../src/utils/shipping-rates"

const address = {
  country_code: "US",
  state_code: "CA",
  city: "Chatsworth",
  zip: "91311",
}

describe("buildRateCacheKey", () => {
  it("is stable for identical input", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    expect(a).toBe(b)
  })

  it("ignores item order", () => {
    const a = buildRateCacheKey({
      address,
      items: [
        { variant_id: 1, quantity: 1 },
        { variant_id: 2, quantity: 3 },
      ],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [
        { variant_id: 2, quantity: 3 },
        { variant_id: 1, quantity: 1 },
      ],
      currency: "USD",
    })
    expect(a).toBe(b)
  })

  it("ignores address casing and surrounding whitespace", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address: {
        country_code: " us ",
        state_code: "ca",
        city: " CHATSWORTH",
        zip: "91311 ",
      },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "usd",
    })
    expect(a).toBe(b)
  })

  it("differs when the address differs", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address: { ...address, zip: "90210" },
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })

  it("differs when quantities differ", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 2 }],
      currency: "USD",
    })
    expect(a).not.toBe(b)
  })

  it("differs when the currency differs", () => {
    const a = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "USD",
    })
    const b = buildRateCacheKey({
      address,
      items: [{ variant_id: 1, quantity: 1 }],
      currency: "EUR",
    })
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "Cannot find module '../src/utils/shipping-rates'"

- [ ] **Step 3: Implement**

Create `src/utils/shipping-rates.ts`:

```typescript
import { createHash } from "crypto"
import type { ShippingRateItem, ShippingRatesRequest } from "./types"

export type RateCacheKeyInput = {
  address: ShippingRatesRequest["recipient"]
  items: ShippingRateItem[]
  currency: string
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

/**
 * Cache key for a rate quote.
 *
 * Deliberately excludes the shipping method: Printful returns every method in
 * one response, so a store offering two options costs one API call rather than
 * two. `selectRate` picks the method from the cached list locally.
 *
 * Carts that differ only incidentally — item order, address casing, stray
 * whitespace — must produce the same key, or the cache never hits.
 */
export function buildRateCacheKey(input: RateCacheKeyInput): string {
  const address = [
    normalize(input.address.country_code),
    normalize(input.address.state_code),
    normalize(input.address.city),
    normalize(input.address.zip),
    normalize(input.address.address1),
    normalize(input.address.address2),
  ].join("|")

  const items = [...input.items]
    .map((i) => `${i.variant_id}x${i.quantity}`)
    .sort()
    .join(",")

  return createHash("sha256")
    .update(`${address}#${items}#${normalize(input.currency)}`)
    .digest("hex")
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS, 6 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/shipping-rates.ts tests/shipping-rates.test.ts
git status --short
git commit -m "feat: deterministic cache key for shipping quotes

Refs #3"
```

---

## Task 5: Rate selection

**Files:**

- Modify: `src/utils/shipping-rates.ts`
- Modify: `tests/shipping-rates.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/shipping-rates.test.ts`:

```typescript
import { selectRate } from "../src/utils/shipping-rates"
import type { ShippingInfo } from "../src/utils/types"

const rates: ShippingInfo[] = [
  { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
  { id: "EXPRESS", name: "Express", rate: "15.50", currency: "USD" },
]

describe("selectRate", () => {
  it("finds the method and converts to minor units", () => {
    const result = selectRate(rates, "STANDARD", "USD")
    expect(result).toEqual({ ok: true, amount: 499 })
  })

  it("converts without float drift", () => {
    // parseFloat("4.99") * 100 is 498.99999999999994
    expect(selectRate(rates, "STANDARD", "USD")).toEqual({
      ok: true,
      amount: 499,
    })
    expect(selectRate(rates, "EXPRESS", "USD")).toEqual({
      ok: true,
      amount: 1550,
    })
  })

  it("reports method_unavailable when the id is absent", () => {
    expect(selectRate(rates, "OVERNIGHT", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("reports currency_mismatch when the quote is in another currency", () => {
    expect(selectRate(rates, "STANDARD", "EUR")).toEqual({
      ok: false,
      reason: "currency_mismatch",
    })
  })

  it("compares currency case-insensitively", () => {
    expect(selectRate(rates, "STANDARD", "usd")).toEqual({
      ok: true,
      amount: 499,
    })
  })

  it("reports method_unavailable for an empty list", () => {
    expect(selectRate([], "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })

  it("rejects a malformed rate rather than returning NaN", () => {
    const bad: ShippingInfo[] = [
      { id: "STANDARD", name: "x", rate: "not-a-number", currency: "USD" },
    ]
    expect(selectRate(bad, "STANDARD", "USD")).toEqual({
      ok: false,
      reason: "method_unavailable",
    })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "selectRate is not a function"

- [ ] **Step 3: Implement**

Append to `src/utils/shipping-rates.ts`:

```typescript
import { parsePriceToMinorUnits } from "./mappers"
import type { FallbackReason, ShippingInfo } from "./types"

export type RateSelection =
  { ok: true; amount: number } | { ok: false; reason: FallbackReason }

/**
 * Pick one method out of a quote list.
 *
 * Printful sends `rate` as a decimal string; `parsePriceToMinorUnits` rounds it
 * correctly, where `parseFloat("4.99") * 100` would yield 498.99999999999994.
 *
 * A quote in a currency the cart cannot use is rejected rather than converted —
 * we never source an exchange rate ourselves.
 */
export function selectRate(
  rates: ShippingInfo[],
  methodId: string,
  cartCurrency: string
): RateSelection {
  const match = rates.find((r) => r.id === methodId)
  if (!match) {
    return { ok: false, reason: "method_unavailable" }
  }

  if (
    match.currency.trim().toUpperCase() !== cartCurrency.trim().toUpperCase()
  ) {
    return { ok: false, reason: "currency_mismatch" }
  }

  // parsePriceToMinorUnits returns 0 for unparseable input, which would be a
  // free delivery rather than an error — treat a non-numeric rate as no rate.
  if (!match.rate || Number.isNaN(Number.parseFloat(match.rate))) {
    return { ok: false, reason: "method_unavailable" }
  }

  return { ok: true, amount: parsePriceToMinorUnits(match.rate) }
}
```

Merge the new `import` statements into the existing ones at the top of the file rather than adding duplicates.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS, 7 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/shipping-rates.ts tests/shipping-rates.test.ts
git status --short
git commit -m "feat: select a shipping method from a Printful quote

Refs #3"
```

---

## Task 6: Address completeness and item building

**Files:**

- Modify: `src/utils/shipping-rates.ts`
- Modify: `tests/shipping-rates.test.ts`

These two guards keep us from calling Printful with input it will reject — a burst of 400s on every storefront visit.

- [ ] **Step 1: Write the failing test**

Append to `tests/shipping-rates.test.ts`:

```typescript
import { buildRateItems, isAddressQuotable } from "../src/utils/shipping-rates"

describe("isAddressQuotable", () => {
  it("accepts a country-only address for countries without state requirements", () => {
    expect(isAddressQuotable({ country_code: "DE" })).toBe(true)
    expect(isAddressQuotable({ country_code: "GB" })).toBe(true)
    expect(isAddressQuotable({ country_code: "JP" })).toBe(true)
  })

  it("requires a state code for US, AU, and CA", () => {
    expect(isAddressQuotable({ country_code: "US" })).toBe(false)
    expect(isAddressQuotable({ country_code: "AU" })).toBe(false)
    expect(isAddressQuotable({ country_code: "CA" })).toBe(false)
    expect(isAddressQuotable({ country_code: "US", state_code: "CA" })).toBe(
      true
    )
  })

  it("rejects a missing or blank country", () => {
    expect(isAddressQuotable({ country_code: "" })).toBe(false)
    expect(isAddressQuotable({ country_code: "   " })).toBe(false)
  })

  it("is case-insensitive about the country", () => {
    expect(isAddressQuotable({ country_code: "us", state_code: "ca" })).toBe(
      true
    )
  })
})

describe("buildRateItems", () => {
  it("builds items from variants carrying a catalog id", () => {
    const items = buildRateItems(
      [
        { variant_id: "var_1", quantity: 2, unit_price: 2500 },
        { variant_id: "var_2", quantity: 1, unit_price: 1000 },
      ],
      new Map([
        ["var_1", "4012"],
        ["var_2", "4013"],
      ])
    )
    expect(items).toEqual([
      { variant_id: 4012, quantity: 2, value: "25.00" },
      { variant_id: 4013, quantity: 1, value: "10.00" },
    ])
  })

  it("skips variants with no catalog id", () => {
    const items = buildRateItems(
      [
        { variant_id: "var_1", quantity: 1, unit_price: 500 },
        { variant_id: "var_other", quantity: 1, unit_price: 500 },
      ],
      new Map([["var_1", "4012"]])
    )
    expect(items).toHaveLength(1)
    expect(items[0].variant_id).toBe(4012)
  })

  it("returns an empty array when nothing is a Printful variant", () => {
    expect(
      buildRateItems([{ variant_id: "x", quantity: 1 }], new Map())
    ).toEqual([])
  })

  it("omits value when the unit price is unknown", () => {
    const items = buildRateItems(
      [{ variant_id: "var_1", quantity: 1 }],
      new Map([["var_1", "4012"]])
    )
    expect(items[0].value).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "isAddressQuotable is not a function"

- [ ] **Step 3: Implement**

Append to `src/utils/shipping-rates.ts`:

```typescript
/** Countries where Printful requires a state code alongside the country. */
const STATE_REQUIRED_COUNTRIES = new Set(["US", "AU", "CA"])

/**
 * Whether an address carries enough for Printful to quote.
 *
 * `calculatePrice` runs on every cart refresh, long before a shipping address
 * exists. Calling the API anyway means a 400 on every storefront visit, so an
 * incomplete address short-circuits to the fallback instead.
 */
export function isAddressQuotable(address: {
  country_code?: string
  state_code?: string
}): boolean {
  const country = (address.country_code ?? "").trim().toUpperCase()
  if (!country) {
    return false
  }
  if (STATE_REQUIRED_COUNTRIES.has(country)) {
    return Boolean((address.state_code ?? "").trim())
  }
  return true
}

export type CartLineForRates = {
  variant_id: string
  quantity: number
  /** Minor units, from the cart line item. */
  unit_price?: number
}

/**
 * Turn cart lines into Printful rate items.
 *
 * `catalogIdByVariantId` maps a Medusa variant id to the Printful *catalog*
 * variant id stored in variant metadata during sync. Lines whose variant has no
 * catalog id are skipped: that covers non-Printful products in a mixed store,
 * and Printful variants synced before the mapper recorded that id.
 */
export function buildRateItems(
  lines: CartLineForRates[],
  catalogIdByVariantId: Map<string, string>
): ShippingRateItem[] {
  const items: ShippingRateItem[] = []

  for (const line of lines) {
    const catalogId = catalogIdByVariantId.get(line.variant_id)
    if (!catalogId) {
      continue
    }
    const parsed = Number.parseInt(catalogId, 10)
    if (Number.isNaN(parsed)) {
      continue
    }

    items.push({
      variant_id: parsed,
      quantity: Number(line.quantity),
      ...(line.unit_price != null
        ? { value: (line.unit_price / 100).toFixed(2) }
        : {}),
    })
  }

  return items
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS, 8 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/shipping-rates.ts tests/shipping-rates.test.ts
git status --short
git commit -m "feat: address and item guards for rate requests

Refs #3"
```

---

## Task 7: Client method

**Files:**

- Modify: `src/utils/printful-client.ts`
- Modify: `tests/printful-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("PrintfulClient", ...)` block:

```typescript
it("requests shipping rates", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    jsonResponse({
      code: 200,
      result: [
        { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
      ],
    })
  )
  const client = new PrintfulClient({
    apiToken: "token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  })

  const rates = await client.getShippingRates({
    recipient: { country_code: "US", state_code: "CA", zip: "91311" },
    items: [{ variant_id: 4012, quantity: 1 }],
    currency: "USD",
  })

  expect(rates).toHaveLength(1)
  expect(rates[0].id).toBe("STANDARD")

  const [url, init] = fetchImpl.mock.calls[0]
  expect(String(url)).toContain("/shipping/rates")
  expect(init.method).toBe("POST")
  const body = JSON.parse(init.body as string)
  expect(body.recipient.country_code).toBe("US")
  expect(body.items[0].variant_id).toBe(4012)
  expect(body.currency).toBe("USD")
})

it("returns an empty list when the result is null", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse({ code: 200, result: null }))
  const client = new PrintfulClient({
    apiToken: "token",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries: 0,
  })

  await expect(
    client.getShippingRates({
      recipient: { country_code: "DE" },
      items: [{ variant_id: 1, quantity: 1 }],
    })
  ).resolves.toEqual([])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "client.getShippingRates is not a function"

- [ ] **Step 3: Implement**

Add to the `PrintfulClient` class in `src/utils/printful-client.ts`, after `disableWebhook`:

```typescript
  /**
   * Quote shipping for a cart. Returns every method Printful offers for that
   * destination in one response — the caller picks the one it needs.
   *
   * Setting `currency` asks Printful to convert the quote, so we never source
   * an exchange rate ourselves.
   */
  async getShippingRates(
    input: ShippingRatesRequest
  ): Promise<ShippingInfo[]> {
    const data = await this.request<ShippingInfo[]>("/shipping/rates", {
      method: "POST",
      body: JSON.stringify(input),
    })
    return data.result ?? []
  }
```

Add `ShippingInfo` and `ShippingRatesRequest` to the existing type-only import block at the top — do not create a second import statement.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS, 2 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/printful-client.ts tests/printful-client.test.ts
git status --short
git commit -m "feat: Printful shipping rates client method

Refs #3"
```

---

## Task 8: Provider wiring — container, options, canCalculate

**Files:**

- Modify: `src/providers/printful-fulfillment/service.ts`

This task only wires dependencies and flips `canCalculate`. `calculatePrice` comes next, so the provider stays working throughout.

- [ ] **Step 1: Verify the container keys before using them**

The provider receives a container with only an allowlist bridged in. Confirm what `query` resolves to when the store owner has NOT added `dependencies: ["query"]`, by reading
`node_modules/@medusajs/modules-sdk/dist/loaders/utils/load-internal.js` — look for where it registers dependencies with `allowUnregistered: true`.

Expected finding: an unbridged key resolves to `undefined` rather than throwing. If that is wrong — if it throws instead — report NEEDS_CONTEXT, because the constructor guard below depends on it.

- [ ] **Step 2: Extend the injected dependencies and constructor**

Replace the `InjectedDependencies` type and constructor in `src/providers/printful-fulfillment/service.ts`:

```typescript
type QueryLike = {
  graph: (input: {
    entity: string
    fields: string[]
    filters?: Record<string, unknown>
  }) => Promise<{ data: unknown }>
}

type CacheLike = {
  get: <T>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, ttl?: number) => Promise<void>
}

type InjectedDependencies = {
  logger: {
    info: (msg: string) => void
    error: (msg: string) => void
    warn: (msg: string) => void
    debug?: (msg: string) => void
  }
  /**
   * Bridged only when the store owner adds `dependencies: ["query"]` to the
   * fulfillment module. Unbridged keys resolve to undefined, never throw, so
   * this must be treated as optional at runtime regardless of the type.
   */
  query?: QueryLike
  /** Medusa registers the caching module under "caching", not "cache". */
  caching?: CacheLike
}
```

And in the constructor, after the existing `apiToken` warning:

```typescript
this.query_ = container.query
this.cache_ = container.caching

if (this.options_.liveShippingRates && !this.query_) {
  this.logger_.error(
    "Printful live shipping rates need variant metadata, which requires " +
      'adding dependencies: ["query"] to the @medusajs/medusa/fulfillment ' +
      "module in medusa-config.ts. Falling back to flat rates until then."
  )
}

if (this.options_.liveShippingRates && !this.options_.fallbackShippingRates) {
  this.logger_.error(
    "Printful live shipping rates are enabled without fallbackShippingRates. " +
      "A Printful outage will price shipping at zero."
  )
}
```

Add the fields to the class:

```typescript
  protected query_?: QueryLike
  protected cache_?: CacheLike
```

- [ ] **Step 3: Flip canCalculate**

Replace the existing `canCalculate`:

```typescript
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return Boolean(this.options_.liveShippingRates)
  }
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass. `calculatePrice` still throws at this point — that is fine, because `canCalculate` returns false unless the flag is on, and no test enables it yet.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/providers/printful-fulfillment/service.ts
git status --short
git commit -m "feat: wire query and cache into the fulfillment provider

Refs #3"
```

---

## Task 9: calculatePrice and the fallback chain

The heart of the release. Every path must return a number.

**Files:**

- Modify: `src/providers/printful-fulfillment/service.ts`
- Create: `tests/shipping-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/shipping-provider.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest"
import PrintfulFulfillmentProviderService from "../src/providers/printful-fulfillment/service"
import type { ShippingInfo } from "../src/utils/types"

const RATES: ShippingInfo[] = [
  { id: "STANDARD", name: "Flat Rate", rate: "4.99", currency: "USD" },
]

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
}

/** A query stub that reports every variant as Printful catalog variant 4012. */
function makeQuery() {
  return {
    graph: vi.fn().mockResolvedValue({
      data: [
        { id: "var_1", metadata: { printful_catalog_variant_id: "4012" } },
      ],
    }),
  }
}

function makeCache() {
  const store = new Map<string, unknown>()
  return {
    get: vi.fn(async (k: string) => (store.get(k) ?? null) as never),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v)
    }),
    _store: store,
  }
}

const CONTEXT = {
  id: "cart_1",
  currency_code: "usd",
  shipping_address: {
    country_code: "US",
    province: "California",
    city: "Chatsworth",
    postal_code: "91311",
    address_1: "19749 Dearborn St",
  },
  items: [{ variant: { id: "var_1" }, quantity: 1, unit_price: 2500 }],
} as never

function makeProvider(opts: {
  fetchImpl?: unknown
  query?: unknown
  cache?: unknown
  fallback?: Record<string, number>
}) {
  const logger = makeLogger()
  const service = new PrintfulFulfillmentProviderService(
    {
      logger,
      query: opts.query as never,
      caching: opts.cache as never,
    } as never,
    {
      apiToken: "token",
      liveShippingRates: true,
      fallbackShippingRates: opts.fallback ?? { STANDARD: 700 },
    } as never
  )
  if (opts.fetchImpl) {
    // Swap the whole client for a stub exposing only getShippingRates — the
    // only method calculatePrice uses. No real HTTP happens in these tests.
    ;(service as never as { client_: unknown }).client_ = {
      getShippingRates: opts.fetchImpl,
    }
  }
  return { service, logger }
}

describe("calculatePrice", () => {
  it("returns the live rate when Printful answers", async () => {
    const { service } = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(499)
    expect(result.is_calculated_price_tax_inclusive).toBe(false)
  })

  it("falls back to the flat rate when Printful is unreachable", async () => {
    const { service, logger } = makeProvider({
      fetchImpl: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(700)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("falls back when the requested method is not offered", async () => {
    const { service } = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
      fallback: { EXPRESS: 1500 },
    })

    const result = await service.calculatePrice(
      { id: "EXPRESS" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(1500)
  })

  it("never calls Printful when the address is incomplete", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      fetchImpl,
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      { ...(CONTEXT as object), shipping_address: {} } as never
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
  })

  it("never calls Printful when no line resolves to a Printful variant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(RATES)
    const { service } = makeProvider({
      fetchImpl,
      // Query answers, but the variant carries no catalog id.
      query: {
        graph: vi.fn().mockResolvedValue({
          data: [{ id: "var_1", metadata: {} }],
        }),
      },
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
  })

  it("falls back when query is unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(RATES)
    const { service, logger } = makeProvider({
      fetchImpl,
      query: undefined,
      cache: makeCache(),
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.calculated_amount).toBe(700)
    expect(logger.error).toHaveBeenCalled()
  })

  it("returns zero and logs an error when no fallback is configured", async () => {
    const logger = makeLogger()
    const service = new PrintfulFulfillmentProviderService(
      { logger } as never,
      { apiToken: "token", liveShippingRates: true } as never
    )

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(0)
    expect(logger.error).toHaveBeenCalled()
  })

  it("serves a second option from cache without a second API call", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue([
        ...RATES,
        { id: "EXPRESS", name: "Express", rate: "15.50", currency: "USD" },
      ])
    const { service } = makeProvider({
      fetchImpl,
      query: makeQuery(),
      cache: makeCache(),
    })

    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    await service.calculatePrice(
      { id: "EXPRESS" } as never,
      {} as never,
      CONTEXT
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("works without a cache module", async () => {
    const { service } = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: undefined,
    })

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    expect(result.calculated_amount).toBe(499)
  })

  it("prefers a stale quote over the flat rate", async () => {
    const cache = makeCache()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(RATES)
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))

    const { service } = makeProvider({
      fetchImpl,
      query: makeQuery(),
      cache,
    })

    // Populate the cache, then age the entry past the freshness window.
    await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )
    for (const [k, v] of cache._store) {
      cache._store.set(k, {
        ...(v as object),
        cached_at: Date.now() - 60 * 60 * 1000,
      })
    }

    const result = await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )

    // 499 from the stale quote, not 700 from the flat rate.
    expect(result.calculated_amount).toBe(499)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `calculatePrice` currently throws `MedusaError`.

- [ ] **Step 3: Implement**

Replace `calculatePrice` in `src/providers/printful-fulfillment/service.ts`:

```typescript
  /**
   * Price one shipping option.
   *
   * This method must never throw and must always return a `calculated_amount`.
   * Medusa blocks checkout when it does not, so every failure — Printful down,
   * method missing, currency unusable, config incomplete — resolves to a
   * fallback rather than an exception.
   */
  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceContext
  ): Promise<CalculatedShippingOptionPrice> {
    const methodId = String(
      (optionData as { id?: unknown } | undefined)?.id ?? ""
    )

    try {
      return await this.quote(methodId, context)
    } catch (err) {
      // A bug in our own code must not block a cart either.
      this.logger_.error(
        `Printful rate calculation failed unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return this.fallback(methodId, "printful_unreachable")
    }
  }

  private async quote(
    methodId: string,
    context: CalculateShippingOptionPriceContext
  ): Promise<CalculatedShippingOptionPrice> {
    const ctx = context as unknown as {
      currency_code?: string
      shipping_address?: {
        country_code?: string
        province?: string
        city?: string
        postal_code?: string
        address_1?: string
        address_2?: string
      }
      items?: Array<{
        variant?: { id?: string }
        quantity?: number
        unit_price?: number
      }>
    }

    if (!this.query_) {
      return this.fallback(methodId, "query_unavailable")
    }

    const addr = ctx.shipping_address ?? {}
    const countryCode = (addr.country_code ?? "").toUpperCase()
    const stateCode = resolveStateCode(addr.province, countryCode)

    if (!isAddressQuotable({ country_code: countryCode, state_code: stateCode })) {
      return this.fallback(methodId, "incomplete_address")
    }

    const lines = (ctx.items ?? [])
      .filter((i) => i.variant?.id)
      .map((i) => ({
        variant_id: i.variant!.id as string,
        quantity: Number(i.quantity ?? 1),
        unit_price: i.unit_price,
      }))

    const catalogIds = await this.catalogIdsFor(lines.map((l) => l.variant_id))
    const items = buildRateItems(lines, catalogIds)

    if (!items.length) {
      return this.fallback(methodId, "no_printful_items")
    }

    const currency = (ctx.currency_code ?? "").toUpperCase()
    const recipient = {
      country_code: countryCode,
      ...(stateCode ? { state_code: stateCode } : {}),
      ...(addr.city ? { city: addr.city } : {}),
      ...(addr.postal_code ? { zip: addr.postal_code } : {}),
      ...(addr.address_1 ? { address1: addr.address_1 } : {}),
      ...(addr.address_2 ? { address2: addr.address_2 } : {}),
    }

    const cacheKey = buildRateCacheKey({ address: recipient, items, currency })
    const freshnessMs =
      (this.options_.shippingRateCacheTtlSeconds ?? 600) * 1000
    const staleSeconds = this.options_.shippingRateStaleSeconds ?? 86400

    const cached = await this.readCache(cacheKey)
    if (cached && Date.now() - cached.cached_at < freshnessMs) {
      const hit = selectRate(cached.rates, methodId, currency)
      if (hit.ok) {
        return this.priced(hit.amount, methodId, "fresh_cache")
      }
    }

    let rates: ShippingInfo[]
    try {
      rates = await this.client_.getShippingRates({
        recipient,
        items,
        ...(currency ? { currency } : {}),
      })
    } catch (err) {
      this.logger_.warn(
        `Printful shipping rates unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return this.staleOrFlat(cached, methodId, currency, "printful_unreachable")
    }

    await this.writeCache(
      cacheKey,
      { rates, currency, cached_at: Date.now() },
      staleSeconds
    )

    const selected = selectRate(rates, methodId, currency)
    if (!selected.ok) {
      this.logger_.warn(
        `Printful rate for ${methodId} unusable (${selected.reason}); falling back`
      )
      return this.staleOrFlat(cached, methodId, currency, selected.reason)
    }

    return this.priced(selected.amount, methodId, "live")
  }

  /** Look up Printful catalog variant ids for a set of Medusa variant ids. */
  private async catalogIdsFor(
    variantIds: string[]
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (!this.query_ || !variantIds.length) {
      return map
    }

    const { data } = await this.query_.graph({
      entity: "product_variant",
      fields: ["id", "metadata"],
      filters: { id: variantIds },
    })

    for (const row of (data ?? []) as Array<{
      id: string
      metadata?: Record<string, unknown> | null
    }>) {
      const catalogId = row.metadata?.printful_catalog_variant_id
      if (catalogId != null && catalogId !== "") {
        map.set(row.id, String(catalogId))
      }
    }

    return map
  }

  private async readCache(key: string): Promise<CachedQuote | null> {
    if (!this.cache_) {
      return null
    }
    try {
      return await this.cache_.get<CachedQuote>(key)
    } catch {
      // A cache failure must not fail the quote.
      return null
    }
  }

  private async writeCache(
    key: string,
    value: CachedQuote,
    ttlSeconds: number
  ): Promise<void> {
    if (!this.cache_) {
      return
    }
    try {
      // TTL is the STALE window, not the freshness window: an aged entry must
      // survive so it can serve as a fallback.
      await this.cache_.set(key, value, ttlSeconds)
    } catch {
      // Non-fatal.
    }
  }

  private staleOrFlat(
    cached: CachedQuote | null,
    methodId: string,
    currency: string,
    reason: FallbackReason
  ): CalculatedShippingOptionPrice {
    if (cached) {
      const stale = selectRate(cached.rates, methodId, currency)
      if (stale.ok) {
        return this.priced(stale.amount, methodId, "stale_cache")
      }
    }
    return this.fallback(methodId, reason)
  }

  private fallback(
    methodId: string,
    reason: FallbackReason
  ): CalculatedShippingOptionPrice {
    const flat = this.options_.fallbackShippingRates?.[methodId]

    if (flat == null) {
      this.logger_.error(
        `No fallbackShippingRates entry for "${methodId}" — pricing shipping at ` +
          "zero. Add one for every method in the allowlist."
      )
      return this.priced(0, methodId, "misconfigured_zero")
    }

    if (reason === "incomplete_address" || reason === "no_printful_items") {
      this.logger_.debug?.(`Printful rates skipped: ${reason}`)
    } else if (reason === "query_unavailable") {
      this.logger_.error(
        'Printful live rates need dependencies: ["query"] on the fulfillment module'
      )
    } else {
      this.logger_.warn(`Printful rate fallback (${reason}) for ${methodId}`)
    }

    return this.priced(flat, methodId, "flat_fallback")
  }

  private priced(
    amount: number,
    methodId: string,
    source: RateSource
  ): CalculatedShippingOptionPrice {
    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: false,
    } as CalculatedShippingOptionPrice
  }
```

Add the imports at the top of the file:

```typescript
import { resolveStateCode } from "../../utils/mappers"
import {
  buildRateCacheKey,
  buildRateItems,
  isAddressQuotable,
  selectRate,
} from "../../utils/shipping-rates"
import type {
  CachedQuote,
  FallbackReason,
  RateSource,
  ShippingInfo,
} from "../../utils/types"
```

Add `CalculateShippingOptionPriceContext` to the existing type import from `@medusajs/framework/types`.

- [ ] **Step 4: Run and watch them pass**

Run: `npm test`
Expected: PASS, 10 new tests. If the `priced` helper's unused `methodId`/`source` parameters trip lint, keep them — Task 10 uses them.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/providers/printful-fulfillment/service.ts tests/shipping-provider.test.ts
git status --short
git commit -m "feat: live shipping rates with a fallback chain

Refs #3"
```

---

## Task 10: Record what was quoted, and honor it on the order

A quoted method Printful will not accept is worse than a wrong price: the customer paid for a service that does not exist.

**Files:**

- Modify: `src/providers/printful-fulfillment/service.ts`
- Modify: `src/workflows/create-printful-order.ts`
- Modify: `tests/shipping-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/shipping-provider.test.ts`:

```typescript
describe("rate provenance", () => {
  it("records the method and source on a live quote", async () => {
    const { service } = makeProvider({
      fetchImpl: vi.fn().mockResolvedValue(RATES),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = (await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )) as unknown as {
      data?: { printful_shipping?: string; rate_source?: string }
    }

    expect(result.data?.printful_shipping).toBe("STANDARD")
    expect(result.data?.rate_source).toBe("live")
  })

  it("marks a fallback so the order path can tell it apart", async () => {
    const { service } = makeProvider({
      fetchImpl: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
      query: makeQuery(),
      cache: makeCache(),
    })

    const result = (await service.calculatePrice(
      { id: "STANDARD" } as never,
      {} as never,
      CONTEXT
    )) as unknown as { data?: { rate_source?: string } }

    expect(result.data?.rate_source).toBe("flat_fallback")
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — `result.data` is undefined.

- [ ] **Step 3: Return the provenance**

Change `priced` in the provider:

```typescript
  private priced(
    amount: number,
    methodId: string,
    source: RateSource
  ): CalculatedShippingOptionPrice {
    return {
      calculated_amount: amount,
      is_calculated_price_tax_inclusive: false,
      // Carried onto the shipping method so order creation knows whether this
      // price came from a real Printful quote or from a fallback.
      data: { printful_shipping: methodId, rate_source: source },
    } as unknown as CalculatedShippingOptionPrice
  }
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test`
Expected: PASS, 2 new tests

- [ ] **Step 5: Pass the method through on order creation**

In `src/workflows/create-printful-order.ts`, the payload currently sets `external_id`, `recipient`, `items`, and `confirm`. Add the shipping method, taken from the order's shipping methods, but only when it came from a live quote:

```typescript
// Only insist on a shipping method we actually quoted. A fallback price was
// never confirmed by Printful, so let Printful choose its own default
// rather than requesting a method it may not offer.
const shippingMethod = (order.shipping_methods ?? []).find((m) => {
  const d = (m.data ?? {}) as Record<string, unknown>
  return d.rate_source === "live" && typeof d.printful_shipping === "string"
})
const quotedShipping = shippingMethod
  ? ((shippingMethod.data as Record<string, unknown>)
      .printful_shipping as string)
  : undefined

if (!quotedShipping && (order.shipping_methods ?? []).length) {
  logger.info(
    `Printful order ${order.id}: shipping priced from a fallback, letting ` +
      "Printful choose the method"
  )
}
```

Include it in the payload:

```typescript
const payload: PrintfulCreateOrderInput = {
  external_id: order.id,
  recipient,
  items,
  ...(quotedShipping ? { shipping: quotedShipping } : {}),
  confirm: options.autoSubmitOrders !== false,
}
```

The `order` retrieval must include shipping methods — extend the existing `relations` array to `["items", "shipping_address", "shipping_methods"]`. Resolve the logger from the container the same way `src/subscribers/payment-captured.ts` does.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass. `PrintfulCreateOrderInput` already has an optional `shipping` field — confirm in `src/utils/types.ts` before relying on it, and add it if absent.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/providers/printful-fulfillment/service.ts src/workflows/create-printful-order.ts tests/shipping-provider.test.ts
git status --short
git commit -m "feat: carry the quoted shipping method onto the order

Refs #3"
```

---

## Task 11: Fulfillment options from the allowlist

**Files:**

- Modify: `src/utils/shipping-rates.ts`
- Modify: `src/providers/printful-fulfillment/service.ts`
- Modify: `tests/shipping-rates.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/shipping-rates.test.ts`:

```typescript
import { PRINTFUL_SHIPPING_METHODS } from "../src/utils/shipping-rates"

describe("PRINTFUL_SHIPPING_METHODS", () => {
  it("uses Printful's own method ids", () => {
    // These must match ShippingInfo.id exactly — the same string is the Medusa
    // option id and the fallbackShippingRates key.
    expect(PRINTFUL_SHIPPING_METHODS).toContain("STANDARD")
  })

  it("does not use the invented ids from before 0.3.0", () => {
    expect(PRINTFUL_SHIPPING_METHODS).not.toContain("printful-standard")
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "PRINTFUL_SHIPPING_METHODS is not defined"

- [ ] **Step 3: Implement**

Add to `src/utils/shipping-rates.ts`:

```typescript
/**
 * Shipping methods we expose as fulfillment options.
 *
 * These are Printful's own `ShippingInfo.id` values, taken from a recorded
 * response — the OpenAPI spec publishes no enum, only the example `STANDARD`.
 * The same string serves as the Medusa option id and the fallbackShippingRates
 * key, so the three cannot drift apart.
 */
export const PRINTFUL_SHIPPING_METHODS = ["STANDARD"] as const
```

If Task 1 recorded a live response containing more ids, list those too.

Then replace `getFulfillmentOptions` in the provider:

```typescript
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      ...PRINTFUL_SHIPPING_METHODS.map((id) => ({
        id,
        name: `Printful ${id}`,
      })),
      {
        id: "PRINTFUL_RETURN",
        name: "Printful Return",
        is_return: true,
      },
    ]
  }
```

Import `PRINTFUL_SHIPPING_METHODS` from `../../utils/shipping-rates`.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/shipping-rates.ts src/providers/printful-fulfillment/service.ts tests/shipping-rates.test.ts
git status --short
git commit -m "feat: expose Printful method ids as fulfillment options

Refs #3"
```

---

## Task 12: Contract test against the fixture

**Files:**

- Modify: `tests/shipping-rates.test.ts`

- [ ] **Step 1: Write the test**

Append to `tests/shipping-rates.test.ts`:

```typescript
import { readFileSync } from "fs"
import { join } from "path"

describe("Printful rate response contract", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures/printful-shipping-rates.json"),
      "utf8"
    )
  ) as { result: ShippingInfo[] }

  it("still has the fields selectRate depends on", () => {
    expect(Array.isArray(fixture.result)).toBe(true)
    expect(fixture.result.length).toBeGreaterThan(0)

    for (const rate of fixture.result) {
      expect(typeof rate.id).toBe("string")
      expect(typeof rate.name).toBe("string")
      // A decimal string, never a number — parsing it as a float drifts.
      expect(typeof rate.rate).toBe("string")
      expect(typeof rate.currency).toBe("string")
    }
  })

  it("prices every method in the fixture without error", () => {
    for (const rate of fixture.result) {
      const result = selectRate(fixture.result, rate.id, rate.currency)
      expect(result.ok).toBe(true)
    }
  })

  it("covers every allowlisted method, or documents why not", () => {
    const fixtureIds = fixture.result.map((r) => r.id)
    for (const id of PRINTFUL_SHIPPING_METHODS) {
      // A method we advertise but that the recorded response never returned is
      // a method customers can select and we can never price live.
      expect(fixtureIds).toContain(id)
    }
  })
})
```

- [ ] **Step 2: Run it**

Run: `npm test`
Expected: PASS. If the last test fails, the allowlist advertises a method the fixture does not contain — fix the allowlist rather than the test, or record a fixture that includes it.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/shipping-rates.test.ts
git status --short
git commit -m "test: contract test for the Printful rate response

Refs #3"
```

---

## Task 13: Country matrix

**Files:**

- Modify: `tests/shipping-rates.test.ts`

- [ ] **Step 1: Write the test**

Append to `tests/shipping-rates.test.ts`:

```typescript
import { resolveStateCode } from "../src/utils/mappers"

describe("country matrix", () => {
  const cases: Array<{
    country: string
    province?: string
    expectState?: string
    quotable: boolean
  }> = [
    {
      country: "US",
      province: "California",
      expectState: "CA",
      quotable: true,
    },
    { country: "CA", province: "Ontario", expectState: "ON", quotable: true },
    {
      country: "AU",
      province: "New South Wales",
      expectState: "NSW",
      quotable: true,
    },
    {
      country: "DE",
      province: "Bavaria",
      expectState: undefined,
      quotable: true,
    },
    {
      country: "GB",
      province: "Greater London",
      expectState: undefined,
      quotable: true,
    },
    {
      country: "JP",
      province: "Tokyo",
      expectState: undefined,
      quotable: true,
    },
    // State-requiring countries without a resolvable province cannot be quoted.
    {
      country: "US",
      province: "Nowhere",
      expectState: undefined,
      quotable: false,
    },
    {
      country: "AU",
      province: undefined,
      expectState: undefined,
      quotable: false,
    },
  ]

  for (const c of cases) {
    it(`${c.country}${c.province ? ` / ${c.province}` : ""}`, () => {
      const state = resolveStateCode(c.province, c.country)
      expect(state).toBe(c.expectState)
      expect(
        isAddressQuotable({ country_code: c.country, state_code: state })
      ).toBe(c.quotable)
    })
  }
})
```

- [ ] **Step 2: Run it**

Run: `npm test`
Expected: PASS — Task 2 added the AU table, so the AU case resolves. If AU fails here, Task 2 was not completed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/shipping-rates.test.ts
git status --short
git commit -m "test: country matrix for shipping address handling

Refs #3"
```

---

## Task 14: Documentation and release

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Document setup in the README**

Add after the Webhooks section:

````markdown
## Live shipping rates

Printful quotes shipping for the destination and cart contents. Enable it with:

```ts
plugins: [
  {
    resolve: "@legenki/print2medusa",
    options: {
      apiToken: process.env.PRINTFUL_API_TOKEN,
      liveShippingRates: true,
      fallbackShippingRates: { STANDARD: 500 }, // minor units
    },
  },
],
modules: [
  {
    resolve: "@medusajs/medusa/fulfillment",
    // Required: the provider reads variant metadata through Query, and Medusa
    // only bridges modules a provider explicitly declares.
    dependencies: ["query"],
    options: {
      providers: [
        {
          resolve: "@legenki/print2medusa/providers/printful-fulfillment",
          id: "printful",
          options: { apiToken: process.env.PRINTFUL_API_TOKEN },
        },
      ],
    },
  },
],
```

**`dependencies: ["query"]` is not optional.** Without it the provider cannot
resolve Printful variant ids and every quote silently falls back to the flat
rate. The plugin logs an error at startup when this happens.

**`fallbackShippingRates` needs an entry for every method you offer.** A missing
entry prices that method at zero rather than blocking checkout — Medusa cannot
complete a cart whose shipping price fails to resolve, so a wrong price is the
lesser harm. The plugin logs an error each time it happens.

Rates are cached for 10 minutes (`shippingRateCacheTtlSeconds`) and retained for
24 hours (`shippingRateStaleSeconds`). A retained-but-stale quote is preferred
over the flat rate when Printful is unreachable — a real quote from yesterday
beats a constant.
````

- [ ] **Step 2: Update the CHANGELOG**

Add above the `0.2.0` section:

```markdown
## 0.3.0

Shipping is priced from Printful's live rates instead of by hand.

### Added

- Live shipping rates via `POST /shipping/rates`, behind the `liveShippingRates` option
- Rate caching through Medusa's caching module, with a stale tier that outranks the flat fallback
- Australian state codes in `resolveStateCode` — Printful requires `state_code` for AU, and quotes were going out without it
- The quoted method is recorded on the shipping method and passed to Printful at order creation, but only when it came from a live quote

### Changed

- **Breaking:** fulfillment option ids are now Printful's own method ids (`STANDARD`), replacing `printful-standard` and `printful-return`. Those ids matched nothing Printful returns. **Shipping options created against the old ids must be recreated.**
- Live rates require `dependencies: ["query"]` on the fulfillment module — see the README

### Fixed

- `calculatePrice` never throws. Medusa blocks checkout when it does, so a Printful outage no longer prevents customers from completing an order
```

- [ ] **Step 3: Bump the version**

In `package.json`, set `"version": "0.3.0"`.

- [ ] **Step 4: Update the roadmap**

In `ROADMAP.md`, change the `0.3.0` heading from `` `next` `` to `` `shipped` ``, mark `0.4.0` as `` `next` ``, and refresh the "Where we are" table with the new version, test count, and endpoint coverage.

- [ ] **Step 5: Full verification**

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run typecheck:tests
npm test
DATABASE_URL=postgres://andy@localhost:5432/print2medusa_test npm run test:integration
npm run build
```

Expected: format clean, lint 0 errors, both typechecks exit 0, all unit and integration tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json ROADMAP.md
git status --short
git commit -m "docs: release 0.3.0

Closes #3"
```

---

## Verification Checklist

- [ ] `npm run lint` reports 0 errors
- [ ] `npm run typecheck` and `npm run typecheck:tests` both exit 0
- [ ] `npm test` passes
- [ ] `npm run test:integration` passes against real Postgres
- [ ] `npm run format:check` is clean
- [ ] `npm run build` succeeds
- [ ] Printful unreachable → checkout still completes on a fallback rate
- [ ] A second shipping option on the same cart costs no extra API call
- [ ] A stale cached quote is preferred over the flat rate
- [ ] An AU address resolves its state code
- [ ] `dependencies: ["query"]` missing → error logged, flat rate used, checkout works
