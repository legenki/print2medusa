# Queued Sync and Stock Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the catalog sync in the background, make a concurrent sync impossible, roll back cleanly on failure, and stop selling products Printful has run out of.

**Architecture:** The route claims the sync through a Postgres partial unique index — at most one `running` log row can exist — then starts a background step and answers `202`. The step walks the catalog, heartbeats, and records products it created but has not yet linked, so its compensation deletes only those orphans. Stock comes from `availability_status`, which the sync already fetches and currently discards.

**Tech Stack:** Medusa v2.18 (workflows-sdk with `async`/`backgroundExecution`, MedusaService, product module), TypeScript, Vitest, Postgres 16.

**Spec:** `docs/superpowers/specs/2026-08-02-queued-sync-and-stock-design.md`
**Issue:** [#4](https://github.com/legenki/print2medusa/issues/4)

---

## Repo conventions

- **Stage explicitly.** `git status --short` before every commit; stage by path. Never `git add -A` — an earlier commit here swept in 89,000 files.
- **Prettier is enforced.** `npm run format` before committing, or CI fails on `format:check`.
- **Both typechecks must pass.** `npm run typecheck` covers `src/`, `npm run typecheck:tests` covers `tests/`. A test file can pass `npm test` while failing the second.
- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement.
- **Verify Medusa APIs against `node_modules`.** Several defects in earlier releases came from plan text asserting APIs that behaved differently — including one where a `data` field was silently discarded, making a whole task dead code.
- **Postgres is available:** `postgresql@16` on `localhost:5432`, database `print2medusa_test`, user `andy`, no password. Add `/opt/homebrew/opt/postgresql@16/bin` to PATH.

## File Structure

**Create:**

| File                                                         | Responsibility                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `src/utils/stock.ts`                                         | Pure logic: map `availability_status` to publish/unpublish intent |
| `tests/stock.test.ts`                                        | Unit tests for the above                                          |
| `src/modules/printful/migrations/Migration20260802000000.ts` | Heartbeat/progress columns and the one-running index              |
| `tests/sync-claim.integration.test.ts`                       | Claim race against real Postgres                                  |

**Modify:**

| File                                               | Change                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/utils/types.ts`                               | Stock types, `syncStaleMinutes`, `syncStepTimeoutSeconds`, `onDiscontinued` |
| `src/modules/printful/models/printful-sync-log.ts` | `heartbeat_at`, `products_processed`, `products_total`                      |
| `src/modules/printful/service.ts`                  | `claimSyncLog`, `reapStaleSyncLogs`, `heartbeatSyncLog`                     |
| `src/utils/mappers.ts`                             | Stop hardcoding `status: "published"`                                       |
| `src/workflows/sync-products.ts`                   | Background step, compensation, stock handling                               |
| `src/api/admin/printful/sync/route.ts`             | Claim, then `202` or `409`                                                  |
| `src/jobs/sync-products.ts`                        | Same claim; quiet skip on conflict                                          |
| `src/admin/widgets/printful-sync-widget.tsx`       | Poll progress, disable while running                                        |

Pure logic lives in `src/utils/` so it tests without a Medusa container, matching `order-state.ts` and `shipping-rates.ts`.

---

## Task 1: Confirm the step timeout before building on it

The spec flags this as the one assumption that must not be guessed. Medusa's `timeout` is documented as _not_ an execution timeout: the step runs to completion regardless, but if it exceeds the window it is marked `TIMEOUT` and **the workflow is reverted** — which would run our compensation and delete orphans the sync was about to link.

**Files:** none yet — this task produces a finding.

- [ ] **Step 1: Find the default**

Read `node_modules/@medusajs/orchestration/dist/transaction/` and find where `timeout` is applied when a step does not set one. Determine:

- What the default is (a number of seconds, or none)
- What happens on `async: true` + `backgroundExecution: true` specifically — does the timeout still apply?
- Whether a step can opt out of the timeout entirely

- [ ] **Step 2: Record the finding in the spec**

Edit `docs/superpowers/specs/2026-08-02-queued-sync-and-stock-design.md`, in the section "The step timeout is not a detail to leave defaulted". Replace the sentence beginning "The first implementation task confirms" with what you actually found, and state the value the implementation will use.

If no timeout can be set high enough for a large catalog, say so plainly — that changes the design and is worth stopping for.

- [ ] **Step 3: Commit**

```bash
npm run format
git add docs/superpowers/specs/2026-08-02-queued-sync-and-stock-design.md
git status --short
git commit -m "docs: record Medusa's step timeout behavior

Refs #4"
```

---

## Task 2: Stock types

**Files:** modify `src/utils/types.ts`

No test; `npm run typecheck` is the check.

- [ ] **Step 1: Add the types**

```typescript
/**
 * Printful's per-variant availability. Confirmed against the v1 OpenAPI spec —
 * underscores, not hyphens.
 */
export type PrintfulAvailabilityStatus =
  "active" | "discontinued" | "out_of_stock" | "temporary_out_of_stock"

/** What a product's stock state means for its Medusa publication. */
export type StockPlan = {
  /** The status the product should have, subject to the marker rules. */
  status: "published" | "draft"
  /** True when every variant is unavailable. */
  allUnavailable: boolean
  /** True when any variant reports `discontinued`. */
  hasDiscontinued: boolean
  /** Availability per Printful sync variant id, for variant metadata. */
  variantAvailability: Record<string, string>
}
```

- [ ] **Step 2: Add the plugin options**

Add to `PrintfulPluginOptions`:

```typescript
  /** Minutes before a running sync claim is presumed abandoned. Default 60. */
  syncStaleMinutes?: number
  /** Timeout for the background sync step, in seconds. */
  syncStepTimeoutSeconds?: number
  /** What to do with variants Printful reports as discontinued. Default "flag". */
  onDiscontinued?: "flag" | "ignore"
```

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck
npm run format
git add src/utils/types.ts
git status --short
git commit -m "feat: types for stock awareness and sync claiming

Refs #4"
```

---

## Task 3: `planStockActions`

**Files:** create `src/utils/stock.ts` and `tests/stock.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { planStockActions } from "../src/utils/stock"

const variant = (id: number, status?: string) => ({
  id,
  availability_status: status,
})

describe("planStockActions", () => {
  it("publishes when every variant is active", () => {
    const plan = planStockActions([variant(1, "active"), variant(2, "active")])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
    expect(plan.hasDiscontinued).toBe(false)
  })

  it("drafts when every variant is unavailable", () => {
    const plan = planStockActions([
      variant(1, "out_of_stock"),
      variant(2, "temporary_out_of_stock"),
    ])
    expect(plan.status).toBe("draft")
    expect(plan.allUnavailable).toBe(true)
  })

  it("stays published when one variant is still active", () => {
    // A single sold-out size does not hide the whole product.
    const plan = planStockActions([
      variant(1, "out_of_stock"),
      variant(2, "active"),
    ])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })

  it("flags discontinued separately from out of stock", () => {
    const plan = planStockActions([variant(1, "discontinued")])
    expect(plan.status).toBe("draft")
    expect(plan.hasDiscontinued).toBe(true)
  })

  it("reports discontinued even when another variant is active", () => {
    const plan = planStockActions([
      variant(1, "discontinued"),
      variant(2, "active"),
    ])
    expect(plan.status).toBe("published")
    expect(plan.hasDiscontinued).toBe(true)
  })

  it("treats an unrecognized status as available", () => {
    // A status Printful adds later must not silently hide a catalog.
    const plan = planStockActions([variant(1, "some_future_status")])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })

  it("treats a missing status as available", () => {
    const plan = planStockActions([variant(1, undefined)])
    expect(plan.status).toBe("published")
  })

  it("records availability per variant for metadata", () => {
    const plan = planStockActions([
      variant(1001, "active"),
      variant(1002, "out_of_stock"),
    ])
    expect(plan.variantAvailability).toEqual({
      "1001": "active",
      "1002": "out_of_stock",
    })
  })

  it("publishes a product with no variants rather than hiding it", () => {
    // An empty list is a data oddity, not evidence the product sold out.
    const plan = planStockActions([])
    expect(plan.status).toBe("published")
    expect(plan.allUnavailable).toBe(false)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "Cannot find module '../src/utils/stock'"

- [ ] **Step 3: Implement**

Create `src/utils/stock.ts`:

```typescript
import type { PrintfulSyncVariant } from "./types"
import type { StockPlan } from "./types"

/** Statuses that mean a variant cannot currently be ordered. */
const UNAVAILABLE = new Set([
  "out_of_stock",
  "temporary_out_of_stock",
  "discontinued",
])

/**
 * Decide what a product's stock state means for its publication.
 *
 * Pure: returns intent, performs nothing. The caller applies the marker rules
 * that keep this from overriding a merchant's own draft.
 *
 * An unrecognized or missing status counts as available. Printful can add a
 * status at any time, and treating the unknown as sold out would hide a
 * catalog on a value we simply have not seen before.
 */
export function planStockActions(
  variants: Array<Pick<PrintfulSyncVariant, "id" | "availability_status">>
): StockPlan {
  const variantAvailability: Record<string, string> = {}
  let anyAvailable = false
  let hasDiscontinued = false

  for (const v of variants) {
    const status = v.availability_status ?? "active"
    variantAvailability[String(v.id)] = status

    if (status === "discontinued") {
      hasDiscontinued = true
    }
    if (!UNAVAILABLE.has(status)) {
      anyAvailable = true
    }
  }

  // No variants at all is a data oddity, not evidence of a sellout.
  const allUnavailable = variants.length > 0 && !anyAvailable

  return {
    status: allUnavailable ? "draft" : "published",
    allUnavailable,
    hasDiscontinued,
    variantAvailability,
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: PASS, 9 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/stock.ts tests/stock.test.ts
git status --short
git commit -m "feat: decide publication from Printful stock status

Refs #4"
```

---

## Task 4: The publication marker

The marker is what keeps stock handling from overriding merchandising: the plugin re-publishes only what the plugin unpublished.

**Files:** modify `src/utils/stock.ts` and `tests/stock.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/stock.test.ts`:

```typescript
import { resolvePublication, STOCK_MARKER_KEY } from "../src/utils/stock"

describe("resolvePublication", () => {
  it("unpublishes an available-turned-unavailable product and marks it", () => {
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "published",
      currentMetadata: {},
    })
    expect(result.status).toBe("draft")
    expect(result.metadata[STOCK_MARKER_KEY]).toBe("unavailable")
  })

  it("republishes a product the plugin unpublished, clearing the marker", () => {
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.status).toBe("published")
    expect(result.metadata[STOCK_MARKER_KEY]).toBeUndefined()
  })

  it("leaves a merchant's draft alone when there is no marker", () => {
    // The merchant drafted this deliberately — a restock must not undo that.
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "draft",
      currentMetadata: {},
    })
    expect(result.status).toBe("draft")
    expect(result.changed).toBe(false)
  })

  it("does not touch a published product that is still available", () => {
    const result = resolvePublication({
      plan: { status: "published", allUnavailable: false } as never,
      currentStatus: "published",
      currentMetadata: {},
    })
    expect(result.status).toBe("published")
    expect(result.changed).toBe(false)
  })

  it("re-unpublishes a marked product a merchant manually published", () => {
    // A stale marker is harmless: the product is genuinely unavailable, so
    // hiding it again is the right outcome.
    const result = resolvePublication({
      plan: { status: "draft", allUnavailable: true } as never,
      currentStatus: "published",
      currentMetadata: { [STOCK_MARKER_KEY]: "unavailable" },
    })
    expect(result.status).toBe("draft")
    expect(result.changed).toBe(true)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — "resolvePublication is not a function"

- [ ] **Step 3: Implement**

Append to `src/utils/stock.ts`:

```typescript
/** Marks a product the plugin unpublished because Printful ran out of it. */
export const STOCK_MARKER_KEY = "printful_stock_status"

/** Set when Printful reports a variant as discontinued. Informational only. */
export const DISCONTINUED_MARKER_KEY = "printful_discontinued"

export type PublicationInput = {
  plan: StockPlan
  currentStatus: "published" | "draft"
  currentMetadata: Record<string, unknown>
}

export type PublicationResult = {
  status: "published" | "draft"
  metadata: Record<string, unknown>
  /** False when nothing needs writing, so the caller can skip the update. */
  changed: boolean
}

/**
 * Apply the stock plan without overriding the merchant.
 *
 * The plugin owns only the transitions it caused: it marks a product when it
 * unpublishes one for being sold out, and re-publishes only a product carrying
 * that marker. A product the merchant drafted themselves — no marker — is left
 * exactly as they left it, however available Printful says it is.
 */
export function resolvePublication(input: PublicationInput): PublicationResult {
  const { plan, currentStatus, currentMetadata } = input
  const metadata = { ...currentMetadata }
  const marked = currentMetadata[STOCK_MARKER_KEY] === "unavailable"

  if (plan.allUnavailable) {
    if (currentStatus === "draft" && marked) {
      return { status: "draft", metadata, changed: false }
    }
    metadata[STOCK_MARKER_KEY] = "unavailable"
    return { status: "draft", metadata, changed: true }
  }

  // Available again. Only undo an unpublish we performed.
  if (currentStatus === "draft") {
    if (!marked) {
      return { status: "draft", metadata, changed: false }
    }
    delete metadata[STOCK_MARKER_KEY]
    return { status: "published", metadata, changed: true }
  }

  if (marked) {
    delete metadata[STOCK_MARKER_KEY]
    return { status: "published", metadata, changed: true }
  }

  return { status: "published", metadata, changed: false }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: PASS, 5 new tests

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/stock.ts tests/stock.test.ts
git status --short
git commit -m "feat: re-publish only what the plugin unpublished

Refs #4"
```

---

## Task 5: Model and migration

**Files:** modify `src/modules/printful/models/printful-sync-log.ts`, create `src/modules/printful/migrations/Migration20260802000000.ts`

No unit test — verified by Task 6's integration tests and by `npm run build`.

- [ ] **Step 1: Add the columns to the model**

In `src/modules/printful/models/printful-sync-log.ts`, add inside `model.define`:

```typescript
  heartbeat_at: model.dateTime().nullable(),
  products_processed: model.number().default(0),
  products_total: model.number().default(0),
```

- [ ] **Step 2: Create the migration**

```typescript
import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260802000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "printful_sync_log"
        add column if not exists "heartbeat_at" timestamptz null,
        add column if not exists "products_processed" integer not null default 0,
        add column if not exists "products_total" integer not null default 0;
    `)

    // At most one running sync, whatever the state of finished ones. Indexing
    // the constant `true` under a status predicate is what makes the claim
    // atomic: a second concurrent claim collides here rather than racing
    // between a read and a write.
    this.addSql(`
      create unique index if not exists "IDX_printful_sync_log_one_running"
      on "printful_sync_log" ((true))
      where status = 'running' and deleted_at is null;
    `)

    this.addSql(`
      create index if not exists "IDX_printful_sync_log_heartbeat"
      on "printful_sync_log" ("heartbeat_at")
      where status = 'running' and deleted_at is null;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_printful_sync_log_heartbeat";`)
    this.addSql(`drop index if exists "IDX_printful_sync_log_one_running";`)
    this.addSql(`
      alter table "printful_sync_log"
        drop column if exists "products_total",
        drop column if exists "products_processed",
        drop column if exists "heartbeat_at";
    `)
  }
}
```

- [ ] **Step 3: Verify the SQL against real Postgres**

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
psql -h localhost -d print2medusa_test -c "
  create table if not exists probe_sync_log (
    id text primary key, status text not null,
    heartbeat_at timestamptz, deleted_at timestamptz);
  create unique index if not exists probe_one_running
    on probe_sync_log ((true)) where status = 'running' and deleted_at is null;
  insert into probe_sync_log values ('a','running',now(),null);
  insert into probe_sync_log values ('b','success',now(),null);
"
psql -h localhost -d print2medusa_test -c "
  insert into probe_sync_log values ('c','running',now(),null);
" 2>&1 | tail -2
psql -h localhost -d print2medusa_test -c "drop table probe_sync_log;"
```

