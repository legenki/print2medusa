# Changelog

## 0.9.8

Tests and builds against Medusa 2.21.1. No change to the plugin's own code.

### Changed

- **Dev dependencies pinned to `@medusajs/*` 2.21.1** (and `@medusajs/ui`
  4.2.5, which is what 2.21.1's dashboard ships). Exact, as before: they
  record which version the suite ran against.
- **Peer ranges are unchanged** at `^2.18.0`.

### Why this release exists

Stores are moving to 2.21 for its Store API hardening, and the suite should
run against what they run. `dependencies` is still `{}`, so
`npm audit --omit=dev` reports zero before and after; the dev-only count goes
from 84 to 81.

Verified: typecheck (source and tests), 518 unit tests, 31 integration tests
against Postgres, lint (0 errors, 13 warnings from pre-existing rules), format
and the build all pass on 2.21.1.

### What 2.20 and 2.21 change for this plugin

- **Store API field limits (2.20 relation depth, 2.21 strict `allowed`
  lists)** do not reach here. Every route the plugin adds is under
  `/admin/printful` or the webhook at `/hooks/printful/:token`; it defines no
  Store route and requests no Store fields.
- **New `@medusajs/eslint-plugin` workflow rules** (`no-nested-when-then`,
  `missing-when-name`, `throw-in-workflow-definition`) report nothing.
- **Calculated shipping in draft orders (2.20).** Medusa now calls
  `calculatePrice` when an operator adds a calculated shipping option to a
  draft order, but that context carries no `currency_code`. `selectRate`
  refuses a quote it cannot match to a currency, so draft orders get the flat
  fallback (`currency_mismatch`) rather than a live rate — after one Printful
  rate request. Nothing throws and checkout is unaffected. A host can supply
  the currency through the new `setCalculatedShippingPricingContext` hook.

## 0.9.7

Three-decimal currencies, a plumbed-through request deadline, and typed
errors on the order path.

### Fixed

- **Dinars were scaled by 100 instead of 1000.** BHD, JOD, KWD, LYD, OMR and
  TND carry three decimal places: 1 KWD is 1000 fils, so a price Medusa stores
  as `1.234` is 1234 minor units, not 123. `minorUnitFactor` only ever asked
  whether a currency was zero-decimal, so every amount in those six was stored
  at a tenth of its value. Recorded as a known limit in 0.9.3; fixed here.
- **`timeoutMs` was unreachable.** The client has had a 15s per-attempt
  deadline since 0.7.0, but neither `getClient()` nor the fulfillment provider
  passed the option through, so setting it in plugin options did nothing. Both
  now forward it. This matters most for the provider: `calculatePrice` runs
  inside the customer's own "add shipping method" request, so a hanging
  Printful holds up checkout rather than a background job.

### Changed

- **The order path throws `MedusaError`** (`INVALID_DATA`) instead of bare
  `Error` for a non-Printful item mix, a missing shipping address, and an
  unusable `external_id`, matching the fulfillment provider and letting Medusa
  classify them rather than surfacing them as unknown failures.
- **Removed a duplicated `external_id` length check** in
  `create-printful-order`. It sat two lines above `assertUsableExternalId`,
  tested the same bound, and was weaker — length only, no character check.

### Added

- `THREE_DECIMAL_CURRENCIES` and `isThreeDecimalCurrency`, guarded by the same
  two-way comparison against Medusa's `decimal_digits` that protects the
  zero-decimal set, plus a test that no currency can be classified as both.

## 0.9.6

Tests and builds against Medusa 2.19.0. No change to the plugin's own code.

### Changed

- **Dev dependencies pinned to `@medusajs/*` 2.19.0** (and `@medusajs/ui`
  4.2.1, which is what 2.19.0's dashboard ships). The pins are exact on
  purpose — they say which version the suite actually ran against.
- **Peer ranges are unchanged** at `^2.18.0`. They already admit 2.19.0, and
  narrowing them would drop 2.18 hosts for no reason.

### Why this release exists

The plugin declares **no runtime dependencies** — `dependencies: {}` — so
`npm audit --omit=dev` reports zero vulnerabilities both before and after.
Nothing here reaches a host application. What it buys is that the suite now
runs against the version stores are being upgraded to.

### What 2.19.0 changes for this plugin

One thing, and it is an improvement rather than a break:

> fix(core-flows): pass the cart's currency and region to fulfillment providers
> when calculating shipping option prices

`calculatePrice` already reads `context.currency_code`, and refuses to quote
rather than converting when it is absent. With 2.19.0 supplying it reliably,
live Printful rates apply in carts that previously fell back.

The 2.19.0 breaking changes do not reach here. The admin surface imports only
`react`, `@medusajs/ui` and `@medusajs/admin-sdk`, and uses none of the removed
APIs — `Response.json()`, `defer()`, `splitVendorChunkPlugin`, `UIMatch.data`.
The removed `sdk.admin.product.*Option` methods were never called.

### Reading the audit numbers after upgrading

`npm audit` looks worse and is not: high goes from 19 to 72. 51 of those are
Medusa packages whose severity was recomputed from the worst advisory in their
chain, not new findings. Seven are genuinely resolved, including both
`react-router` packages and `fast-uri`. All of it is devDependencies either
way.

## 0.9.5

Follow-up to the 0.9.4 refactor: fixes a webhook handoff that could throw
after the response, and repairs the integration suite it broke.

### Fixed

- **The Event Bus emit ran after `res.json()`.** A failure there — an
  unresolvable bus, a broken transport — threw with the 200 already sent: an
  unhandled rejection Printful reads as success, with nothing logged and the
  event left for the retry job. It now emits before responding, inside a
  `try`/`catch`.
- **A failed emit no longer passes silently.** It logs and still answers 200:
  the durable row is written and the retry job owns it, so asking Printful to
  redeliver an event we already hold would only create a duplicate.
- **The integration suite was red.** The new `webhookSecret` length check
  rejected the test fixture at bootstrap, and the fake container had no
  `event_bus` — six tests failed once the fixture was lengthened. `npm test`
  stayed green throughout, which is why it went unnoticed: it does not run the
  integration suite.

### Added

- **`PRINTFUL_WEBHOOK_RECEIVED`**, shared by the route and the subscriber. A
  typo on either side used to be silent — stored, answered 200, never applied.
- **Four tests over the webhook handoff**: the event is emitted with the stored
  row id, emitted _before_ the response, not emitted for unhandled types, and a
  bus failure still answers 200 while logging.
- **Four tests over the secret check**, including the boundary at exactly 32
  and the omitted-option case.

### Changed

- **`MIN_WEBHOOK_SECRET_LENGTH`** replaces the inline `32`, and the error now
  names the length it received.
- **The `lockKeyFor` docstring** described the 32-bit single-argument lock that
  0.9.4 replaced with the 64-bit two-argument form.
- **Removed `test-workflow.js`**, a debug scratch file that was not ignored and
  would have shipped in the package.

## 0.9.4

Closes a path where one paid order could be printed and shipped twice.

### Fixed

- **A create whose outcome was unknown released its claim.** When
  `POST /orders` threw, `create-printful-order` deleted the claim row and
  rethrew so a retry could create the order. That is right only when the
  request never reached Printful. A create that timed out _after_ Printful
  accepted it is indistinguishable from the caller, and releasing the claim
  there let the next `payment.captured` place a second order — the customer's
  item printed and shipped twice, with the unique index on `medusa_order_id`
  no longer able to stop it.

The claim is now released only on an authoritative answer.

| Failure                         | Outcome                               | Action                      |
| ------------------------------- | ------------------------------------- | --------------------------- |
| 4xx other than 429 and 409      | Printful rejected it                  | release; a retry may create |
| 429, 5xx, timeout, socket error | unknown                               | ask Printful                |
| 409                             | unknown — may be "external_id exists" | ask Printful                |

When the outcome is unknown the order is looked up by `external_id`, the
idempotency key already stamped on every order the plugin creates:

- **found** — the order exists and only the response was lost. The claim is
  completed with the real id and the step reports success rather than
  rethrowing, which would mark a fulfilled order as failed.
- **404** — an authoritative absence. Release the claim; a retry may create it.
- **lookup failed** — still unknown. The claim is _held_, marked
  `status: "unverified"` with the reason and `last_attempt_at`, and logged.

Holding a claim stalls one order visibly and recoverably. Releasing it wrongly
prints and ships a second one. The trade is deliberate.

### 409 is not treated as a rejection

On create it can mean an order with that `external_id` already exists — exactly
the case where releasing the claim duplicates the order. It is classified as
unknown so the lookup decides.

### An outstanding claim no longer strands the order

A link still holding the `pending` sentinel was reported as `already_linked`:
nothing created the order, and nothing ever looked again. Such a link now
reconciles instead. A second `POST /orders` is never issued while a claim is
open.

### Added

- `PrintfulClient.getOrderByExternalId()`. The `@` prefix Printful requires is
  applied inside the client, so a bare external id cannot reach `getOrder()`
  and read a different order that happens to carry it as a numeric id.
- `PrintfulApiError.provesNotCreated`, stating the release policy once.
- `printful_order_link.error_message` and `.last_attempt_at`, with a partial
  index on unresolved rows so a stalled claim is cheap to find.

### `external_id` is validated before the claim

Printful caps it at 32 characters. A Medusa order id — `order_` plus a
26-character ULID — is exactly 32, with nothing to spare. A host app with a
longer id now fails loudly before anything is created, rather than having the
key silently truncated: a shortened key reads as a missing order and invites
the duplicate it was meant to prevent.

### Scopes

Unchanged, and narrower than they may look. The plugin reads Printful products
and never writes them, and never calls `/files` — file previews arrive inside
the sync product response. A token needs only **view orders**, **manage
orders**, **view products** and **manage webhooks**.

## 0.9.3

Fixes a crash that made the entire Medusa admin fail to load.

### Fixed

- **`chr.inherits is not a function` on admin load.** `src/utils/currency.ts`
  imported `defaultCurrencies` from `@medusajs/framework/utils`, and the admin
  order widget imports that file. The package reaches
  `@medusajs/utils/dist/auth/token.js` → `jsonwebtoken` → `jws`, which calls
  `util.inherits` — a Node API absent in browsers. The failure was total: not a
  broken widget, a blank admin.

The currency table is now written out in the module, with no package import.

### Why this was not caught

The import is valid TypeScript and the module exists; only the runtime
environment makes it wrong, so typecheck and the build were both green. The
file's own comment reasoned about the server — "`@medusajs/framework` is a peer
dependency, so the table is always present in a host app" — which is true, and
irrelevant to a file the browser also loads.

`tests/admin-bundle.test.ts` now walks every file reachable from `src/admin`
and fails on any server-only package import. Reintroducing the original line
fails it.

### The hand-written list is checked, not trusted

Taking the table from Medusa was the right instinct: a hand-kept list is how
HUF, ISK and CLP get missed. `currency.test.ts` now compares the built-in set
against `defaultCurrencies` in both directions — a missing code and an invented
one each fail — so the data still comes from Medusa while the import stays on
the server.

### Known limits

- **Six three-decimal currencies are still scaled by 100.** BHD, JOD, KWD, LYD,
  OMR and TND carry `decimal_digits: 3` in Medusa's table, and this code has
  only ever asked whether a currency is zero-decimal. Pre-existing, unchanged
  here, and recorded rather than quietly carried.

## 0.9.2

Merch bundles: one Medusa product that ships as several Printful ones.

### Added

- **Bundles as ordinary Medusa products.** A variant becomes a bundle by
  carrying `printful_bundle_members` in its metadata — a list of member
  variant ids and quantities. It gets its own page, price and images, and no
  new table.
- **Order expansion.** A bundle line is replaced by its members before the
  order reaches Printful.
- **A stock pass over bundles** during a full sync, so a bundle goes off sale
  when a member sells out and comes back when it returns.
- **A "Bundles" panel** on the Printful admin page, and
  **`GET /admin/printful/bundles`**.

### Configuring one

```jsonc
// on the bundle product's variant metadata
{
  "printful_bundle_members": [
    { "variant_id": "variant_01J...", "quantity": 1 },
    { "variant_id": "variant_01K...", "quantity": 2 },
  ],
}
```

### Why expansion is not optional

`create-printful-order` resolves one order line to one Printful item via
`variant_id`. A bundle left unexpanded ships one thing where the customer
bought three — and since a bundle variant has no Printful link of its own, the
order is skipped as `no_printful_items` and nothing ships at all.

Composition is read from the order line's own metadata, captured at purchase.
Editing a bundle after a sale does not change what an already-placed order
ships.

### A bundle is stricter about stock than a product

`planStockActions` drafts a product only when _every_ variant is gone, because
any remaining variant is still sellable. A bundle is a promise to ship all of
it, so one missing member already breaks the promise.

Publication goes through the same `resolvePublication` as everything else: the
plugin undoes only unpublishes it performed, and a draft you made yourself is
left alone.

### Known limits

- **Bundles are reconciled only on a full sync.** Under a `limit` most members
  go unrefreshed, and deciding availability from stale metadata would draft
  bundles on last week's stock.
- **A member the sync cannot load is treated as unknown, not gone.** If no
  member resolves at all, the pass writes nothing — republishing on the
  strength of a failed lookup would put a sold-out bundle back on sale.
- **Fulfillment is recorded against the bundle line, not per member.** Medusa
  has one line to fulfil, so a parcel holding two members counts once against
  it. Printful's per-item detail is preserved in the item `external_id`.
- **Bundle members are not checked at checkout.** A member that sells out
  between the last sync and the order still reaches Printful and fails there.

## 0.9.1

Mockup prompts, built from what Printful actually says about the product.

### Added

- **A "Mockup prompts" panel** on the Printful admin page: pick a style, say
  what the artwork is, copy a prompt per product.
- **`GET /admin/printful/prompts`** — a database read plus string assembly.

### What the plugin does and does not do here

**It writes prompts and stops.** Image generation happens wherever you paste
them, which keeps API keys, rate-limit queues and file storage out of a repo
that is otherwise a clean Printful-to-Medusa integration.

**Printful's own mockup generator does not cover this.** It renders a product
on a plain background — right for a catalogue thumbnail, wrong for the
editorial look these prompts target.

### Three shapes, because the products differ in kind

- **Apparel** — a model wearing it, the fabric named, styled with a companion
  garment chosen by how light the base colour is
- **Embroidery** — thread, never ink. The dad hat supports `EMBROIDERY` only,
  so a prompt calling it printed describes an object Printful cannot make. It
  is also framed head-and-shoulders rather than "full garment visible"
- **Print media** — an object on a wall. No model, no fabric, no base colour,
  and the variant's own size rather than the product's size table

The tote is neither worn nor printed on a chest: it is _carried_, and its
design sits on the front panel.

### What it refuses to invent

Every clause is dropped rather than defaulted when Printful did not report the
fact. The cap has no material in the catalog, so its prompt says nothing about
fabric — a guess of "cotton" would be a claim about the garment. A colour with
no hex gets no hex and no pairing: styling an unknown base colour is the same
error in a different place.

### Colour is the axis

A design ships across seven products every two weeks, and colour is what the
4–5 mockups per product vary along. Colours are picked for **spread across
lightness** rather than catalogue order — five near-identical heathers would
be five near-identical images.

Pairing is a table keyed by lightness band, not colour theory: a merchant can
read the file and predict what a new colour produces.

## 0.9.0

Design parameters: what a design becomes on each product.

### Added

- **A design panel on the Printful admin page.** Per product: what class it is,
  the technique that makes the design, where the design goes, base colour
  swatches with their hex, and sizes.
- **Design parameters stamped on every variant during sync**, read from
  `GET /products/variant/{id}` — public, no token needed. Colour and its hex,
  material with percentages, brand and model, techniques and placements.
- **`GET /admin/printful/design`** — a pure database read; the sync already
  paid for the catalog lookups.

### The three product classes

Derived from techniques and placements rather than a list of catalog ids, so
the eighth product a store adds is classified rather than misfiled:

| Class       | What it means                                                                             |
| ----------- | ----------------------------------------------------------------------------------------- |
| Apparel     | ink on fabric; base colour and material drive how the design reads                        |
| Embroidery  | **thread, not ink** — a cap supporting only EMBROIDERY must never be described as printed |
| Print media | paper and vinyl; physical size matters, base colour does not exist                        |

### Details that would otherwise mislead

- **A colour appears once**, though a tee reports it nine times — once per size.
- **A colour whose hex Printful never sent renders as absent, not black.** An
  invented hex is a claim about the garment.
- **A product no sync has enriched is omitted rather than shown empty.** "Never
  asked" and "nothing to show" are different states, and rendering them alike
  tells the owner something false about a product that is fine.
- **The catalog is read once per colour, not once per variant.** A tee with 84
  colours across 9 sizes costs 84 calls rather than 756; a 33-size colourless
  poster costs 1. Product-level facts are identical across variants, and the
  hex is identical across the sizes of a colour.

### Known limits

- **No print area geometry.** Pixel dimensions and DPI live in
  `/mockup-generator/printfiles/{id}` and `/templates/{id}`, both of which
  require a token and whose response schemas Printful does not publish. The
  panel is therefore qualitative — it says _where_ a design goes, not how large
  the printable region is. Tracked in #11.
- **A variant with no catalog variant id gets no design parameters.** Printful
  leaves `variant_id` null on manually-created sync variants and warehouse
  items. Such a variant imports and sells normally; only the design panel is
  quieter.

## 0.8.2

A dedicated Printful page in the admin, and a way out of a stuck sync.

### Added

- **A "Printful" section in the admin sidebar** gathering what previously had
  no home: sales figures, webhook health, sync history with live progress, and
  the stuck-sync recovery below. The clear button is offered on a client-side
  guess about the heartbeat and the server checks again — so a wrong guess
  costs a `409` and a "still alive" message, never a killed sync.
- **`GET /admin/printful/statistics`** — sales and profit from Printful's
  `/reports/statistics`. Unlike `/health` this one genuinely has to call
  Printful, so an outage answers `200` with an empty list rather than an error:
  the page fetches its panels independently and a throw here would blank the
  one screen an owner opens _because_ something is wrong.
- **`GET /admin/printful/history`** — recent sync runs, newest first (20 per
  page, `limit`/`offset`), with counters, progress and error message.
- **`GET /admin/printful/health`** — webhook delivery health: when the last
  event arrived, how many are `deferred` versus permanently `failed`, and
  whether a webhook is confirmed reaching the store. Answered entirely from
  local rows and plugin options — it makes **no** call to Printful, so the one
  page you check during a Printful outage still renders during one.
- **`POST /admin/printful/sync/clear`** — clear a sync stuck in `running`,
  closing the limit recorded in 0.4.0. Previously a crashed sync blocked the
  catalogue for up to `syncStaleMinutes` (default 60) with no way to intervene.

  Two guards, because the operation is destructive: the request must carry
  `{ "confirm": "clear-stuck-sync" }`, and the server independently verifies
  the heartbeat really is stale — a sync that is still checking in returns
  `409` and is left alone. The write is conditional on the heartbeat the
  request observed, so a sync that revives between the check and the write is
  not marked failed underneath a live process.

  A row cleared this way records `cleared_by_operator` plus how long the sync
  had been silent, so it is never confused with the `stale_running` marker the
  timeout reaper writes.

### Known limits

- **A sub-millisecond race remains in the clear path.** The heartbeat check and
  the write are two statements rather than one atomic `UPDATE ... WHERE`. To
  hit it, a sync would have to be silent for the full stale window and then
  revive in that exact instant. The loser is a `failed` row under a live sync,
  which the next claim reaps normally. Closing it fully means dropping to raw
  SQL, which this module does only for `pg_advisory_xact_lock`.
- **`registered` in the health response is evidence-based, not authoritative.**
  It requires both a configured secret and a delivered event, so a store with a
  secret but nothing received reads "configured, nothing received yet" — which
  is exactly the state a misconfigured webhook leaves behind.
- **History and health have no route-level integration tests** — unit tests on
  the extracted helpers plus service-level integration coverage, matching how
  `status` and `sync` are already tested.

## 0.8.1

Publishing moves to CI.

### Changed

- **Releases publish from a version tag**, not from a maintainer's machine.
  Pushing `vX.Y.Z` runs the full suite — format, both typechecks, unit and
  integration against a real Postgres, build — and only then publishes. The
  tarball therefore comes from a checkout that passed, rather than whatever
  happened to be on the publisher's disk.
- The workflow **refuses to publish** when the tag and `package.json` disagree,
  or when that version already exists on npm. Both were previously ways to put
  a wrong or duplicate version on the registry with no signal until afterwards.
- Published with **`--provenance`**, so npm records the repository, commit and
  workflow that built the package.

Requires an `NPM_TOKEN` repository secret. See the release section in the
README.

## 0.8.0

Catalog hygiene, easier installs, and storefront guidance for sold-out variants.

### Added

- **`onRemovedFromPrintful`** (`"unpublish"` \| `"ignore"`, default `"unpublish"`).
  After a **full** sync, products that still have a link row but no longer
  appear in the Printful store catalogue are set to `draft` and marked with
  `printful_removed` + `printful_stock_status: "unavailable"`. A later re-add
  and sync can republish them. Partial syncs (`limit`) never run this pass —
  that would treat the unfetched rest of the catalogue as deleted.
- **[Storefront availability guide](https://github.com/legenki/print2medusa/blob/main/docs/storefront-availability.md)** —
  how to read `printful_availability_status` so a sold-out size is not still
  orderable when `manage_inventory` is false.

### Changed

- **Peer dependencies are `^2.18.0`** (and `^4.2.0` for `@medusajs/ui`) so a
  host on 2.19+ can install without an exact-pin fight. DevDependencies stay
  pinned for reproducible CI builds of this package.

### Fixed

- Removal markers are cleared when a product is seen on Printful again during
  a normal update sync.

## 0.7.0

Printful now ships the method the customer paid for.

### Fixed

- **The selected shipping method reaches Printful.** Orders were created with no
  `shipping` override, so Printful chose its own method regardless of what the
  customer selected and paid for — the delivery speed sold and the cost incurred
  could both differ from what was quoted.

  0.3.0 attempted this and shipped dead code: it stamped fields onto the object
  returned by `calculatePrice`, which Medusa discards — it reads only
  `calculated_amount` and `is_calculated_price_tax_inclusive` from a calculated
  price. That attempt needed a type cast to compile and was removed rather than
  left looking functional.

  The method is now confirmed in `validateFulfillmentData`, which receives the
  whole cart and whose return value Medusa persists verbatim onto the shipping
  method and then onto the order.

- **Every Printful request has a deadline.** Node's `fetch` bounds headers and
  body at 300 seconds each and imposes no overall deadline, so a Printful that
  hung rather than failed could stall a request indefinitely — four times over,
  once per retry. Tolerable on a background sync; not on the confirmation call,
  which runs inside the customer's own request. Now 15 seconds per attempt.

### The rule that governs it

**A `shipping` override is sent only when Printful itself confirmed that method
for this cart.** A fallback price was never confirmed by Printful, so insisting
on that method risks an order Printful rejects — worse than letting Printful
choose. Confirmation failure is always soft: checkout proceeds exactly as before,
and the order is created with no override.

`shipping_method.data` records the outcome: `printful_shipping` and
`rate_source: "live"` on success, or `rate_source` naming the reason
(`printful_unreachable`, `method_unavailable`, `currency_mismatch`,
`no_printful_items`, `query_unavailable`) on failure. The order path is a pure
read of that record — no Printful call when the order is created.

A **stale cache entry never confirms**, and a failed re-fetch does not fall back
to one. A stale price is defensible; a stale method confirmation is not, because
the method may no longer be offered.

### Known limits

- **The price shown and the method confirmed can disagree.** The cart may have
  priced from a flat or stale-cache fallback while confirmation moments later
  succeeded live. The customer is then charged an amount that is not the live
  quote, for a method that is. Both halves are individually honest, and it needs
  a failure at pricing time followed by a success seconds later. Re-pricing on
  selection is a separate decision.
- **Selecting a method costs one Printful call on a cache miss.** Bounded — once
  per selection, not per cart refresh — and the common case is a fresh-cache hit,
  because pricing populated that exact key moments earlier.
- **Confirmation needs `dependencies: ["query"]`**, the same requirement live
  rates already have. Without it, confirmation soft-fails to no override.
- **A cart mixing shipping profiles is not narrowed.** Medusa hands the pricing
  path only the items under the option's profile but hands the confirmation path
  the whole cart, and the option's profile id is not among the arguments the
  provider receives. Both paths use the same unfiltered lines, so they agree with
  each other; the quote for a mixed cart simply includes non-Printful items.

## 0.6.0

Money is scaled by the currency instead of always by 100.

### Fixed

Most currencies have 100 minor units to the major unit — $12.34 stores as
`1234`. Zero-decimal currencies have none: ¥1500 is fifteen hundred yen, and
Medusa stores `1500`. The plugin multiplied by 100 regardless, so a store
selling in JPY, KRW, HUF, ISK, CLP or any of the other 38 zero-decimal
currencies got values a hundredfold wrong.

Five places crossed between major and minor units. All now consult the
currency, using Medusa's own `defaultCurrencies` table rather than a
hand-written list:

- **Order costs** stored on the Medusa order
- **Catalog prices** written during sync — this one had no compensating error
  anywhere, so a JPY store's product prices were simply wrong
- **The order page**, which divided by 100 unconditionally. This cancelled the
  cost error, which is why the order page looked correct while the stored data
  was not
- **Shipping rates** returned to Medusa from a Printful quote
- **Cart line values sent to Printful** when requesting a quote, which
  under-reported a JPY cart's value by 100× and affects both the rate Printful
  calculates and the customs value it declares

### Added

- **`printful_money_scale` on order metadata.** Orders stamped before 0.6.0
  carry no marker, and nothing in the data distinguishes a JPY order holding
  `150000` from a correct `150000` in a currency that has minor units. The
  order page reads the marker and keeps the old rule for unmarked orders, so
  they still display correctly.

### Upgrading

**Nothing migrates automatically, by design.** A store that has only ever sold
in USD, EUR or any other two-decimal currency has nothing wrong and needs to do
nothing.

If you have sold in a zero-decimal currency:

- **Order costs** correct themselves the next time a webhook re-reads the
  order, which restamps both the amounts and the marker.
- **Catalog prices** correct themselves on the next sync.
- Values written before this release stay as they are until then. A blind
  division by 100 was deliberately not shipped: it would corrupt anything a
  merchant had already corrected by hand, and there is no way to tell the two
  apart.

## 0.5.3

Order visibility and honest sync reporting, from a second external review.

### Fixed

- **The Printful panel appears as soon as the order is created.** The create
  path wrote only cost keys, but the order widget gates on
  `printful_order_id` — so the order existed in Printful, its costs were
  stored, and the merchant saw nothing until the first webhook arrived.
- **A sync with failures no longer reports success.** The old rule demanded
  zero creates _and_ zero updates before calling a run failed, so 100 failures
  beside one successful update showed a green sync. Such a run is now
  `partial`.
- **A fee Printful stops reporting is cleared.** Fee keys were merged per-key,
  so a shipping fee that dropped out of a later response kept its old value
  beside a fresh total. A refresh now clears the fee keys it did not write.
- **The create path takes the same advisory lock as webhooks.** Both do a
  read-modify-write of order metadata, and a webhook arriving between the link
  becoming resolvable and this write could have its newer `printful_status`
  clobbered back to the status captured at creation.

### Known limits

- **Zero-decimal currencies are wrong in more places than 0.5.0 recorded.**
  `parsePriceToMinorUnits` — which prices the **catalog** — carries the same
  unconditional ×100 as the cost converter, so a JPY Printful store gets
  product prices a hundredfold too large as well. **Fixed in 0.6.0.**

## 0.5.2

Closes the known limit 0.5.1 left open.

### Fixed

- **A variant whose link row failed to write is repaired on the next sync.**
  The update path only refreshed link rows it already found, and
  `diffVariantsForUpsert` matches on variant metadata rather than link rows —
  so a variant that lost its row looked already-synced and was never written
  again. It stayed permanently unlinked, and order creation resolves
  `sync_variant_id` through those rows, so a customer ordering it could fail to
  map. The sync now creates any missing link whose Medusa variant carries the
  matching `printful_sync_variant_id`.
- **Variant linking is resumable instead of best-effort.** A failure part-way
  through used to abandon every remaining variant for that product, and because
  the product's own link row already existed, the next sync took the update
  path and never went back for them. One unwritable row now costs only that
  row.

## 0.5.1

Two correctness fixes found by an external review of the released code, both
in the catalog sync.

### Fixed

- **A product you drafted by hand is no longer re-published by the next sync.**
  `resolvePublication` was written and unit-tested in 0.4.0 but **never
  called** — the sync force-set status from Printful stock alone. The plugin
  now marks the products it unpublishes for being sold out, and re-publishes
  only those, leaving a merchant's own draft alone. A product created while
  sold out is marked too, so it is republished when it comes back.
- **A product created but never linked is no longer stranded.** If the link
  write failed, the per-product error handler swallowed it and the sync step
  still succeeded — and compensation only runs when a step _fails_, so the
  orphan was never deleted. The next sync could not see it either, so it
  created a duplicate. The failing product is now cleaned up where the error is
  caught.
- **A return shipping option can now be used.** `validateOption` accepted
  `PRINTFUL_RETURN` and `canCalculate` excluded it from live rates on purpose,
  but `validateFulfillmentData` rejected it — so the option could be created
  and priced, never added to a cart.

### Docs

- The ROADMAP intro said live rates, stock and taxes "remain unwired" at
  version 0.5.0. Rewritten to say what is actually shipped, what is not, and
  why returns are held to 1.0.0.
- The README install snippet omitted `liveShippingRates`,
  `fallbackShippingRates` and `dependencies: ["query"]`. Without the last one
  every quote silently falls back to the flat rate.

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
- **Zero-decimal currencies are stored 100× too large.** A ¥1500 order stores
  `printful_cost_total: 150000`, because JPY, KRW and the other ISO 4217
  exponent-0 currencies have no minor unit. The order page displays the correct
  figure — it divides by 100, cancelling the error — but any other reader of
  that metadata gets a hundredfold overstatement. **Fixed in 0.6.0**, which
  scales by the currency and stamps `printful_money_scale` so values written
  before it can still be read correctly.
- **The per-fee breakdown can drift from the total.** Fee keys are merged
  per-key, so a fee absent from a later Printful response keeps its previous
  value beside a fresh total. The order page shows only the two totals and the
  margin, which are always written together, and never the breakdown.
  **Fixed in 0.5.3.**
- **An unparseable fee is indistinguishable from a fee of zero** — both simply
  omit the key. An unparseable _total_ is handled properly: it suppresses the
  margin rather than fabricating one.
- **Returns are not implemented.** Printful API v1 has no endpoint for creating
  a return or generating a return label — only a `package_returned` webhook
  reporting one that already happened. `createReturnFulfillment` therefore
  remains a stub. Real returns need API v2 and are deferred to 1.0.0.
- **No tax provider.** `/tax/rates` exists in Printful API v1, but its request
  and response contract is undocumented, so `ITaxProvider` is deferred until
  the contract can be established against the live API.

## 0.4.0

The catalog sync runs in the background, one at a time, and Printful stock
decides whether a product is published.

### Added

- **Background sync.** `POST /admin/printful/sync` responds `202 {sync_id}`
  immediately instead of holding the request open for the whole catalog. The
  admin widget polls progress and disables **Sync Now** while a sync runs.
- **One sync at a time.** A second request gets `409` with the running sync's
  `started_at`; the scheduled job skips quietly. Enforced by a partial unique
  index on `status = 'running'` rather than a check-then-insert, so a
  double-click cannot start two syncs.
- **Stale claim recovery.** A sync whose process died is reclaimed after
  `syncStaleMinutes` (default 60) by the next sync attempt.
- **Stock-driven publication.** A product with no available variant is set to
  `draft` and republished on restock. Only products the plugin unpublished are
  republished — a draft you set by hand stays draft.
- **Discontinued marker.** `printful_discontinued` in product metadata, and
  `printful_availability_status` per variant. `onDiscontinued: "ignore"` turns
  the marker off (it does not turn off hiding).
- **Rollback of half-created products.** Products created but not yet linked are
  deleted if the sync fails, so a crash leaves nothing stranded.
- Options: `syncStaleMinutes`, `onDiscontinued`.

### Known limits

- **Recovery is lazy, not scheduled.** After a crash the sync log stays
  `running` and the widget shows a sync that is not alive. Nothing reclaims it
  until the next sync attempt, so with the default 60 minutes a crash shortly
  after the nightly job means the catalog is blocked until someone tries again.
  _(Addressed in Unreleased by `POST /admin/printful/sync/clear`, which lets an
  operator clear a stuck sync without waiting out the window.)_
- **No resume.** A reclaimed sync restarts from the beginning of the catalog
  rather than continuing where it stopped.
- **The compensation is unit-tested, not integration-tested.** Which products a
  failed sync may delete is covered by `tests/orphans.test.ts`, but the
  end-to-end rollback is not exercised against a live database:
  `createProductsWorkflow` transitively needs the Inventory module, remote
  links, sales-channel association and the event bus, and `@medusajs/product`'s
  initial migration branches on a live query result, which the plugin test
  harness cannot run.

## 0.3.0

Shipping is priced from Printful's live rates instead of by hand.

### Breaking

- **Fulfillment option ids are now Printful's own method ids.** `printful-standard`
  and `printful-return` are replaced by `STANDARD` and `PRINTFUL_RETURN`, because
  the old ids matched nothing Printful returns and could never price from a live
  quote.

  **A shipping option created against an old id will price at zero — free
  shipping — until you recreate it.** The plugin logs an error naming the option
  each time it happens, but nothing blocks checkout, because Medusa cannot
  complete a cart whose shipping price fails to resolve.

- **Live rates require `dependencies: ["query"]`** on the `@medusajs/medusa/fulfillment`
  module. See the README. Without it every quote falls back to the flat rate.

### Added

- Live shipping rates via `POST /shipping/rates`, behind the `liveShippingRates` option
- Rate caching through Medusa's caching module, with a stale tier that outranks the flat fallback — a day-old real quote beats a typed-in constant
- One Printful call serves every shipping option on a cart; the whole response is cached and each option is selected from it locally
- Australian state codes in `resolveStateCode` — Printful requires `state_code` for AU as well as US and CA, and quotes were going out without it
- `fallbackShippingRates`, `shippingRateCacheTtlSeconds`, and `shippingRateStaleSeconds` options

### Fixed

- `calculatePrice` never throws. Medusa blocks checkout when it does, so a Printful outage no longer prevents customers completing an order
- Rate and catalog-id strings are validated in full rather than through `parseFloat`/`parseInt`, which accepted `"-4.99"` as a negative price and turned catalog id `"40.12"` into variant `40` — a quote for a different product
- The rate cache key hashes a JSON array rather than a delimiter-joined string, so a `|` typed into an address field can no longer collide two different addresses onto one quote
- Configured rates are read as own properties and type-checked, so a shipping option named `toString` no longer returns a function as the price
- A malformed cache entry is treated as a miss instead of throwing before the API call, where it would have pinned every matching cart to the flat rate for the full stale window while Printful was healthy

### Known limits

- The shipping method the customer selected is not passed to Printful, which picks its own. Medusa does not carry provider data from price calculation onto the shipping method; closing this needs a different mechanism and its own release. **Fixed in 0.7.0**, by confirming the method in `validateFulfillmentData` instead.
- Return shipping options are never priced live — Printful quotes outbound shipping only.

## 0.2.0

Printful order state now flows back into Medusa, so customers see tracking and
store owners see failures without opening the Printful dashboard.

### Added

- **Webhook endpoint** `POST /hooks/printful/:token` for `package_shipped`, `order_failed`, `order_canceled`, and `package_returned`
- **Medusa fulfillment and shipment per parcel**, with tracking number and carrier URL. Printful splits orders across facilities, so each parcel gets its own fulfillment covering only its line items
- **`printful_webhook_event` log** — every inbound event stored with a derived `event_id` under a unique index, which is what absorbs Printful's redeliveries
- **Scheduled retry job** every 5 minutes for events that arrived before their order link existed, with exponential backoff to a 6-hour cap and a 20-attempt limit
- **Admin order widget** showing Printful status and per-parcel tracking; reshipments are marked distinctly
- **Webhook configuration route** `GET`/`POST /admin/printful/webhook`, warning that Printful replaces the whole config on save
- Integration tests against real Postgres covering redelivery absorption, the retry query's filter operators, and that a forged payload creates nothing

### Security

- The payload is a **trigger, not a source of truth**. Printful API v1 does not sign webhooks, so every decision comes from re-reading `GET /orders/{id}`
- Constant-time token comparison; a bad token returns `404`, never `401`
- The secret is redacted from `req.path` before Medusa's error handler can log it, and the body-parser limit is sized so real deliveries never trip a 413 that would bypass that redaction
- `canonicalize` is depth-limited, so a deeply nested payload cannot overflow the stack

### Fixed

- Per-order **transaction-scoped advisory lock**. The session-scoped variant leaked under Medusa's connection pooling — lock and unlock could land on different pooled connections, turning a rare duplicate into a permanent hang
- `isUniqueViolation` now recognizes the `MedusaError` that `dbErrorMapper` substitutes for a raw 23505, without which **every redelivered webhook returned 500**

## 0.1.1

### Fixed

- Re-sync now **upserts product variants** (price + new variants), not just core product fields
- Printful order creation is **insert-first** to prevent duplicate orders on concurrent `payment.captured` events
- Shipping `province` is mapped to the ISO `state_code` Printful requires for US/CA (avoids rejected orders)
- Placeholder order link is released if the Printful API call fails, so retries are not permanently blocked

## 0.1.0

### Added

- Printful client (API v1) with retry / rate-limit handling
- Plugin module with product/variant/order links and sync logs
- `printful-sync-products` workflow (Store Products → Medusa)
- `printful-create-order` workflow (Medusa order → Printful via `sync_variant_id`)
- Subscribers: `payment.captured` (primary), optional `order.placed`
- Fulfillment provider `printful-fulfillment`
- Admin routes `POST /admin/printful/sync`, `GET /admin/printful/status`
- Admin widget “Sync Now” on product list
- Optional scheduled daily sync job
- Unit tests for client and mappers
