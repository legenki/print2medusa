# Order Economics Implementation Plan (0.5.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store what Printful charged for each order on the Medusa order, and show the store owner their margin.

**Architecture:** Printful's `Order` object already carries `costs` (what the merchant pays) and `retail_costs` (what the customer pays), so no extra API call is needed — the response we already receive when creating an order, and re-read on every webhook, contains everything. A pure `src/utils/costs.ts` converts Printful's JSON floats into Medusa's integer minor units and computes margin; the create-order workflow and the webhook workflow both stamp the result onto order metadata; the existing order widget renders it.

**Tech Stack:** TypeScript, Medusa v2.18, Vitest, Printful API v1.

---

## Background the implementer needs

**Printful returns money as JSON numbers, Medusa stores integer minor units.**
A Printful order responds with `costs: { currency: "USD", subtotal: 10, shipping: 5, total: 15, ... }`. Those are floats — `12.34`, not `1234`. Medusa stores `1234`. Every value must be converted, and `12.34 * 100` is `1233.9999999999998` in IEEE-754, so conversion must round rather than truncate.

**This repo has been bitten by money parsing before.** In 0.3.0, review found `parseFloat` accepting `"-4.99"` and silently truncating `"4.99abc"` into `4.99`. The existing `parsePriceToMinorUnits` in `src/utils/mappers.ts` takes a `string` and is used for product retail prices; it is **not** suitable here (costs arrive as `number`, and it returns `0` for anything unparseable, which would silently report a fabricated margin of 100%). Write a separate, stricter converter.

**Two cost objects, two meanings.** `costs` is what Printful bills the merchant. `retail_costs` is what the merchant charges the customer, as Printful understands it. Margin is `retail_costs.total − costs.total`, but only when both are in the same currency.

**Currency may not match the Medusa order.** Printful may report USD while the Medusa order is in EUR. Converting between them requires an exchange rate this plugin does not have, and a margin computed from mismatched currencies is worse than no margin — it looks authoritative and is wrong. When currencies differ, store both figures with their currencies and refuse to compute a difference.

**`digitization` is typed `string` while every sibling field is `number`.** That is Printful's own inconsistency, confirmed in their OpenAPI spec. The converter must accept both.

**Existing patterns to follow:**

- Pure logic lives in `src/utils/` and is unit-tested without a container: see `order-state.ts`, `stock.ts`, `shipping-rates.ts`, `orphans.ts`.
- `planOrderStateActions(order, recordedShipmentIds)` in `src/utils/order-state.ts` returns `{ metadata, ... }`, and `apply-order-status.ts:153` merges `plan.metadata` into the order. Costs follow the same shape.
- The order widget at `src/admin/widgets/printful-order-widget.tsx` reads `data.metadata` directly. **No new API route is needed.**

---

## File Structure

| File                                                               | Responsibility                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `src/utils/costs.ts` (create)                                      | Pure conversion of Printful cost objects to minor units; margin computation; metadata key constants |
| `tests/costs.test.ts` (create)                                     | Unit + property-based tests for conversion and margin                                               |
| `src/utils/types.ts` (modify)                                      | `PrintfulCosts` / `PrintfulRetailCosts` types; add `costs`/`retail_costs` to `PrintfulOrder`        |
| `src/utils/order-state.ts` (modify)                                | Include cost metadata in the plan so webhooks refresh it                                            |
| `src/workflows/create-printful-order.ts` (modify)                  | Stamp costs onto Medusa order metadata at creation                                                  |
| `src/admin/widgets/printful-order-widget.tsx` (modify)             | Render cost breakdown and margin                                                                    |
| `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `package.json` (modify) | Release 0.5.0                                                                                       |

---

### Task 1: Cost types

**Files:**

- Modify: `src/utils/types.ts`

- [ ] **Step 1: Add the two cost types**

Add near `PrintfulOrder` (around line 118):

```typescript
/**
 * What Printful bills the merchant. Values are JSON numbers (major units,
 * e.g. 12.34), except `digitization`, which Printful types as a string.
 */
