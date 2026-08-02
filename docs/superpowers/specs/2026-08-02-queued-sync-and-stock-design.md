# 0.4.0 — Queued sync and stock awareness

**Status:** approved design
**Issue:** [#4](https://github.com/legenki/print2medusa/issues/4)

## Problem

Three faults in the same workflow, each visible to a different audience.

**The sync runs inside the HTTP request.** A 500-product catalog means 500+
Printful calls before the route answers. The admin times out, and the owner
cannot tell whether the sync failed or is still going.

**No step has a compensation.** A failure partway through leaves products
created in Medusa with no link rows pointing at them — invisible to the next
sync, which will create them again.

**Stock is fetched and discarded.** `SyncVariant.availability_status` arrives on
every sync and nothing reads it. A product that sold out at Printful keeps
selling in the storefront, and the customer finds out when the order fails.

## Design decisions

1. **`async: true` + `backgroundExecution: true`.** Medusa documents this exact
   pair for "time-consuming tasks that will be complete after the execution,"
   as opposed to plain `async` steps that need `setStepSuccess` from elsewhere.
2. **No cursor, no resume.** A failed sync restarts from the beginning. The
   upsert is already idempotent, so a repeat is correct — only slower. A cursor
   adds state that can itself drift out of sync, and this release is already
   adding compensations and stock handling.
3. **Reject a concurrent sync rather than queueing it.** A second sync would see
   the same Printful data; making it wait buys nothing.
4. **Out of stock means unpublished.** Not zero-inventory: the plugin sets
   `manage_inventory: false` because print-on-demand has no stock to count, and
   bending that model for one case would break the core assumption.

## Claiming a sync, without a TOCTOU window

The obvious approach — read whether a `running` log exists, then insert one — is
not atomic. Two clicks land between the read and the write, and both proceed.

Postgres closes the window instead:

```sql
create unique index if not exists "IDX_printful_sync_log_one_running"
  on "printful_sync_log" ((true))
  where status = 'running' and deleted_at is null;
```

Indexing the constant `true` under a `status = 'running'` predicate permits **at
most one running row**, while any number of finished rows coexist. Verified on
Postgres 16 during design: three finished logs inserted fine, a second `running`
raised `23505`.

### The claim must complete before the 202

Order matters here, and getting it wrong reintroduces the race the index exists
to prevent. If the claim happened inside the background step — after `run()`
returned — two requests would both answer `202` before either reached the
`INSERT`, and the index would reject one sync that its caller already believed
had started.

So the sequence is fixed:

```
1. Route: UPDATE stale running rows → failed     (single statement, no read)
2. Route: INSERT a running row                   (the claim)
     → 23505  → 409 { running_sync_id, started_at, heartbeat_at }
     → success → continue
3. Route: start the workflow with { sync_log_id }
4. Route: respond 202 { sync_id }
5. Background step: walk the catalog, heartbeat, write counters
6. Tail step: status → success | failed, finished_at
```

Steps 1 and 2 finish before the route answers. **The background body never
claims** — it receives the `sync_log_id` it was given and trusts that the claim
already succeeded.

Step 1 reaps abandoned claims in one statement whose predicate does the
selecting, so it has no read-then-decide window either. A reaped row is marked
`failed` with `error_message: "stale_running"`, so an abandoned sync is
distinguishable in the log from one that genuinely errored.

`isUniqueViolation` already recognizes both a raw 23505 and the `MedusaError`
Medusa's `dbErrorMapper` substitutes for it — including the shape that made
every redelivered webhook return 500 in 0.2.0 until it was fixed.

The `409` body carries the running sync's id, `started_at`, and `heartbeat_at`,
read back in a `SELECT` after the collision, so the admin can show what is
already in progress rather than a bare refusal.

The scheduled daily job takes the same claim. On a `409` it logs at `info` and
returns — a manual sync already covering the catalog is not a problem worth
warning about.

### Why a stale claim must expire

If the process dies mid-sync, the row stays `running` forever and no sync can
ever start again. So the running row carries `heartbeat_at`, refreshed as the
sync progresses. A row whose heartbeat is older than `syncStaleMinutes`
(default 60) is treated as abandoned and reaped by step 1.

The heartbeat interval must be far shorter than the stale window, or a slow but
healthy sync reaps itself. It is written every product, which on any realistic
catalog is far more often than once an hour.

## Model changes

`printful_sync_log` gains three columns:

| Column               | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `heartbeat_at`       | nullable timestamptz — how a stale claim is detected |
| `products_processed` | how far along the run is, for the admin poll         |
| `products_total`     | how far it has to go                                 |

Without the last two the admin sees only the final counters, which are written
when the sync ends — so a running sync would show all zeros and look stuck.

`heartbeat_at` is set to `started_at` when the claim is taken, then refreshed
after each product. The migration adds the partial unique index from above, and
its `down()` drops both the index and the columns.

## Background execution

The sync step is configured `{ async: true, backgroundExecution: true }`. The
route returns `202` with the sync id after the claim succeeds; the step
continues on its own and needs no external completion signal.

Progress lands in `printful_sync_log` and the admin widget polls
`GET /admin/printful/status`, which already exists. While a sync is running the
widget disables **Sync Now** rather than letting the owner click into a `409`.

### The step timeout is not a detail to leave defaulted

Medusa's `timeout` on a step is documented as _not_ an execution timeout: the
step runs regardless, but if no response arrives within the window it is marked
`TransactionStepStatus.TIMEOUT` and the workflow is reverted as soon as the
response does arrive. For a 500-product catalog that means a long sync could
finish successfully and then be compensated — deleting the orphans it was about
to link.

So the sync step sets an explicit, generous `timeout` rather than inheriting a
default. The first implementation task confirms what the default actually is in
Medusa 2.18 and picks a value with room for the largest realistic catalog. If it
turns out no timeout can be set high enough, that is a finding worth reporting
rather than working around.

**A crashed sync does not resume.** It is reaped after the stale window and the
next run starts over. That is a deliberate trade, stated so nobody expects
otherwise.

## Stock

`SyncVariant.availability_status` is an enum Printful already sends with every
sync product:

| Status                   | Meaning                 | Action                                                                       |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------- |
| `active`                 | orderable               | publish                                                                      |
| `out_of_stock`           | sold out                | unpublish                                                                    |
| `temporary_out_of_stock` | sold out, expected back | unpublish                                                                    |
| `discontinued`           | gone for good           | unpublish, and set `printful_discontinued` unless `onDiscontinued: "ignore"` |

No extra API call is needed — the field is on data we already fetch and
currently throw away. It is declared in `PrintfulSyncVariant` and read nowhere.

`discontinued` is separated from the out-of-stock pair because it will never
resolve itself. The product is unpublished like the others, but also marked in
metadata so the owner can find and delete it rather than waiting for a
restock that is not coming.

**A product is unpublished only when every variant is unavailable.**

### The plugin only re-publishes what it unpublished

Republishing on restock is right for a product the plugin hid, and wrong for one
the merchant hid on purpose. A store owner who drafts a product to hold it for a
seasonal launch would find the next sync putting it back on sale.

So an unpublish driven by stock is recorded:

```ts
metadata.printful_stock_status = "unavailable"
```

The rules follow from that marker:

- **Unpublish** when every variant is unavailable _and_ the product is currently
  published — set the marker at the same time
- **Re-publish** when a variant becomes active again **only if the marker is
  present**, then clear it
- **Never touch** a draft product with no marker. The merchant drafted it, and
  its publication state is theirs to decide

A merchant who manually publishes a product the plugin had hidden leaves a stale
marker behind. That is harmless: the next sync sees the product published and
either clears the marker on restock or re-unpublishes it if it is genuinely
still unavailable, which is the correct outcome either way.

A single sold-out size is a harder case, and this release does not solve it.
With `manage_inventory: false` there is no stock level to zero out, so a
sold-out variant stays orderable while its siblings keep the product published.
The variant's status is written to its metadata — a storefront can read it, and
the admin can see it — but Medusa is not told the variant is unbuyable. Doing
that properly means either enabling inventory management for Printful variants,
which contradicts decision 4, or deleting the variant, which loses the link row
and the customer's order history. Both deserve their own release.

The decision is a pure function, `planStockActions(variants)`, next to
`order-state.ts` — testable without a Medusa container, like the rest of the
plugin's logic. It returns the intended `status`, whether the marker should be
set or cleared, and the per-variant availability to write into metadata.

### Where it plugs into the existing sync

`mapSyncProductToMedusa` currently hardcodes `status: "published"` for every
product. That becomes the stock decision:

- **New products** are created with the status `planStockActions` returns, so a
  product that is already sold out at Printful is never published in the first
  place
- **Existing products** get `updateProducts` with the status, subject to the
  marker rules above
- **Per-variant availability** goes into each variant's metadata on both paths
- **`manage_inventory: false` is unchanged.** Print-on-demand still has no stock
  to count; this release changes visibility, not inventory

The enum values are `active`, `discontinued`, `out_of_stock`, and
`temporary_out_of_stock` — confirmed against Printful's OpenAPI spec, with
underscores rather than hyphens. An unrecognized value is treated as available,
so a new status Printful introduces does not silently hide a catalog.

## Compensations

`syncProductsStep` has no compensation today, so a failure partway through
leaves created products with no link rows. The next sync cannot see them through
`findProductLink`, so it creates duplicates.

**The compensation deletes orphans only.** A single step walks the whole
catalog, so its compensation fires for the entire step — "the failure was on
product 3 of 5" is not something the orchestrator knows. If the step simply
recorded every product it created, a failure on the third would delete the two
that had already synced correctly.

So the step tracks a narrower thing:

```
create product  → push id onto orphans
write link row  → remove id from orphans
```

An id sits in `orphans` only between its product being created and its link row
being committed. That is exactly the window in which a crash leaves a product
the next sync cannot see through `findProductLink` — the duplicate-creating
state described in the problem above. Everything else is either fully linked or
was never created.

The compensation therefore deletes only what remains in `orphans`. Products with
a committed link are never deleted, however the step failed. Products that
already existed are updated rather than created, never enter the list, and are
likewise untouched — an update cannot be rolled back, and pretending otherwise
would delete a store's catalog on a transient failure.

Deletion goes through the product module rather than raw SQL, so variants,
prices, and images are removed with the product instead of being orphaned a
second time.

## Options

```ts
syncStaleMinutes: 60,            // when a running claim is presumed abandoned
syncStepTimeoutSeconds: 7200,    // see the timeout section; must clear the
                                 // largest realistic catalog
onDiscontinued: "flag",          // "flag" | "ignore"
```

`onDiscontinued: "flag"` writes `metadata.printful_discontinued = true` so the
owner can find products that will never restock; `"ignore"` unpublishes them
like any other unavailable product without the extra marking. Deletion is
deliberately not an option — the plugin does not delete a store's products.

Two metadata keys carry stock state, and they mean different things:

| Key                     | Meaning                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `printful_stock_status` | Set to `"unavailable"` when the plugin unpublishes a product; cleared on restock. **Only a product carrying it is ever re-published.** |
| `printful_discontinued` | Set when Printful reports `discontinued` and `onDiscontinued` is `"flag"`. Purely informational — it never affects publishing.         |

## Testing

**Unit**

- `planStockActions`: every enum value; mixed variants where one is active;
  all-unavailable; an unknown status string treated as available rather than
  hiding a product on an unrecognized value
- A product with one sold-out variant stays published, and that variant's status
  reaches its metadata — the documented limitation, pinned so it is a choice
  rather than an accident
- Stale-claim arithmetic: a heartbeat inside the window is live, outside is
  abandoned, a missing heartbeat is abandoned
- The re-publish marker: unpublish sets it; restock clears it and republishes;
  **a draft product with no marker is left alone**, which is the test that keeps
  stock handling from overriding a merchant's own merchandising

**Claim race — needs real Postgres**

- Two concurrent claims: exactly one `202`, one `409` carrying the running id,
  `started_at`, and `heartbeat_at`
- A claim succeeds when the existing running row's heartbeat is stale, and the
  reaped row reads `failed` with `error_message: "stale_running"`
- A claim fails when the heartbeat is fresh
- Finished logs never block a claim, however many exist
- **The claim completes before the route answers** — two concurrent requests
  never both receive `202`

**Compensation**

- A failure on product 3 of 5 deletes only the third: the first two have
  committed link rows and survive
- Products that already existed are not deleted by the compensation
- A product created but not yet linked when the step fails is deleted, leaving
  nothing for the next sync to duplicate

**Volume**

- 500 mocked products complete without loading every product detail at once.
  The existing code already pages the list and fetches details one at a time;
  the test pins that rather than assuming it

The claim tests belong in the integration suite specifically because the
guarantee lives in a Postgres partial unique index. A unit test with a stubbed
repository would assert our belief about the index rather than the index itself.

## Out of scope

Resuming an interrupted sync (decision 2). Real-time stock via the
`stock_updated` webhook — the 0.4.0 entry in the roadmap lists it, but Printful
v1 refreshes stock on a schedule rather than per-event, so it belongs with the
v2 migration in `1.0.0`. Deleting products that Printful no longer returns: the
plugin unpublishes, it does not delete.