Expected: the second `running` insert fails with `duplicate key value violates unique constraint`. If it succeeds, the index predicate is wrong — stop and report.

- [ ] **Step 4: Verify build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/modules/printful/models/printful-sync-log.ts src/modules/printful/migrations/Migration20260802000000.ts
git status --short
git commit -m "feat: sync log heartbeat, progress, and one-running index

Refs #4"
```

---

## Task 6: Claim, reap, heartbeat

**Files:** modify `src/modules/printful/service.ts`, create `tests/sync-claim.integration.test.ts`

- [ ] **Step 1: Add the service methods**

Add to `PrintfulModuleService`, after `getLatestSyncLog`:

```typescript
  /**
   * Mark abandoned running syncs as failed.
   *
   * One statement whose predicate does the selecting, so there is no
   * read-then-decide window. A row is abandoned when its heartbeat is older
   * than the stale window, or when it never got one.
   */
  async reapStaleSyncLogs(staleMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000)
    const stale = await this.listPrintfulSyncLogs({
      status: "running",
      $or: [
        { heartbeat_at: { $lt: cutoff } },
        { heartbeat_at: null },
      ],
    })

    for (const log of stale) {
      await this.updatePrintfulSyncLogs({
        id: log.id,
        status: "failed",
        error_message: "stale_running",
        finished_at: new Date(),
      })
    }

    return stale.length
  }

  /**
   * Claim the right to run a sync.
   *
   * Returns the new log on success, or null when another sync already holds
   * the claim. The unique index on `status = 'running'` is what makes this
   * atomic — a second concurrent claim collides in the database rather than
   * racing between a read and a write.
   */
  async claimSyncLog(staleMinutes: number): Promise<{
    id: string
  } | null> {
    await this.reapStaleSyncLogs(staleMinutes)

    const now = new Date()
    try {
      return await this.createPrintfulSyncLogs({
        status: "running",
        started_at: now,
        heartbeat_at: now,
        products_created: 0,
        products_updated: 0,
        products_failed: 0,
        products_processed: 0,
        products_total: 0,
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        return null
      }
      throw err
    }
  }

  /** The sync currently holding the claim, for a 409 body. */
  async getRunningSyncLog() {
    const [log] = await this.listPrintfulSyncLogs({ status: "running" })
    return log ?? null
  }

  /** Refresh the claim so it is not reaped, and report progress. */
  async heartbeatSyncLog(
    id: string,
    progress: { products_processed?: number; products_total?: number } = {}
  ) {
    return this.updatePrintfulSyncLogs({
      id,
      heartbeat_at: new Date(),
      ...progress,
    })
  }
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/sync-claim.integration.test.ts`. Follow the technique already used in `tests/webhook-route.integration.test.ts` — read it first; it boots the printful module against real Postgres via `MedusaModule.bootstrap` with `moduleExports`, because `medusaIntegrationTestRunner` cannot work in a plugin repo with no root `medusa-config.ts`.

```typescript
import { describe, expect, it, beforeEach } from "vitest"

// Boot the printful module against real Postgres exactly as
// tests/webhook-route.integration.test.ts does — copy that harness rather than
// inventing a second one.

describe("sync claim", () => {
  beforeEach(async () => {
    // The one-running index is global, so a leftover running row from a
    // previous test would make every later claim return null.
    const logs = await service.listPrintfulSyncLogs({})
    for (const log of logs) {
      await service.deletePrintfulSyncLogs(log.id)
    }
  })

  it("lets exactly one of two concurrent claims through", async () => {
    const [a, b] = await Promise.all([
      service.claimSyncLog(60),
      service.claimSyncLog(60),
    ])

    const winners = [a, b].filter(Boolean)
    expect(winners).toHaveLength(1)
  })

  it("refuses a claim while another sync is running", async () => {
    expect(await service.claimSyncLog(60)).toBeTruthy()
    expect(await service.claimSyncLog(60)).toBeNull()
  })

  it("allows a claim once the running sync's heartbeat is stale", async () => {
    const first = await service.claimSyncLog(60)
    expect(first).toBeTruthy()

    // Age the heartbeat past the window.
    await service.updatePrintfulSyncLogs({
      id: first!.id,
      heartbeat_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
    })

    const second = await service.claimSyncLog(60)
    expect(second).toBeTruthy()

    const reaped = await service.retrievePrintfulSyncLog(first!.id)
    expect(reaped.status).toBe("failed")
    expect(reaped.error_message).toBe("stale_running")
  })

  it("does not reap a healthy running sync", async () => {
    const first = await service.claimSyncLog(60)
    await service.heartbeatSyncLog(first!.id)

    expect(await service.claimSyncLog(60)).toBeNull()
  })

  it("is not blocked by finished logs, however many", async () => {
    for (let i = 0; i < 5; i++) {
      const log = await service.claimSyncLog(60)
      await service.updatePrintfulSyncLogs({
        id: log!.id,
        status: "success",
        finished_at: new Date(),
      })
    }

    expect(await service.claimSyncLog(60)).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run and watch it fail, then pass**

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DATABASE_URL=postgres://andy@localhost:5432/print2medusa_test npm run test:integration
```

The concurrency test is the important one. **Prove it is a real guard:** temporarily drop the unique index (`drop index "IDX_printful_sync_log_one_running"` against the test database), re-run, confirm _both_ claims succeed and the test FAILS, then restore the index by re-running migrations. Report both outputs.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run typecheck:tests && npm run build`

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/modules/printful/service.ts tests/sync-claim.integration.test.ts
git status --short
git commit -m "feat: atomic sync claim with stale reaping

Refs #4"
```

---

## Task 7: Stock in the mapper

**Files:** modify `src/utils/mappers.ts`, `tests/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mappers.test.ts`:

```typescript
import { planStockActions } from "../src/utils/stock"

describe("mapSyncProductToMedusa stock", () => {
  it("creates a sold-out product as a draft rather than publishing it", () => {
    const soldOut: PrintfulSyncProductDetail = {
      sync_product: {
        id: 200,
        external_id: null,
        name: "Sold Out Tee",
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: 2001,
          sync_product_id: 200,
          name: "Sold Out Tee - M",
          retail_price: "25.00",
          currency: "USD",
          availability_status: "out_of_stock",
        },
      ],
    }

    const mapped = mapSyncProductToMedusa(soldOut, { storeId: "42" })
    expect(mapped.status).toBe("draft")
  })

  it("publishes a product with an available variant", () => {
    const mapped = mapSyncProductToMedusa(sample, { storeId: "42" })
    expect(mapped.status).toBe("published")
  })

  it("writes availability into variant metadata", () => {
    const mapped = mapSyncProductToMedusa(sample, { storeId: "42" })
    expect(mapped.variants[0].metadata.printful_availability_status).toBe(
      "active"
    )
  })

  it("flags a discontinued product so the owner can find it", () => {
    const gone: PrintfulSyncProductDetail = {
      sync_product: {
        id: 300,
        external_id: null,
        name: "Retired Tee",
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: 3001,
          sync_product_id: 300,
          name: "Retired Tee - M",
          retail_price: "25.00",
          currency: "USD",
          availability_status: "discontinued",
        },
      ],
    }

    const mapped = mapSyncProductToMedusa(gone, { storeId: "42" })
    expect(mapped.metadata.printful_discontinued).toBe(true)
  })

  it("omits the discontinued flag when the option turns it off", () => {
    const gone: PrintfulSyncProductDetail = {
      sync_product: {
        id: 301,
        external_id: null,
        name: "Retired Tee 2",
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: 3011,
          sync_product_id: 301,
          name: "Retired Tee 2 - M",
          retail_price: "25.00",
          currency: "USD",
          availability_status: "discontinued",
        },
      ],
    }

    const mapped = mapSyncProductToMedusa(gone, {
      storeId: "42",
      onDiscontinued: "ignore",
    })
    expect(mapped.metadata.printful_discontinued).toBeUndefined()
    // Still unpublished — "ignore" only turns off the marker, not the hiding.
    expect(mapped.status).toBe("draft")
  })
})
```

Note the existing `sample` fixture in that file has no `availability_status` on its variants, so it exercises the "missing status means available" path.

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — the sold-out product maps to `"published"`, since the mapper hardcodes it.

- [ ] **Step 3: Implement**

In `src/utils/mappers.ts`, import the planner and the marker key:

```typescript
import { DISCONTINUED_MARKER_KEY, planStockActions } from "./stock"
```

Inside `mapSyncProductToMedusa`, before building the return object:

```typescript
const stock = planStockActions(sync_variants)
```

Change the hardcoded status:

```typescript
    status: stock.status,
```

Add availability to each variant's metadata, inside the existing `metadata` object in the variant map:

```typescript
        printful_availability_status:
          stock.variantAvailability[String(v.id)] ?? "active",
```

And flag a discontinued product in the product metadata, unless the option turns
it off. Add to the product-level `metadata` object:

```typescript
      ...(stock.hasDiscontinued && options.onDiscontinued !== "ignore"
        ? { [DISCONTINUED_MARKER_KEY]: true }
        : {}),
```

`mapSyncProductToMedusa` already takes an `options` argument typed as a `Pick`
of `PrintfulPluginOptions` — widen that `Pick` to include `onDiscontinued`.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test && npm run typecheck && npm run typecheck:tests`
Expected: PASS. Existing mapper tests must still pass — the `sample` fixture has no availability, so it stays `published`.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/utils/mappers.ts tests/mappers.test.ts
git status --short
git commit -m "feat: map Printful stock onto product publication

Refs #4"
```

---

## Task 8: Compensation for orphaned products

**Files:** modify `src/workflows/sync-products.ts`

- [ ] **Step 1: Understand what must be tracked**

Read `syncProductsStep` in `src/workflows/sync-products.ts`. In the create branch it calls `createProductsWorkflow`, then writes a `printful_product_link` row.

The window between those two writes is the only state a compensation can safely undo: a product created but not yet linked is invisible to the next sync's `findProductLink`, so it would be duplicated. A product with a committed link is fine and must never be deleted, even if a later product fails.

- [ ] **Step 2: Track orphans**

At the top of the step body:

```typescript
// Products created but not yet linked. A crash leaves exactly these
// invisible to the next sync's findProductLink, so they are the only
// thing the compensation may delete.
const orphanProductIds: string[] = []
```

After `createProductsWorkflow(...).run(...)` returns `created`:

```typescript
orphanProductIds.push(created.id)
```

After the `createPrintfulProductLinks` call for that product succeeds:

```typescript
// Linked — no longer an orphan, and never to be deleted.
const idx = orphanProductIds.indexOf(created.id)
if (idx !== -1) {
  orphanProductIds.splice(idx, 1)
}
```

Return them alongside the counters so the compensation receives them:

```typescript
return new StepResponse(counters, { orphanProductIds })
```

- [ ] **Step 3: Add the compensation**

`createStep` takes a compensation function as its third argument. Add it to `syncProductsStep`:

```typescript
;async (
  compensateInput: { orphanProductIds: string[] } | undefined,
  { container }
) => {
  if (!compensateInput?.orphanProductIds?.length) {
    return
  }

  const productModule = container.resolve(Modules.PRODUCT)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  // Delete through the product module so variants, prices, and images go
  // with the product rather than being orphaned a second time.
  for (const id of compensateInput.orphanProductIds) {
    try {
      await productModule.deleteProducts([id])
    } catch (err) {
      logger.error(
        `Printful sync rollback: could not delete orphaned product ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  logger.info(
    `Printful sync rolled back ${compensateInput.orphanProductIds.length} orphaned product(s)`
  )
}
```

Add `ContainerRegistrationKeys` to the existing import from `@medusajs/framework/utils`.

**Verify the compensation signature before relying on it:** read `node_modules/@medusajs/workflows-sdk/dist/utils/composer/create-step.d.ts` and confirm the third argument is the compensation and that it receives what `StepResponse`'s second argument carries. If the shape differs, adjust and say what you found.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. There is no unit test for the compensation here — it needs a container, and Task 11 covers it.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/workflows/sync-products.ts
git status --short
git commit -m "feat: roll back products created but never linked

Refs #4"
```

---

## Task 9: Background execution and heartbeat

**Files:** modify `src/workflows/sync-products.ts`

- [ ] **Step 1: Take the sync log id as input rather than creating one**

The claim now happens in the route, so the workflow must not create its own log. Change `SyncProductsInput`:

```typescript
export type SyncProductsInput = {
  /** The claimed sync log. The workflow never claims — the route already did. */
  sync_log_id: string
  /** Optional limit for testing or a partial sync. */
  limit?: number
}
```

Delete `createSyncLogStep` entirely and remove it from the workflow body. `finalizeSyncLogStep` now takes the id from the input instead of from the created log.

- [ ] **Step 2: Configure the step for background execution**

Give `syncProductsStep` a config object. `createStep` accepts either a name or a config as its first argument:

```typescript
const syncProductsStep = createStep(
  {
    name: "printful-sync-products",
    // Runs past the HTTP response and completes on its own — no
    // setStepSuccess needed, which is what backgroundExecution adds to async.
    async: true,
    backgroundExecution: true,
    // Not an execution timeout: the step runs regardless, but exceeding this
    // marks it TIMEOUT and reverts the workflow, which would delete the
    // orphans it was about to link. Sized for a large catalog.
    timeout: 7200,
  },
  async (input: SyncProductsInput, { container }) => {
```

Use the timeout value Task 1 established. If Task 1 found that the default is already unlimited, say so in a comment and omit the field.

- [ ] **Step 3: Heartbeat as it works**

Inside the product loop in `syncProductsStep`, after each product is processed:

```typescript
processed += 1
await printful.heartbeatSyncLog(input.sync_log_id, {
  products_processed: processed,
  products_total: toProcess.length,
})
```

Declare `let processed = 0` before the loop, and set the total once before it starts:

```typescript
await printful.heartbeatSyncLog(input.sync_log_id, {
  products_total: toProcess.length,
})
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck && npm run build`

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/workflows/sync-products.ts
git status --short
git commit -m "feat: run the catalog sync in the background

Refs #4"
```

---

## Task 10: Route and scheduled job

**Files:** modify `src/api/admin/printful/sync/route.ts`, `src/jobs/sync-products.ts`

- [ ] **Step 1: Rewrite the route**

```typescript
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import syncProductsWorkflow from "../../../../workflows/sync-products"

/**
 * Start a catalog sync.
 *
 * The claim completes before this responds. Doing it inside the background
 * step would let two requests both answer 202 before either reached the
 * insert, which is exactly the race the unique index exists to prevent.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()

  const limit =
    typeof req.body === "object" &&
    req.body &&
    "limit" in req.body &&
    req.body.limit != null
      ? Number((req.body as { limit?: number }).limit)
      : undefined

  const claim = await printful.claimSyncLog(options.syncStaleMinutes ?? 60)

  if (!claim) {
    const running = await printful.getRunningSyncLog()
    res.status(409).json({
      message: "A Printful sync is already running",
      running_sync_id: running?.id,
      started_at: running?.started_at,
      heartbeat_at: running?.heartbeat_at,
    })
    return
  }

  void syncProductsWorkflow(req.scope).run({
    input: {
      sync_log_id: claim.id,
      limit: Number.isFinite(limit) ? limit : undefined,
    },
  })

  res.status(202).json({ sync_id: claim.id })
}
```

- [ ] **Step 2: Update the scheduled job**

In `src/jobs/sync-products.ts`, replace the body so it takes the same claim and skips quietly on conflict:

```typescript
const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
const options = await printful.getOptions()

const claim = await printful.claimSyncLog(options.syncStaleMinutes ?? 60)
if (!claim) {
  // A manual sync is already covering the catalog. Not a problem.
  logger.info("Printful scheduled sync skipped: another sync is running")
  return
}

logger.info("Printful scheduled sync starting")
try {
  const { result } = await syncProductsWorkflow(container).run({
    input: { sync_log_id: claim.id },
  })
  logger.info(
    `Printful scheduled sync done: created=${result.counters.created} updated=${result.counters.updated} failed=${result.counters.failed}`
  )
} catch (err) {
  logger.error(
    `Printful scheduled sync failed: ${
      err instanceof Error ? err.message : String(err)
    }`
  )
}
```

Add the imports it needs: `PRINTFUL_MODULE` from `../modules/printful` and the service type. Resolve the logger through `ContainerRegistrationKeys.LOGGER`, not the string `"logger"` — the repo's lint rule warns on the magic string and `sync-products.ts` currently trips it.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build && npm run lint`
Expected: all pass, lint 0 errors and **no new warnings** — check the count before and after.

- [ ] **Step 4: Commit**

```bash
npm run format
git add src/api/admin/printful/sync/route.ts src/jobs/sync-products.ts
git status --short
git commit -m "feat: claim before responding 202; scheduled job skips on conflict

Refs #4"
```

---

## Task 11: Compensation integration test

**Files:** modify `tests/sync-claim.integration.test.ts`

The compensation is the one piece whose correctness cannot be shown without a real database and a real workflow run.

- [ ] **Step 1: Write the test**

Append to `tests/sync-claim.integration.test.ts`:

```typescript
describe("sync compensation", () => {
  it("deletes only products that were never linked", async () => {
    // Three products. The third throws while being fetched, so the step fails
    // after the first two are created AND linked, and after the third is
    // created but before its link row exists.
    const detail = (id: number) => ({
      sync_product: {
        id,
        external_id: null,
        name: `Product ${id}`,
        variants: 1,
        synced: 1,
      },
      sync_variants: [
        {
          id: id * 10,
          sync_product_id: id,
          name: `Product ${id} - M`,
          retail_price: "25.00",
          currency: "USD",
          variant_id: 4000 + id,
        },
      ],
    })

    const client = {
      listAllSyncProducts: async () => [
        { id: 1, name: "Product 1", external_id: null, variants: 1, synced: 1 },
        { id: 2, name: "Product 2", external_id: null, variants: 1, synced: 1 },
        { id: 3, name: "Product 3", external_id: null, variants: 1, synced: 1 },
      ],
      getSyncProduct: async (id: number) => {
        if (id === 3) {
          throw new Error("Printful exploded on the third product")
        }
        return detail(id)
      },
    }

    const claim = await service.claimSyncLog(60)
    // Swap the client so no real HTTP happens.
    ;(service as never as { client_: unknown }).client_ = client

    await expect(
      syncProductsWorkflow(container).run({
        input: { sync_log_id: claim!.id },
      })
    ).rejects.toThrow()

    // The two that completed keep their links and their products.
    for (const syncProductId of ["1", "2"]) {
      const link = await service.findProductLink(syncProductId)
      expect(link).toBeTruthy()

      const product = await productModule
        .retrieveProduct(link!.medusa_product_id)
        .catch(() => null)
      expect(product).toBeTruthy()
    }

    // The third never got a link, so nothing points at a product that the
    // next sync would fail to find and would therefore duplicate.
    expect(await service.findProductLink("3")).toBeNull()
  })
})
```

The assertion that matters: **a failure on the third product leaves the first two intact.** If the step recorded every product it created instead of only unlinked ones, this test fails — which is the point of writing it.

Adapt the harness details (how `service`, `container`, and `productModule` are obtained) from the existing `beforeEach` in this file rather than inventing a second setup.

- [ ] **Step 2: Prove it is a real guard**

Temporarily change the step to push every created id onto `orphanProductIds` and never remove them on link. Run the test, confirm it FAILS because the first two products were deleted, then revert. Report both outputs.

- [ ] **Step 3: Verify and commit**

```bash
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DATABASE_URL=postgres://andy@localhost:5432/print2medusa_test npm run test:integration
npm run format
git add tests/sync-claim.integration.test.ts
git status --short
git commit -m "test: compensation deletes orphans, not synced products

Refs #4"
```

---

## Task 12: Admin widget

**Files:** modify `src/admin/widgets/printful-sync-widget.tsx`

- [ ] **Step 1: Poll while running and disable the button**

Read the widget first — it already fetches `/admin/printful/status` and has `syncing`/`loading` state.

Changes:

1. When `status.running` is true, poll `/admin/printful/status` every 3 seconds; stop when it goes false.
2. Disable **Sync Now** while `status.running` — the owner should not click into a `409`.
3. Show progress from the new fields when running: `products_processed` of `products_total`.
4. On a `409` response from the sync POST, show the running sync's `started_at` rather than a generic failure.

```typescript
useEffect(() => {
  if (!status?.running) {
    return
  }
  const t = setInterval(() => void loadStatus(), 3000)
  return () => clearInterval(t)
}, [status?.running])
```

For the sync handler's conflict branch:

```typescript
if (res.status === 409) {
  const body = await res.json()
  toast.info("A Printful sync is already running", {
    description: body.started_at
      ? `Started ${new Date(body.started_at).toLocaleString()}`
      : undefined,
  })
  await loadStatus()
  return
}
```

Extend the `SyncStatus` type with `products_processed` and `products_total` on `latest_sync`.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run build`
Expected: both pass — `build` compiles admin extensions, so it catches widget errors.

- [ ] **Step 3: Commit**

```bash
npm run format
git add src/admin/widgets/printful-sync-widget.tsx
git status --short
git commit -m "feat: show sync progress and block a second run

Refs #4"
```

---

## Task 13: Documentation and release

**Files:** modify `README.md`, `CHANGELOG.md`, `package.json`, `ROADMAP.md`

- [ ] **Step 1: Document the sync behavior in the README**

Add after the "What it does (MVP)" table:

```markdown
## Catalog sync

`POST /admin/printful/sync` claims the sync and returns `202` immediately with a
`sync_id`; the work continues in the background. Poll
`GET /admin/printful/status` for progress, or watch the admin widget.

Only one sync runs at a time. A second request gets `409` naming the sync
already in progress — the guarantee is a Postgres unique index, so a double
click cannot slip through.

If a sync dies mid-run, its claim is released after `syncStaleMinutes`
(default 60) and the log is marked `failed` with `stale_running`. **A resumed
sync starts over** rather than continuing where it stopped; the upsert is
idempotent, so this is correct, just slower.

### Stock

Printful reports availability per variant, and the sync acts on it:

| Printful status                          | Effect                                                         |
| ---------------------------------------- | -------------------------------------------------------------- |
| `active`                                 | product published                                              |
| `out_of_stock`, `temporary_out_of_stock` | product unpublished when **every** variant is unavailable      |
| `discontinued`                           | same, plus `metadata.printful_discontinued` so you can find it |

**The plugin only re-publishes what it unpublished.** An unpublish sets
`metadata.printful_stock_status = "unavailable"`, and only a product carrying
that marker is put back on sale when stock returns. A product you drafted
yourself stays drafted.

One sold-out size does not hide the product — its status lands in the variant's
metadata, but Medusa is not told the variant is unbuyable, because
print-on-demand variants run with `manage_inventory: false`.
```

- [ ] **Step 2: Update the CHANGELOG**

Add above `## 0.3.0`:

```markdown
## 0.4.0

The catalog sync runs in the background, rolls back cleanly, and stops selling
what Printful has run out of.

### Added

- Sync runs in the background: the route claims it and returns `202` with a `sync_id` instead of holding the request open
- Only one sync at a time, enforced by a Postgres unique index rather than a check-then-insert — a double click collides in the database
- A sync that dies is released after `syncStaleMinutes` (default 60) and logged as `stale_running`
- Live progress in the admin widget, which disables **Sync Now** while a sync is running
- Stock awareness: a product whose variants are all unavailable is unpublished, and `discontinued` is flagged separately since it will not restock
- `syncStaleMinutes`, `syncStepTimeoutSeconds`, and `onDiscontinued` options

### Fixed

- A sync that fails partway no longer leaves products with no link row, which the next sync could not see and would recreate. The rollback deletes only products created-but-not-linked; anything already synced is untouched

### Known limits

- A single sold-out variant does not become unbuyable — print-on-demand runs with `manage_inventory: false`, so there is no stock level to zero. The status reaches variant metadata for a storefront to read
- An interrupted sync restarts from the beginning rather than resuming
```

- [ ] **Step 3: Bump the version**

In `package.json`, set `"version": "0.4.0"`.

- [ ] **Step 4: Update the roadmap**

In `ROADMAP.md`: change the `0.4.0` heading from `` `next` `` to `` `shipped` ``, mark `0.5.0` as `` `next` ``, and refresh the "Where we are" table with the new version and test count. Rewrite the 0.4.0 section in past tense describing what actually shipped, and note that the `stock_updated` webhook was deferred to the v2 migration.

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

Expected: format clean, lint 0 errors, both typechecks exit 0, all tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json ROADMAP.md
git status --short
git commit -m "docs: release 0.4.0

Closes #4"
```

---

## Verification Checklist

- [ ] `npm run lint` reports 0 errors and no new warnings
- [ ] `npm run typecheck` and `npm run typecheck:tests` both exit 0
- [ ] `npm test` passes
- [ ] `npm run test:integration` passes against real Postgres
- [ ] `npm run format:check` is clean
- [ ] `npm run build` succeeds
- [ ] Two concurrent syncs → one `202`, one `409`
- [ ] A stale claim is reaped and logged `stale_running`
- [ ] A failure on product 3 of 5 leaves products 1 and 2 intact
- [ ] A sold-out product is drafted; a restocked one is republished
- [ ] A merchant's own draft is never republished by the sync