export type PrintfulCosts = {
  currency?: string
  subtotal?: number
  discount?: number
  shipping?: number
  digitization?: string | number
  additional_fee?: number
  fulfillment_fee?: number
  retail_delivery_fee?: number
  tax?: number
  vat?: number
  total?: number
}

/** What the merchant charges the customer, as Printful understands it. */
export type PrintfulRetailCosts = {
  currency?: string
  subtotal?: number
  discount?: number
  shipping?: number
  tax?: number
  vat?: number
  total?: number
}
```

- [ ] **Step 2: Reference them from `PrintfulOrder`**

In the `PrintfulOrder` type (starts line 118), add after `updated?: number`:

```typescript
  costs?: PrintfulCosts
  retail_costs?: PrintfulRetailCosts
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add src/utils/types.ts
git commit -m "feat: types for Printful order costs"
```

---

### Task 2: Money conversion

**Files:**

- Create: `src/utils/costs.ts`
- Create: `tests/costs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/costs.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { toMinorUnits } from "../src/utils/costs"

describe("toMinorUnits", () => {
  it("converts a plain amount", () => {
    expect(toMinorUnits(12.34)).toBe(1234)
  })

  it("rounds rather than truncating the float representation", () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE-754. Truncating gives 1233 —
    // a cent lost on a value the merchant can see in Printful's dashboard.
    expect(toMinorUnits(12.34)).toBe(1234)
    // 0.07 * 100 is 7.000000000000001; 0.29 * 100 is 28.999999999999996.
    // Truncation turns the second into 28 — a real cent, lost.
    expect(toMinorUnits(0.07)).toBe(7)
    expect(toMinorUnits(0.29)).toBe(29)
    expect(toMinorUnits(4.99)).toBe(499)
  })

  it("rounds a half-cent down when the float lands below it", () => {
    // Deliberately pinning actual behaviour, not the arithmetic ideal:
    // 1.005 * 100 is 100.49999999999999, so Math.round gives 100, not 101.
    // Printful only ever sends two-decimal amounts, so this input cannot
    // arise from a real cost — the assertion exists so that anyone changing
    // the converter sees exactly which edge they are moving.
    expect(toMinorUnits(1.005)).toBe(100)
  })

  it("accepts the string Printful uses for digitization", () => {
    expect(toMinorUnits("2.50")).toBe(250)
    expect(toMinorUnits("0")).toBe(0)
  })

  it("treats a missing value as zero", () => {
    expect(toMinorUnits(undefined)).toBe(0)
    expect(toMinorUnits(null)).toBe(0)
    expect(toMinorUnits("")).toBe(0)
  })

  it("rejects a value it cannot trust rather than reporting zero", () => {
    // Returning 0 here would silently claim a cost of nothing, which reads as
    // 100% margin. Undefined forces the caller to omit the field instead.
    expect(toMinorUnits("abc")).toBeUndefined()
    expect(toMinorUnits("4.99abc")).toBeUndefined()
    expect(toMinorUnits(Number.NaN)).toBeUndefined()
    expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(toMinorUnits({} as never)).toBeUndefined()
  })

  it("accepts a negative amount, because a discount is legitimately negative", () => {
    expect(toMinorUnits(-4.99)).toBe(-499)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/costs.test.ts`
Expected: FAIL — `Failed to resolve import "../src/utils/costs"`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/costs.ts`:

```typescript
/**
 * Printful reports money as JSON numbers in major units (12.34), and Medusa
 * stores integer minor units (1234). Everything crossing that boundary goes
 * through here.
 *
 * `undefined` means "we could not trust this value" and is deliberately
 * distinct from `0`. Reporting an unparseable cost as zero would show the
 * owner a 100% margin on an order that in fact cost them money.
 */
export function toMinorUnits(
  value: string | number | null | undefined
): number | undefined {
  if (value === null || value === undefined || value === "") {
    return 0
  }

  let n: number
  if (typeof value === "number") {
    n = value
  } else if (typeof value === "string") {
    // Number() rejects trailing garbage that parseFloat would silently accept:
    // Number("4.99abc") is NaN, parseFloat("4.99abc") is 4.99.
    n = Number(value)
  } else {
    return undefined
  }

  if (!Number.isFinite(n)) {
    return undefined
  }

  return Math.round(n * 100)
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/costs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/costs.ts tests/costs.test.ts
git commit -m "feat: convert Printful money to minor units"
```

---

### Task 3: Property-based rounding test

The roadmap promises "no float drift across 1000 generated amounts". This is that test. No new library — a seeded loop keeps it deterministic.

**Files:**

- Modify: `tests/costs.test.ts`

- [ ] **Step 1: Add the property test**

Append to `tests/costs.test.ts`:

```typescript
describe("toMinorUnits rounding properties", () => {
  it("never drifts from the exact cent across 1000 amounts", () => {
    // A deterministic sweep of two-decimal amounts. Every one of these is a
    // price a real order could carry, and each has an unambiguous correct
    // answer in cents, so any float drift shows up as an exact mismatch.
    const failures: string[] = []
    for (let cents = 0; cents < 1000; cents++) {
      const major = cents / 100
      const got = toMinorUnits(major)
      if (got !== cents) {
        failures.push(`${major} -> ${got}, expected ${cents}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("agrees between the number and string forms of the same amount", () => {
    // digitization arrives as a string and its siblings as numbers. If the two
    // paths disagreed, one field of a cost breakdown would be off by a cent.
    const failures: string[] = []
    for (let cents = 0; cents < 1000; cents++) {
      const major = cents / 100
      const asNumber = toMinorUnits(major)
      const asString = toMinorUnits(major.toFixed(2))
      if (asNumber !== asString) {
        failures.push(`${major}: number=${asNumber} string=${asString}`)
      }
    }
    expect(failures).toEqual([])
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/costs.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 3: Prove the test is a real guard**

Temporarily change `Math.round(n * 100)` to `Math.trunc(n * 100)` in `src/utils/costs.ts`.

Run: `npx vitest run tests/costs.test.ts`
Expected: FAIL — the sweep reports **69** mismatches across the 1000 amounts, the first being `0.29 -> 28, expected 29`. (Verified: 69 of the 1000 two-decimal amounts land just below their cent in IEEE-754.)

Revert to `Math.round`. Re-run: PASS. **Report both outputs.**

- [ ] **Step 4: Commit**

```bash
git add tests/costs.test.ts
git commit -m "test: rounding holds across 1000 generated amounts"
```

---

### Task 4: Cost plan and margin

**Files:**

- Modify: `src/utils/costs.ts`
- Modify: `tests/costs.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/costs.test.ts` (extend the existing import to include `planCostMetadata` and the key constants):

```typescript
import {
  COST_CURRENCY_KEY,
  COST_TOTAL_KEY,
  MARGIN_KEY,
  RETAIL_TOTAL_KEY,
  planCostMetadata,
  toMinorUnits,
} from "../src/utils/costs"
import type { PrintfulOrder } from "../src/utils/types"

const order = (
  costs: Record<string, unknown>,
  retail?: Record<string, unknown>
): PrintfulOrder =>
  ({
    id: 1,
    status: "fulfilled",
    costs,
    ...(retail ? { retail_costs: retail } : {}),
  }) as PrintfulOrder

describe("planCostMetadata", () => {
  it("stores the cost breakdown in minor units", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", subtotal: 10, shipping: 5, total: 15 })
    )
    expect(meta[COST_TOTAL_KEY]).toBe(1500)
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
  })

  it("computes margin as retail minus cost when currencies agree", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", total: 15 }, { currency: "USD", total: 25 })
    )
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[MARGIN_KEY]).toBe(1000)
  })

  it("refuses to compute margin across different currencies", () => {
    // Subtracting USD from EUR produces a number that looks authoritative and
    // is meaningless. Both totals are still stored, each with its currency.
    const meta = planCostMetadata(
      order({ currency: "USD", total: 15 }, { currency: "EUR", total: 25 })
    )
    expect(meta[COST_TOTAL_KEY]).toBe(1500)
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[MARGIN_KEY]).toBeUndefined()
  })

  it("omits margin when retail costs are absent", () => {
    const meta = planCostMetadata(order({ currency: "USD", total: 15 }))
    expect(meta[MARGIN_KEY]).toBeUndefined()
  })

  it("returns nothing at all when the order carries no costs", () => {
    const meta = planCostMetadata({ id: 1, status: "draft" } as PrintfulOrder)
    expect(meta).toEqual({})
  })

  it("omits a field it could not parse rather than storing zero", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", total: "not-a-number" })
    )
    expect(meta[COST_TOTAL_KEY]).toBeUndefined()
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
  })

  it("reads digitization even though Printful types it as a string", () => {
    const meta = planCostMetadata(
      order({ currency: "USD", digitization: "2.50", total: 15 })
    )
    expect(meta["printful_cost_digitization"]).toBe(250)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/costs.test.ts`
Expected: FAIL — `planCostMetadata is not a function`.

- [ ] **Step 3: Implement**

Append to `src/utils/costs.ts`:

```typescript
import type { PrintfulOrder } from "./types"

export const COST_CURRENCY_KEY = "printful_cost_currency"
export const COST_TOTAL_KEY = "printful_cost_total"
export const RETAIL_CURRENCY_KEY = "printful_retail_currency"
export const RETAIL_TOTAL_KEY = "printful_retail_total"
export const MARGIN_KEY = "printful_margin"

/** Cost fields copied verbatim, minus `currency` and `total` which are special. */
const COST_FIELDS = [
  "subtotal",
  "discount",
  "shipping",
  "digitization",
  "additional_fee",
  "fulfillment_fee",
  "retail_delivery_fee",
  "tax",
  "vat",
] as const

/**
 * Build the order-metadata patch describing what an order cost and what it
 * earned. Shaped like `planOrderStateActions` so the webhook workflow can
 * merge it the same way.
 *
 * Every amount is in minor units. A field that could not be parsed is omitted
 * rather than defaulted, so a partial Printful response never turns into a
 * confidently wrong margin.
 */
export function planCostMetadata(
  order: PrintfulOrder
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const costs = order.costs
  const retail = order.retail_costs

  if (!costs && !retail) {
    return metadata
  }

  const costCurrency = costs?.currency?.toLowerCase()
  const retailCurrency = retail?.currency?.toLowerCase()

  if (costs) {
    if (costCurrency) {
      metadata[COST_CURRENCY_KEY] = costCurrency
    }
    const total = toMinorUnits(costs.total)
    if (total !== undefined) {
      metadata[COST_TOTAL_KEY] = total
    }
    for (const field of COST_FIELDS) {
      const value = toMinorUnits(costs[field])
      if (value !== undefined && value !== 0) {
        metadata[`printful_cost_${field}`] = value
      }
    }
  }

  if (retail) {
    if (retailCurrency) {
      metadata[RETAIL_CURRENCY_KEY] = retailCurrency
    }
    const total = toMinorUnits(retail.total)
    if (total !== undefined) {
      metadata[RETAIL_TOTAL_KEY] = total
    }
  }

  // Margin only where the subtraction is meaningful. Converting between
  // currencies would need an exchange rate this plugin does not have, and a
  // margin built on a guessed rate is worse than no margin at all.
  const costTotal = metadata[COST_TOTAL_KEY]
  const retailTotal = metadata[RETAIL_TOTAL_KEY]
  if (
    typeof costTotal === "number" &&
    typeof retailTotal === "number" &&
    costCurrency &&
    retailCurrency &&
    costCurrency === retailCurrency
  ) {
    metadata[MARGIN_KEY] = retailTotal - costTotal
  }

  return metadata
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/costs.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Prove the currency guard is real**

Temporarily delete the `costCurrency === retailCurrency` condition from the `if`.

Run: `npx vitest run tests/costs.test.ts`
Expected: FAIL — "refuses to compute margin across different currencies" now gets `1000`.

Restore it. Re-run: PASS. **Report both outputs.**

- [ ] **Step 6: Commit**

```bash
git add src/utils/costs.ts tests/costs.test.ts
git commit -m "feat: plan cost metadata and margin"
```

---

### Task 5: Stamp costs at order creation

**Files:**

- Modify: `src/workflows/create-printful-order.ts:143-156`

- [ ] **Step 1: Read the surrounding code**

Open `src/workflows/create-printful-order.ts`. Note that after `client.createOrder(payload)` at line 143 the step updates **its own link table** but never writes Medusa order metadata. Costs go on the Medusa order, so this adds that write.

- [ ] **Step 2: Add the imports**

The file already imports `Modules` (line 7) and already resolves `orderModule` inside the step (line 37), so reuse that resolve rather than adding a second one. Add the planner import after the `resolveStateCode` import (line 15):

```typescript
import { planCostMetadata } from "../utils/costs"
```

The step does **not** currently resolve a logger, so widen the existing `@medusajs/framework/utils` import on line 7:

```typescript
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
```

and add this beside the other resolves at the top of the step (after line 37):

```typescript
const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
```

Resolve through `ContainerRegistrationKeys.LOGGER`, never the string `"logger"` — the repo's lint rule warns on the magic string.

- [ ] **Step 3: Write the metadata after the link update**

Insert immediately after the `updatePrintfulOrderLinks` call (currently ending line 156):

```typescript
// Printful returns the real costs with the created order, so no separate
// estimate call is needed. Written best-effort: the order exists in
// Printful either way, and losing the margin figure must never fail the
// workflow and trigger a rollback of a real order.
const costMetadata = planCostMetadata(pfOrder)
if (Object.keys(costMetadata).length > 0) {
  try {
    // `orderModule` is the one resolved at the top of the step, and
    // `input.order_id` is the Medusa order. Note the local name
    // `existing` is already taken by the order-link lookup at line 41,
    // so this uses `orderRow`.
    const orderRow = await orderModule.retrieveOrder(input.order_id, {
      select: ["id", "metadata"],
    })
    await orderModule.updateOrders(input.order_id, {
      metadata: { ...(orderRow.metadata ?? {}), ...costMetadata },
    })
  } catch (err) {
    logger.error(
      `Printful order ${pfOrder.id}: could not store costs: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
```

If the step does not already resolve a `logger`, add near the other resolves at the top of the step:

```typescript
const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
```

and add `ContainerRegistrationKeys` to the `@medusajs/framework/utils` import.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: all existing tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/create-printful-order.ts
git commit -m "feat: store Printful costs on the order at creation"
```

---

### Task 6: Refresh costs from webhooks

Costs change after creation — Printful confirms shipping and fees when the order is fulfilled. The webhook path already re-reads the order, so it should refresh the figures.

**Files:**

- Modify: `src/utils/order-state.ts`
- Modify: `tests/order-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/order-state.test.ts`:

```typescript
describe("planOrderStateActions costs", () => {
  it("includes cost metadata so a webhook refreshes the margin", () => {
    // Printful finalizes shipping and fees at fulfillment, so the figures
    // stamped at creation are provisional. Re-reading the order is the only
    // moment we learn the real ones.
    const plan = planOrderStateActions(
      {
        id: 1,
        status: "fulfilled",
        costs: { currency: "USD", total: 15 },
        retail_costs: { currency: "USD", total: 25 },
      } as never,
      []
    )
    expect(plan.metadata.printful_cost_total).toBe(1500)
    expect(plan.metadata.printful_margin).toBe(1000)
  })

  it("leaves cost keys out when the order carries no costs", () => {
    const plan = planOrderStateActions(
      { id: 1, status: "pending" } as never,
      []
    )
    expect(plan.metadata.printful_cost_total).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/order-state.test.ts`
Expected: FAIL — `printful_cost_total` is `undefined`.

- [ ] **Step 3: Merge cost metadata into the plan**

In `src/utils/order-state.ts`, add the import:

```typescript
import { planCostMetadata } from "./costs"
```

The function returns an object literal (`return { shipments: …, metadata: { … } }`, currently at line 68). Spread the cost keys into that `metadata` literal as its **first** entry, so an unexpected key collision would be overwritten by the status keys rather than overwriting them:

```typescript
    metadata: {
      ...planCostMetadata(order),
      printful_order_id: String(order.id),
      printful_status: order.status,
      // …existing keys unchanged…
    },
```

Do not use `Object.assign` — there is no mutable `metadata` variable to assign to.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/utils/order-state.ts tests/order-state.test.ts
git commit -m "feat: refresh costs when a webhook re-reads the order"
```

---

### Task 7: Show margin in the order widget

**Files:**

- Modify: `src/admin/widgets/printful-order-widget.tsx`

- [ ] **Step 1: Read the widget**

Open the file. It reads `data.metadata` into a `metadata` record at the top and returns `null` when `printful_order_id` is absent. Add the cost section inside the existing `Container`, below the shipments list.

- [ ] **Step 2: Add a formatter and the section**

Add above the component:

```typescript
/** Minor units to a display string. 1500 with "usd" becomes "15.00 USD". */
const formatMinor = (amount: unknown, currency: unknown): string | null => {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return null
  }
  const code = typeof currency === "string" ? currency.toUpperCase() : ""
  return `${(amount / 100).toFixed(2)}${code ? ` ${code}` : ""}`
}
```

Inside the component, before the return, read the values:

```typescript
const costTotal = formatMinor(
  metadata.printful_cost_total,
  metadata.printful_cost_currency
)
const retailTotal = formatMinor(
  metadata.printful_retail_total,
  metadata.printful_retail_currency
)
const margin = formatMinor(
  metadata.printful_margin,
  metadata.printful_cost_currency
)
const currencyMismatch =
  costTotal !== null &&
  retailTotal !== null &&
  margin === null &&
  metadata.printful_cost_currency !== metadata.printful_retail_currency
```

Then render, inside the `Container` after the shipments:

The `Container` uses `divide-y` (line 39) with each section as a sibling `div` styled `px-6 py-4`, so the new block must follow that shape to get its own divider. Add it as the last child before `</Container>` (line 106):

```tsx
{
  costTotal && (
    <div className="px-6 py-4 flex flex-col gap-2">
      <Text size="small" weight="plus">
        Economics
      </Text>
      <Text size="small" className="text-ui-fg-subtle">
        Printful cost: {costTotal}
      </Text>
      {retailTotal && (
        <Text size="small" className="text-ui-fg-subtle">
          Retail: {retailTotal}
        </Text>
      )}
      {margin && <Text size="small">Margin: {margin}</Text>}
      {currencyMismatch && (
        <Text size="small" className="text-ui-fg-subtle">
          Margin unavailable — Printful billed in a different currency than the
          order.
        </Text>
      )}
    </div>
  )
}
```

`Heading` is reserved for the widget title at level `h2`, so this section uses a `weight="plus"` `Text` as its label instead.

- [ ] **Step 3: Verify the widget compiles**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; build reports both "completed successfully" lines. The build compiles admin extensions, so a widget error fails here.

- [ ] **Step 4: Commit**

```bash
git add src/admin/widgets/printful-order-widget.tsx
git commit -m "feat: show cost and margin on the order page"
```

---

### Task 8: Multi-currency integration check

**Files:**

- Modify: `tests/costs.test.ts`

- [ ] **Step 1: Add the end-to-end shape test**

The roadmap promises "an EUR order against USD Printful pricing". Append:

```typescript
describe("EUR order against USD Printful pricing", () => {
  it("keeps both totals and withholds the margin", () => {
    // The realistic mismatch: a European store selling in EUR while Printful
    // bills the merchant in USD. Both numbers are real and worth storing; the
    // difference between them is not a number anyone should act on.
    const meta = planCostMetadata(
      order(
        { currency: "USD", subtotal: 10, shipping: 4.99, total: 14.99 },
        { currency: "EUR", subtotal: 20, shipping: 5, total: 25 }
      )
    )

    expect(meta[COST_TOTAL_KEY]).toBe(1499)
    expect(meta[COST_CURRENCY_KEY]).toBe("usd")
    expect(meta[RETAIL_TOTAL_KEY]).toBe(2500)
    expect(meta[RETAIL_CURRENCY_KEY]).toBe("eur")
    expect(meta[MARGIN_KEY]).toBeUndefined()
    // 4.99 is the value that truncation would have turned into 498.
    expect(meta["printful_cost_shipping"]).toBe(499)
  })
})
```

Extend the import at the top of the file to include `RETAIL_CURRENCY_KEY`.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/costs.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/costs.test.ts
git commit -m "test: EUR order against USD Printful pricing"
```

---

### Task 9: Docs and release 0.5.0

**Files:**

- Modify: `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `package.json`

- [ ] **Step 1: Add a README section**

Insert before `## Admin usage`:

```markdown
## Order economics

Printful returns what it charged with the created order, so the plugin stores
it on the Medusa order rather than making a second API call. The order page
shows the Printful cost, the retail total, and the margin between them. The
figures are refreshed whenever a webhook re-reads the order, because Printful
finalizes shipping and fees at fulfillment.

All amounts are stored in minor units under `printful_cost_*`,
`printful_retail_*` and `printful_margin` in order metadata.

**Margin is only shown when both figures are in the same currency.** If
Printful bills in USD while the order is in EUR, both totals are stored and the
margin is withheld — converting would need an exchange rate this plugin does
not have, and a margin built on a guessed rate is worse than none.
```

- [ ] **Step 2: Add the CHANGELOG entry**

Insert directly below `# Changelog`:

```markdown
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
- **Returns are not implemented.** Printful API v1 has no endpoint for creating
  a return or generating a return label — only a `package_returned` webhook
  reporting one that already happened. `createReturnFulfillment` therefore
  remains a stub. Real returns need API v2 and are deferred to 1.0.0.
- **No tax provider.** `/tax/rates` exists in Printful API v1, but its request
  and response contract is undocumented, so `ITaxProvider` is deferred until
  the contract can be established against the live API.
```

- [ ] **Step 3: Update the ROADMAP**

- Change the published version row to `0.5.0`.
- Change `## 0.5.0 — Returns, taxes, and cost` to `## 0.5.0 — Order economics \`shipped\``.
- Under it, replace the scope list with what actually shipped, and add a line recording that returns and taxes moved out, with the reason (v1 has no returns API; the tax contract is undocumented).
- Mark `## 1.0.0` as `next`, and add returns to its scope — it is already the API v2 release.

- [ ] **Step 4: Bump the version**

```bash
npm version 0.5.0 --no-git-tag-version
```

- [ ] **Step 5: Full verification**

```bash
npm run format
npm run format:check
npm test
npm run typecheck
npm run typecheck:tests
npm run lint
npm run build
```

Expected: Prettier clean; all unit tests pass; both typechecks silent; lint **0 errors**; build reports two "completed successfully" lines.

Also run the integration suite:

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DATABASE_URL=postgres://andy@localhost:5432/print2medusa_test npm run test:integration
```

Expected: 21 tests pass (unchanged — this release adds no integration tests).

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md ROADMAP.md package.json package-lock.json
git status --short
git commit -m "docs: release 0.5.0"
```

**Never `git add -A`** — an earlier commit in this repo swept in 89,000 `node_modules` files. Stage only the paths listed.

---

## Out of scope, and why

- **Returns.** Printful API v1 has no returns endpoint — verified against their OpenAPI spec (zero paths matching `return`) and their published docs. Deferred to 1.0.0 with API v2.
- **Tax provider.** `/tax/rates` and `/tax/countries` exist, but their schemas are empty in the OpenAPI spec and the docs do not describe the fields. Implementing `ITaxProvider` against an unknown contract risks charging customers the wrong tax. Needs a live-API investigation first.
- **`/orders/estimate-costs`.** Not needed: the created order already carries `costs`, and using the real figure avoids a second call and any estimate-versus-actual drift.
- **`/reports/statistics` and a dedicated admin page.** Independent subsystem; belongs in its own release.
