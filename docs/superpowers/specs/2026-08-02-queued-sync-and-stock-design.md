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

The claim is therefore:

```
1. UPDATE stale running rows → failed        (single statement, no read)
2. INSERT a running row
   → 23505  → 409 { running_sync_id }
   → success → 202 { sync_id }
```

Step 1 reaps abandoned claims in one statement whose predicate does the
selecting, so it has no read-then-decide window either. `isUniqueViolation`
already recognizes both a raw 23505 and the `MedusaError` Medusa's
`dbErrorMapper` substitutes for it — including the shape that made every
redelivered webhook return 500 in 0.2.0 until it was fixed.

### Why a stale claim must expire

If the process dies mid-sync, the row stays `running` forever and no sync can
ever start again. So the running row carries `heartbeat_at`, refreshed as the
sync progresses. A row whose heartbeat is older than `syncStaleMinutes`
(default 60) is treated as abandoned and reaped by step 1.

The heartbeat interval must be far shorter than the stale window, or a slow but
healthy sync reaps itself. It is written every product, which on any realistic
catalog is far more often than once an hour.

## Background execution

The sync step is configured `{ async: true, backgroundExecution: true }`. The
route returns `202` with the sync id immediately after the claim succeeds; the
step continues on its own and needs no external completion signal.

Progress lands in `printful_sync_log` and the admin widget polls
`GET /admin/printful/status`, which already exists.

**A crashed sync does not resume.** It is reaped after the stale window and the
next run starts over. That is a deliberate trade, stated so nobody expects
otherwise.

## Stock

`SyncVariant.availability_status` is an enum Printful already sends with every
sync product:

| Status                   | Meaning                 | Action                                                |
| ------------------------ | ----------------------- | ----------------------------------------------------- |
| `active`                 | orderable               | publish                                               |
| `out_of_stock`           | sold out                | unpublish                                             |
| `temporary_out_of_stock` | sold out, expected back | unpublish                                             |
| `discontinued`           | gone for good           | unpublish, and flag unless `onDiscontinued: "ignore"` |

No extra API call is needed — the field is on data we already fetch and
currently throw away. It is declared in `PrintfulSyncVariant` and read nowhere.

`discontinued` is separated from the out-of-stock pair because it will never
resolve itself. The product is unpublished like the others, but also marked in
metadata so the owner can find and delete it rather than waiting for a
restock that is not coming.

**A product is unpublished only when every variant is unavailable.** Publishing
follows the same rule in reverse: a product returns to `published` as soon as any
variant is `active` again, so a restock needs no manual step.

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
plugin's logic.

## Compensations

`syncProductsStep` has no compensation today, so a failure partway through
leaves created products with no link rows. The next sync cannot see them through
`findProductLink`, so it creates duplicates.

The product-creation work moves into a step that records what it created and
compensates by deleting exactly that. Products that already existed are updated
rather than created, and are not touched by the compensation — an update is not
something we can roll back, and pretending otherwise would delete a store's
catalog on a transient failure.

## Options

```ts
syncStaleMinutes: 60,          // when a running claim is presumed abandoned
onDiscontinued: "flag",        // "flag" | "ignore"
```

`onDiscontinued: "flag"` marks the product in metadata; `"ignore"` unpublishes it
like any other unavailable product without the extra marking. Deletion is
deliberately not an option — the plugin does not delete a store's products.

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

**Claim race — needs real Postgres**

- Two concurrent claims: exactly one `202`, one `409` carrying the running id
- A claim succeeds when the existing running row's heartbeat is stale
- A claim fails when it is fresh
- Finished logs never block a claim, however many exist

**Compensation**

- A failure on product 3 of 5 leaves no product without a link row
- Products that already existed are not deleted by the compensation

**Volume**

- 500 mocked products complete without linear memory growth

The claim tests belong in the integration suite specifically because the
guarantee lives in a Postgres partial unique index. A unit test with a stubbed
repository would assert our belief about the index rather than the index itself.

## Out of scope

Resuming an interrupted sync (decision 2). Real-time stock via the
`stock_updated` webhook — the 0.4.0 entry in the roadmap lists it, but Printful
v1 refreshes stock on a schedule rather than per-event, so it belongs with the
v2 migration in `1.0.0`. Deleting products that Printful no longer returns: the
plugin unpublishes, it does not delete.
