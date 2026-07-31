# Webhooks and Order Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Printful order state (shipments, failures, holds) flows back into Medusa so customers see tracking and store owners see problems.

**Architecture:** A public route stores the raw webhook and returns `200` immediately; a workflow running outside the HTTP lifecycle re-reads `GET /orders/{id}` and applies the real state. The payload is never trusted — it only names which order to inspect. A retry job drains events that arrived before their order link existed.

**Tech Stack:** Medusa v2.18 (workflows-sdk, core-flows, MedusaService), TypeScript, Vitest, Postgres (advisory locks, partial unique indexes).

**Spec:** `docs/superpowers/specs/2026-07-31-webhooks-order-status-design.md`
**Issue:** [#2](https://github.com/legenki/print2medusa/issues/2)

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/utils/webhook-events.ts` | Pure functions: `deriveEventId`, `payloadFingerprint`, `verifyWebhookToken`, event type constants |
| `src/utils/order-state.ts` | Pure function: `planOrderStateActions` — turns a Printful order into a list of intended actions |
| `src/modules/printful/models/printful-webhook-event.ts` | The event log model |
| `src/modules/printful/migrations/Migration20260731000000.ts` | New table + reverse index on `printful_order_link` |
| `src/api/hooks/printful/[token]/route.ts` | Public webhook endpoint |
| `src/workflows/apply-order-status.ts` | Reads Printful order, applies fulfillments/shipments/metadata |
| `src/jobs/retry-webhook-events.ts` | Drains `received`/`deferred` events on a schedule |
| `src/admin/widgets/printful-order-widget.tsx` | Order-page status and tracking |
| `tests/webhook-events.test.ts` | Unit tests for token + event id derivation |
| `tests/order-state.test.ts` | Unit tests for action planning |

**Modify:**

| File | Change |
|---|---|
| `src/utils/types.ts` | Webhook payload and config types |
| `src/utils/printful-client.ts` | `getWebhookConfig`, `setWebhookConfig`, `disableWebhook` |
| `src/modules/printful/service.ts` | Event CRUD, `findOrderLinkByPrintfulId`, advisory lock helper |
| `src/api/admin/printful/webhook/route.ts` | New admin route for config read/write |

Pure logic lives in `src/utils/` so it can be tested without a Medusa container. Everything that touches the container stays in workflows, routes, and the service.

---

## Task 1: Webhook token verification

**Files:**
- Create: `src/utils/webhook-events.ts`
- Test: `tests/webhook-events.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { verifyWebhookToken } from "../src/utils/webhook-events"

describe("verifyWebhookToken", () => {
  it("accepts a matching token", () => {
    expect(verifyWebhookToken("s3cret", "s3cret")).toBe(true)
  })

  it("rejects a wrong token of the same length", () => {
    expect(verifyWebhookToken("s3cret", "s3crXt")).toBe(false)
  })

  it("rejects tokens of differing length without throwing", () => {
    expect(verifyWebhookToken("s3cret", "s3")).toBe(false)
    expect(verifyWebhookToken("s3cret", "s3cret-and-more")).toBe(false)
  })

  it("rejects when the configured secret is missing", () => {
    expect(verifyWebhookToken(undefined, "anything")).toBe(false)
    expect(verifyWebhookToken("", "anything")).toBe(false)
  })

  it("rejects when the provided token is missing", () => {
    expect(verifyWebhookToken("s3cret", undefined)).toBe(false)
    expect(verifyWebhookToken("s3cret", "")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook-events.test.ts`
Expected: FAIL with "verifyWebhookToken is not a function"

- [ ] **Step 3: Write minimal implementation**

```typescript
import { createHash, timingSafeEqual } from "crypto"

/**
 * Constant-time comparison of the configured secret against the token supplied
 * in the request path. Both sides are hashed first so differing lengths cannot
 * throw and cannot leak length through timing.
 */
export function verifyWebhookToken(
  configured: string | null | undefined,
  provided: string | null | undefined
): boolean {
  if (!configured || !provided) {
    return false
  }
  const a = createHash("sha256").update(configured).digest()
  const b = createHash("sha256").update(provided).digest()
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook-events.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/webhook-events.ts tests/webhook-events.test.ts
git commit -m "feat: constant-time webhook token verification

Refs #2"
```

---

## Task 2: Event id derivation

**Files:**
- Modify: `src/utils/webhook-events.ts`
- Test: `tests/webhook-events.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/webhook-events.test.ts`:

```typescript
import { deriveEventId, PRINTFUL_WEBHOOK_TYPES } from "../src/utils/webhook-events"

describe("deriveEventId", () => {
  const shipped = {
    type: "package_shipped",
    created: 1735689600,
    data: {
      order: { id: 777 },
      shipment: { id: 5001, tracking_number: "1Z999" },
    },
  }

  it("is stable for an identical payload", () => {
    expect(deriveEventId(shipped)).toBe(deriveEventId({ ...shipped }))
  })

  it("distinguishes two shipments of the same order", () => {
    const second = {
      ...shipped,
      data: { ...shipped.data, shipment: { id: 5002, tracking_number: "1Z888" } },
    }
    expect(deriveEventId(shipped)).not.toBe(deriveEventId(second))
  })

  it("distinguishes two order_updated events by updated timestamp", () => {
    const a = { type: "order_updated", created: 1, data: { order: { id: 9, updated: 100 } } }
    const b = { type: "order_updated", created: 1, data: { order: { id: 9, updated: 200 } } }
    expect(deriveEventId(a)).not.toBe(deriveEventId(b))
  })

  it("treats order_failed as one event per order", () => {
    const a = { type: "order_failed", created: 10, data: { order: { id: 9 } } }
    const b = { type: "order_failed", created: 10, data: { order: { id: 9 } } }
    expect(deriveEventId(a)).toBe(deriveEventId(b))
  })

  it("falls back to a payload fingerprint for unknown types", () => {
    const a = { type: "some_future_event", data: { order: { id: 3 }, extra: "a" } }
    const b = { type: "some_future_event", data: { order: { id: 3 }, extra: "b" } }
    expect(deriveEventId(a)).not.toBe(deriveEventId(b))
  })

  it("is insensitive to key order in the payload", () => {
    const a = { type: "x", data: { order: { id: 1 }, p: 1, q: 2 } }
    const b = { type: "x", data: { q: 2, order: { id: 1 }, p: 1 } }
    expect(deriveEventId(a)).toBe(deriveEventId(b))
  })

  it("exposes the subscribed type allowlist", () => {
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("package_shipped")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("order_failed")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("order_canceled")
    expect(PRINTFUL_WEBHOOK_TYPES).toContain("package_returned")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook-events.test.ts`
Expected: FAIL with "deriveEventId is not a function"

- [ ] **Step 3: Write minimal implementation**

Append to `src/utils/webhook-events.ts`:

```typescript
/** Event types we register with Printful. order_updated is noisy and opt-in. */
export const PRINTFUL_WEBHOOK_TYPES = [
  "package_shipped",
  "order_failed",
  "order_canceled",
  "package_returned",
] as const

export type PrintfulWebhookPayload = {
  type?: string
  created?: number
  retries?: number
  store?: number
  data?: Record<string, unknown>
}

/** Deterministic JSON with sorted keys, so key order cannot change the hash. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(",")}}`
}

export function payloadFingerprint(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex")
}

export function extractOrderId(payload: PrintfulWebhookPayload): string {
  const order = payload.data?.order as { id?: number | string } | undefined
  return order?.id != null ? String(order.id) : ""
}

export function extractShipmentId(
  payload: PrintfulWebhookPayload
): string | null {
  const shipment = payload.data?.shipment as { id?: number | string } | undefined
  return shipment?.id != null ? String(shipment.id) : null
}

/**
 * Printful v1 sends no stable event identifier, so we derive one. The
 * discriminator varies by type: shipments must not collapse into one event,
 * while a terminal order_failed is one event per order.
 */
export function deriveEventId(payload: PrintfulWebhookPayload): string {
  const type = payload.type ?? "unknown"
  const orderId = extractOrderId(payload)
  const order = payload.data?.order as { updated?: number | string } | undefined

  let discriminator: string
  switch (type) {
    case "package_shipped":
    case "package_returned":
      discriminator = extractShipmentId(payload) ?? payloadFingerprint(payload)
      break
    case "order_updated":
      discriminator = order?.updated != null ? String(order.updated) : payloadFingerprint(payload)
      break
    case "order_failed":
    case "order_canceled":
      discriminator = ""
      break
    default:
      discriminator = payloadFingerprint(payload)
  }

  const timeKey =
    payload.created != null ? String(payload.created) : payloadFingerprint(payload)

  return createHash("sha256")
    .update(`${type}|${orderId}|${discriminator}|${timeKey}`)
    .digest("hex")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook-events.test.ts`
Expected: PASS, 12 tests total

- [ ] **Step 5: Commit**

```bash
git add src/utils/webhook-events.ts tests/webhook-events.test.ts
git commit -m "feat: derive stable event ids for Printful v1 webhooks

Refs #2"
```

---

## Task 3: Order state action planner

**Files:**
- Create: `src/utils/order-state.ts`
- Test: `tests/order-state.test.ts`

This is the decision core. It takes a Printful order (from `GET /orders/{id}`, never
from the webhook payload) and returns what should happen, without performing it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { planOrderStateActions } from "../src/utils/order-state"
import type { PrintfulOrder } from "../src/utils/types"

const base: PrintfulOrder = { id: 777, status: "pending" }

describe("planOrderStateActions", () => {
  it("plans no shipment work for a pending order", () => {
    const plan = planOrderStateActions(base, [])
    expect(plan.shipments).toHaveLength(0)
    expect(plan.metadata.printful_status).toBe("pending")
  })

  it("plans one shipment per unrecorded package", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, carrier: "USPS", service: "Priority", tracking_number: "A1" },
        { id: 2, carrier: "DHL", service: "Express", tracking_number: "B2" },
      ],
    }
    const plan = planOrderStateActions(order, [])
    expect(plan.shipments.map((s) => s.printful_shipment_id)).toEqual(["1", "2"])
    expect(plan.shipments[0].tracking_number).toBe("A1")
  })

  it("skips shipments already recorded in Medusa", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 1, tracking_number: "A1" },
        { id: 2, tracking_number: "B2" },
      ],
    }
    const plan = planOrderStateActions(order, ["1"])
    expect(plan.shipments.map((s) => s.printful_shipment_id)).toEqual(["2"])
  })

  it("plans nothing when every shipment is recorded", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [{ id: 1, tracking_number: "A1" }],
    }
    expect(planOrderStateActions(order, ["1"]).shipments).toHaveLength(0)
  })

  it("records a failed order without touching the order", () => {
    const plan = planOrderStateActions({ ...base, status: "failed" }, [])
    expect(plan.shipments).toHaveLength(0)
    expect(plan.metadata.printful_status).toBe("failed")
    expect(plan.needsAttention).toBe(true)
  })

  it("flags canceled and onhold as needing attention", () => {
    expect(planOrderStateActions({ ...base, status: "canceled" }, []).needsAttention).toBe(true)
    expect(planOrderStateActions({ ...base, status: "onhold" }, []).needsAttention).toBe(true)
  })

  it("does not flag ordinary in-progress states", () => {
    expect(planOrderStateActions({ ...base, status: "inprocess" }, []).needsAttention).toBe(false)
    expect(planOrderStateActions({ ...base, status: "fulfilled" }, []).needsAttention).toBe(false)
  })

  it("carries shipment details into metadata", () => {
    const order: PrintfulOrder = {
      ...base,
      status: "fulfilled",
      shipments: [
        { id: 3, carrier: "UPS", service: "Ground", tracking_number: "C3", tracking_url: "http://t/C3", ship_date: "2026-07-31" },
      ],
    }
    const meta = planOrderStateActions(order, []).metadata
    expect(meta.printful_shipments).toEqual([
      { id: "3", carrier: "UPS", service: "Ground", tracking_number: "C3", tracking_url: "http://t/C3", ship_date: "2026-07-31" },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/order-state.test.ts`
Expected: FAIL with "planOrderStateActions is not a function"

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { PrintfulOrder } from "./types"

export type PlannedShipment = {
  printful_shipment_id: string
  carrier?: string
  service?: string
  tracking_number?: string
  tracking_url?: string
  ship_date?: string
}

export type OrderStatePlan = {
  shipments: PlannedShipment[]
  metadata: Record<string, unknown>
  needsAttention: boolean
}

/** Printful states that mean a human should look at the order. */
const ATTENTION_STATES = new Set(["failed", "canceled", "onhold"])

/**
 * Decide what should happen for a Printful order, given which shipments Medusa
 * has already recorded. Pure: performs nothing, returns intent.
 *
 * The caller passes the order fetched from GET /orders/{id} — never the webhook
 * payload, which is untrusted.
 */
export function planOrderStateActions(
  order: PrintfulOrder,
  recordedShipmentIds: string[]
): OrderStatePlan {
  const recorded = new Set(recordedShipmentIds.map(String))

  const allShipments: PlannedShipment[] = (order.shipments ?? []).map((s) => ({
    printful_shipment_id: String(s.id),
    carrier: s.carrier,
    service: s.service,
    tracking_number: s.tracking_number,
    tracking_url: s.tracking_url,
    ship_date: s.ship_date,
  }))

  return {
    shipments: allShipments.filter(
      (s) => !recorded.has(s.printful_shipment_id)
    ),
    metadata: {
      printful_order_id: String(order.id),
      printful_status: order.status,
      printful_status_updated_at: new Date().toISOString(),
      printful_shipments: allShipments.map((s) => ({
        id: s.printful_shipment_id,
        carrier: s.carrier,
        service: s.service,
        tracking_number: s.tracking_number,
        tracking_url: s.tracking_url,
        ship_date: s.ship_date,
      })),
    },
    needsAttention: ATTENTION_STATES.has(order.status),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/order-state.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/order-state.ts tests/order-state.test.ts
git commit -m "feat: plan Medusa actions from Printful order state

Refs #2"
```

---

## Task 4: Webhook config types and client methods

**Files:**
- Modify: `src/utils/types.ts`
- Modify: `src/utils/printful-client.ts`
- Test: `tests/printful-client.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("PrintfulClient", ...)` block in `tests/printful-client.test.ts`:

```typescript
  it("reads the webhook config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 200,
        result: { url: "https://shop.test/hooks/printful/tok", types: ["package_shipped"] },
      })
    )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    const config = await client.getWebhookConfig()

    expect(config.url).toBe("https://shop.test/hooks/printful/tok")
    expect(config.types).toEqual(["package_shipped"])
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/webhooks")
  })

  it("replaces the whole webhook config on set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ code: 200, result: { url: "https://shop.test/h", types: ["order_failed"] } })
    )
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.setWebhookConfig("https://shop.test/h", ["order_failed"])

    const [, init] = fetchImpl.mock.calls[0]
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.url).toBe("https://shop.test/h")
    expect(body.types).toEqual(["order_failed"])
  })

  it("disables the webhook config", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 200, result: { url: null, types: [] } }))
    const client = new PrintfulClient({
      apiToken: "token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    })

    await client.disableWebhook()

    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/printful-client.test.ts`
Expected: FAIL with "client.getWebhookConfig is not a function"

- [ ] **Step 3: Write minimal implementation**

Append to `src/utils/types.ts`:

```typescript
export type PrintfulWebhookConfig = {
  url: string | null
  types: string[]
  params?: Record<string, unknown>
}
```

Add to the `PrintfulClient` class in `src/utils/printful-client.ts`, after `cancelOrder`:

```typescript
  async getWebhookConfig(): Promise<PrintfulWebhookConfig> {
    const data = await this.request<PrintfulWebhookConfig>("/webhooks")
    return data.result
  }

  /**
   * Printful v1 keeps a single webhook configuration per store, so this
   * replaces the URL and the entire type list. Always pass the full allowlist.
   */
  async setWebhookConfig(
    url: string,
    types: string[]
  ): Promise<PrintfulWebhookConfig> {
    const data = await this.request<PrintfulWebhookConfig>("/webhooks", {
      method: "POST",
      body: JSON.stringify({ url, types }),
    })
    return data.result
  }

  async disableWebhook(): Promise<PrintfulWebhookConfig> {
    const data = await this.request<PrintfulWebhookConfig>("/webhooks", {
      method: "DELETE",
    })
    return data.result
  }
```

Add `PrintfulWebhookConfig` to the type import at the top of `printful-client.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/printful-client.test.ts`
Expected: PASS, 8 tests total

- [ ] **Step 5: Commit**

```bash
git add src/utils/types.ts src/utils/printful-client.ts tests/printful-client.test.ts
git commit -m "feat: Printful webhook configuration client methods

Refs #2"
```

---

## Task 5: Event model and migration

**Files:**
- Create: `src/modules/printful/models/printful-webhook-event.ts`
- Create: `src/modules/printful/migrations/Migration20260731000000.ts`

No test step: models and SQL are verified by the integration tests in Task 9 and by
`npm run build`.

- [ ] **Step 1: Create the model**

```typescript
import { model } from "@medusajs/framework/utils"

const PrintfulWebhookEvent = model.define("printful_webhook_event", {
  id: model.id().primaryKey(),
  event_id: model.text(),
  type: model.text(),
  printful_order_id: model.text(),
  printful_shipment_id: model.text().nullable(),
  payload: model.json(),
  status: model.text().default("received"),
  attempts: model.number().default(0),
  next_retry_at: model.dateTime().nullable(),
  processed_at: model.dateTime().nullable(),
  error_message: model.text().nullable(),
})

export default PrintfulWebhookEvent
```

- [ ] **Step 2: Create the migration**

```typescript
import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260731000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "printful_webhook_event" (
        "id" text not null,
        "event_id" text not null,
        "type" text not null,
        "printful_order_id" text not null,
        "printful_shipment_id" text null,
        "payload" jsonb not null default '{}'::jsonb,
        "status" text not null default 'received',
        "attempts" integer not null default 0,
        "next_retry_at" timestamptz null,
        "processed_at" timestamptz null,
        "error_message" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_webhook_event_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create unique index if not exists "IDX_printful_webhook_event_event_id"
      on "printful_webhook_event" ("event_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_order"
      on "printful_webhook_event" ("printful_order_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_shipment"
      on "printful_webhook_event" ("printful_shipment_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_retry"
      on "printful_webhook_event" ("status", "next_retry_at")
      where deleted_at is null;
    `)

    // Reverse lookup: webhooks arrive with the Printful id, so this must not
    // be a sequential scan.
    this.addSql(`
      create unique index if not exists "IDX_printful_order_link_printful"
      on "printful_order_link" ("printful_order_id")
      where deleted_at is null and "printful_order_id" <> 'pending';
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_printful_order_link_printful";`)
    this.addSql(`drop table if exists "printful_webhook_event" cascade;`)
  }
}
```

The partial predicate excludes `'pending'` because `claimOrderLink` writes that
sentinel for every in-flight claim; without the exclusion a second concurrent
claim would collide on this index instead of the intended one.

- [ ] **Step 3: Register the model in the service**

In `src/modules/printful/service.ts`, add the import and include it in the
`MedusaService({ ... })` call:

```typescript
import PrintfulWebhookEvent from "./models/printful-webhook-event"

class PrintfulModuleService extends MedusaService({
  PrintfulProductLink,
  PrintfulVariantLink,
  PrintfulSyncLog,
  PrintfulOrderLink,
  PrintfulWebhookEvent,
}) {
```

- [ ] **Step 4: Verify the build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 5: Commit**

```bash
git add src/modules/printful/models/printful-webhook-event.ts src/modules/printful/migrations/Migration20260731000000.ts src/modules/printful/service.ts
git commit -m "feat: webhook event model, indexes, and reverse order lookup

Refs #2"
```

---

## Task 6: Service methods for events and locking

**Files:**
- Modify: `src/modules/printful/service.ts`

- [ ] **Step 1: Add the methods**

Add to `PrintfulModuleService`, after `findOrderLink`:

```typescript
  /** Reverse lookup used by webhooks, which only know the Printful order id. */
  async findOrderLinkByPrintfulId(printfulOrderId: string) {
    const [link] = await this.listPrintfulOrderLinks({
      printful_order_id: String(printfulOrderId),
    })
    return link ?? null
  }

  /**
   * Store an inbound event. Returns null when the event_id already exists,
   * which is how redelivered webhooks are absorbed.
   */
  async recordWebhookEvent(input: {
    event_id: string
    type: string
    printful_order_id: string
    printful_shipment_id?: string | null
    payload: Record<string, unknown>
    status?: string
  }) {
    try {
      return await this.createPrintfulWebhookEvents({
        event_id: input.event_id,
        type: input.type,
        printful_order_id: input.printful_order_id,
        printful_shipment_id: input.printful_shipment_id ?? null,
        payload: input.payload,
        status: input.status ?? "received",
        attempts: 0,
        next_retry_at: new Date(),
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        return null
      }
      throw err
    }
  }

  async findWebhookEvent(eventId: string) {
    const [event] = await this.listPrintfulWebhookEvents({ event_id: eventId })
    return event ?? null
  }

  /** Events due for another processing attempt, most overdue first. */
  async listDueWebhookEvents(limit = 50) {
    return this.listPrintfulWebhookEvents(
      {
        status: ["received", "deferred"],
        next_retry_at: { $lte: new Date() },
        attempts: { $lt: MAX_WEBHOOK_ATTEMPTS },
      },
      // Most overdue first. Ordering by next_retry_at (not created_at) lets the
      // ("status", "next_retry_at") index satisfy the sort instead of paying an
      // explicit Sort node on every sweep.
      { take: limit, order: { next_retry_at: "ASC" } }
    )
  }

  /**
   * Serialize work per Printful order. Two events for one order must not be
   * applied concurrently: both could pass the "shipment already recorded"
   * check before either writes.
   */
  async withOrderLock<T>(
    printfulOrderId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = lockKeyFor(printfulOrderId)
    const manager = this.getActiveManager_()
    await manager.execute(`select pg_advisory_lock(${key})`)
    try {
      return await fn()
    } finally {
      await manager.execute(`select pg_advisory_unlock(${key})`)
    }
  }
```

Add near the top of the file, beside `PENDING_PRINTFUL_ORDER_ID`:

```typescript
/** Attempts before an event is parked as permanently failed. */
export const MAX_WEBHOOK_ATTEMPTS = 20

/** Backoff: 5 minutes doubling per attempt, capped at 6 hours. */
export function nextRetryDelayMs(attempts: number): number {
  const FIVE_MINUTES = 5 * 60 * 1000
  const SIX_HOURS = 6 * 60 * 60 * 1000
  return Math.min(FIVE_MINUTES * Math.pow(2, attempts), SIX_HOURS)
}

/** Stable 32-bit key for pg_advisory_lock, derived from the order id. */
export function lockKeyFor(printfulOrderId: string): number {
  const digest = createHash("sha256").update(String(printfulOrderId)).digest()
  return digest.readInt32BE(0)
}
```

Add `import { createHash } from "crypto"` at the top of the file.

- [ ] **Step 2: Write the failing test for the pure helpers**

Append to `tests/order-link.test.ts`:

```typescript
import { MAX_WEBHOOK_ATTEMPTS, lockKeyFor, nextRetryDelayMs } from "../src/modules/printful/service"

describe("nextRetryDelayMs", () => {
  it("starts at five minutes", () => {
    expect(nextRetryDelayMs(0)).toBe(5 * 60 * 1000)
  })

  it("doubles per attempt", () => {
    expect(nextRetryDelayMs(1)).toBe(10 * 60 * 1000)
    expect(nextRetryDelayMs(2)).toBe(20 * 60 * 1000)
  })

  it("caps at six hours", () => {
    expect(nextRetryDelayMs(20)).toBe(6 * 60 * 60 * 1000)
    expect(nextRetryDelayMs(100)).toBe(6 * 60 * 60 * 1000)
  })
})

describe("lockKeyFor", () => {
  it("is stable for the same order id", () => {
    expect(lockKeyFor("777")).toBe(lockKeyFor("777"))
  })

  it("differs across order ids", () => {
    expect(lockKeyFor("777")).not.toBe(lockKeyFor("778"))
  })

  it("fits in a 32-bit signed integer", () => {
    const key = lockKeyFor("some-order")
    expect(Number.isInteger(key)).toBe(true)
    expect(key).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(key).toBeLessThan(2 ** 31)
  })
})

describe("MAX_WEBHOOK_ATTEMPTS", () => {
  it("caps retries at twenty", () => {
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(20)
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/order-link.test.ts`
Expected: PASS, 13 tests total

- [ ] **Step 4: Verify types**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/modules/printful/service.ts tests/order-link.test.ts
git commit -m "feat: webhook event storage, retry backoff, per-order locking

Refs #2"
```

---

## Task 7: Apply-order-status workflow

**Files:**
- Create: `src/workflows/apply-order-status.ts`
- Modify: `src/workflows/index.ts`

- [ ] **Step 1: Create the workflow**

```typescript
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from "@medusajs/medusa/core-flows"
import { PRINTFUL_MODULE } from "../modules/printful"
import PrintfulModuleService, {
  MAX_WEBHOOK_ATTEMPTS,
  nextRetryDelayMs,
} from "../modules/printful/service"
import { planOrderStateActions } from "../utils/order-state"

export type ApplyOrderStatusInput = {
  /** Row id in printful_webhook_event. */
  event_id_row: string
}

type ApplyResult = {
  status: "processed" | "deferred" | "failed"
  reason?: string
  shipments_created: number
}

const applyStep = createStep(
  "apply-printful-order-status",
  async (input: ApplyOrderStatusInput, { container }) => {
    const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
    const orderModule = container.resolve(Modules.ORDER)

    const [event] = await printful.listPrintfulWebhookEvents({
      id: input.event_id_row,
    })
    if (!event || event.status === "processed") {
      return new StepResponse<ApplyResult>({
        status: "processed",
        reason: "already_processed",
        shipments_created: 0,
      })
    }

    const attempts = (event.attempts ?? 0) + 1
    // Claim the attempt before doing work, so a crash cannot spin fast.
    await printful.updatePrintfulWebhookEvents({
      id: event.id,
      attempts,
      next_retry_at: new Date(Date.now() + nextRetryDelayMs(attempts)),
    })

    const link = await printful.findOrderLinkByPrintfulId(event.printful_order_id)
    if (!link) {
      // The order link is written on payment.captured; a webhook can beat it.
      const status = attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred"
      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status,
        error_message: "No printful_order_link for this Printful order yet",
      })
      return new StepResponse<ApplyResult>({
        status,
        reason: "link_missing",
        shipments_created: 0,
      })
    }

    return await printful.withOrderLock(event.printful_order_id, async () => {
      const client = await printful.getClient()
      const pfOrder = await client.getOrder(event.printful_order_id)

      const order = await orderModule.retrieveOrder(link.medusa_order_id, {
        relations: ["items", "fulfillments"],
      })

      const recorded = (order.fulfillments ?? [])
        .map((f) => (f.data as Record<string, unknown> | null)?.printful_shipment_id)
        .filter((v): v is string => typeof v === "string")

      const plan = planOrderStateActions(pfOrder, recorded)

      await orderModule.updateOrders(link.medusa_order_id, {
        metadata: { ...(order.metadata ?? {}), ...plan.metadata },
      })

      let created = 0
      for (const shipment of plan.shipments) {
        const { result: fulfillment } = await createOrderFulfillmentWorkflow(
          container
        ).run({
          input: {
            order_id: link.medusa_order_id,
            items: (order.items ?? []).map((item) => ({
              id: item.id,
              quantity: item.quantity,
            })),
            metadata: {
              printful_order_id: event.printful_order_id,
              printful_shipment_id: shipment.printful_shipment_id,
            },
          },
        })

        await createOrderShipmentWorkflow(container).run({
          input: {
            order_id: link.medusa_order_id,
            fulfillment_id: fulfillment.id,
            labels: shipment.tracking_number
              ? [
                  {
                    tracking_number: shipment.tracking_number,
                    tracking_url: shipment.tracking_url ?? "",
                    label_url: shipment.tracking_url ?? "",
                  },
                ]
              : [],
          },
        })
        created += 1
      }

      await printful.updatePrintfulOrderLinks({
        id: link.id,
        status: pfOrder.status,
      })

      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status: "processed",
        processed_at: new Date(),
        error_message: null,
      })

      return new StepResponse<ApplyResult>({
        status: "processed",
        shipments_created: created,
      })
    })
  }
)

export const applyOrderStatusWorkflow = createWorkflow(
  "apply-printful-order-status",
  (input: ApplyOrderStatusInput) => {
    return new WorkflowResponse(applyStep(input))
  }
)

export default applyOrderStatusWorkflow
```

- [ ] **Step 2: Export it**

Append to `src/workflows/index.ts`:

```typescript
export {
  default as applyOrderStatusWorkflow,
  applyOrderStatusWorkflow as applyOrderStatus,
} from "./apply-order-status"
export type { ApplyOrderStatusInput } from "./apply-order-status"
```

- [ ] **Step 3: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 4: Commit**

```bash
git add src/workflows/apply-order-status.ts src/workflows/index.ts
git commit -m "feat: apply Printful order state to Medusa fulfillments

Refs #2"
```

---

## Task 8: Public webhook route

**Files:**
- Create: `src/api/hooks/printful/[token]/route.ts`

- [ ] **Step 1: Create the route**

```typescript
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import {
  deriveEventId,
  extractOrderId,
  extractShipmentId,
  PRINTFUL_WEBHOOK_TYPES,
  verifyWebhookToken,
  type PrintfulWebhookPayload,
} from "../../../../utils/webhook-events"
import applyOrderStatusWorkflow from "../../../../workflows/apply-order-status"

/**
 * Public Printful webhook endpoint.
 *
 * The payload is a trigger, not a source of truth: we persist it, answer 200,
 * and let the workflow re-read GET /orders/{id} for the real state. Never log
 * the request URL or token.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const options = await printful.getOptions()

  const provided = req.params.token
  if (!verifyWebhookToken(options.webhookSecret, provided)) {
    // 404, not 401: do not confirm that this path exists.
    res.status(404).json({ message: "Not found" })
    return
  }

  const payload = (req.body ?? {}) as PrintfulWebhookPayload
  const type = payload.type ?? "unknown"
  const printfulOrderId = extractOrderId(payload)

  if (!printfulOrderId) {
    res.status(200).json({ received: true, ignored: "no_order_id" })
    return
  }

  const eventId = deriveEventId(payload)
  const handled = (PRINTFUL_WEBHOOK_TYPES as readonly string[]).includes(type)

  try {
    const event = await printful.recordWebhookEvent({
      event_id: eventId,
      type,
      printful_order_id: printfulOrderId,
      printful_shipment_id: extractShipmentId(payload),
      payload: payload as unknown as Record<string, unknown>,
      status: handled ? "received" : "ignored",
    })

    // Redelivery of an event we already hold: absorb it.
    if (!event) {
      res.status(200).json({ received: true, event_id: eventId, duplicate: true })
      return
    }

    res.status(200).json({ received: true, event_id: eventId })

    if (handled) {
      // Outside the response path: failures here are picked up by the retry job.
      void applyOrderStatusWorkflow(req.scope)
        .run({ input: { event_id_row: event.id } })
        .catch((err) => {
          logger.error(
            `Printful: apply failed for event ${eventId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        })
    }
  } catch (err) {
    // Only storage failures reach here. 500 is correct: we want Printful to retry.
    logger.error(
      `Printful: failed to store webhook event ${eventId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    res.status(500).json({ message: "Failed to store event" })
  }
}
```

- [ ] **Step 2: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 3: Commit**

```bash
git add src/api/hooks/printful/
git commit -m "feat: public Printful webhook endpoint with path secret

Refs #2"
```

---

## Task 9: Route integration tests

**Files:**
- Create: `tests/webhook-route.integration.test.ts`

These require a database. If `DATABASE_URL` is unset the suite skips rather than
failing, so the default `npm test` stays green on a bare checkout.

- [ ] **Step 1: Write the failing test**

```typescript
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { describe, expect, it } from "vitest"

const SECRET = "test-webhook-secret"

const shippedPayload = {
  type: "package_shipped",
  created: 1735689600,
  data: {
    order: { id: 777 },
    shipment: { id: 5001, carrier: "USPS", service: "Priority", tracking_number: "1Z999" },
  },
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("POST /hooks/printful/:token", () => {
      it("rejects an invalid token with 404", async () => {
        const res = await api
          .post("/hooks/printful/wrong-token", shippedPayload)
          .catch((e) => e.response)
        expect(res.status).toBe(404)
      })

      it("stores a valid event and returns 200", async () => {
        const res = await api.post(`/hooks/printful/${SECRET}`, shippedPayload)
        expect(res.status).toBe(200)
        expect(res.data.received).toBe(true)
        expect(res.data.event_id).toBeTruthy()

        const printful = getContainer().resolve("printful")
        const stored = await printful.findWebhookEvent(res.data.event_id)
        expect(stored).toBeTruthy()
        expect(stored.printful_order_id).toBe("777")
        expect(stored.printful_shipment_id).toBe("5001")
      })

      it("absorbs a redelivered event without a second row", async () => {
        const first = await api.post(`/hooks/printful/${SECRET}`, shippedPayload)
        const second = await api.post(`/hooks/printful/${SECRET}`, shippedPayload)

        expect(second.status).toBe(200)
        expect(second.data.duplicate).toBe(true)
        expect(second.data.event_id).toBe(first.data.event_id)

        const printful = getContainer().resolve("printful")
        const rows = await printful.listPrintfulWebhookEvents({
          event_id: first.data.event_id,
        })
        expect(rows).toHaveLength(1)
      })

      it("stores an unknown event type as ignored", async () => {
        const res = await api.post(`/hooks/printful/${SECRET}`, {
          type: "some_future_event",
          created: 1,
          data: { order: { id: 888 } },
        })
        expect(res.status).toBe(200)

        const printful = getContainer().resolve("printful")
        const stored = await printful.findWebhookEvent(res.data.event_id)
        expect(stored.status).toBe("ignored")
      })

      it("defers an event whose order link does not exist yet", async () => {
        const res = await api.post(`/hooks/printful/${SECRET}`, {
          type: "package_shipped",
          created: 99,
          data: { order: { id: 999999 }, shipment: { id: 42 } },
        })
        expect(res.status).toBe(200)

        const printful = getContainer().resolve("printful")
        await new Promise((r) => setTimeout(r, 500))
        const stored = await printful.findWebhookEvent(res.data.event_id)
        expect(["received", "deferred"]).toContain(stored.status)
      })
    })
  },
})
```

- [ ] **Step 2: Add the vitest include pattern**

Modify `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts", "node_modules/**"],
    testTimeout: 60_000,
  },
})
```

Add the script to `package.json`:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

Create `vitest.integration.config.ts`:

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
```

- [ ] **Step 3: Run the unit suite to confirm it is unaffected**

Run: `npm test`
Expected: PASS, integration file excluded

- [ ] **Step 4: Run the integration suite**

Run: `DATABASE_URL=postgres://localhost/print2medusa_test npm run test:integration`
Expected: PASS, 5 tests. If no Postgres is available, note it and move on — Task 12
runs the full verification.

- [ ] **Step 5: Commit**

```bash
git add tests/webhook-route.integration.test.ts vitest.config.ts vitest.integration.config.ts package.json
git commit -m "test: route integration tests for webhook endpoint

Refs #2"
```

---

## Task 9b: Verification-first integration test

**Files:**
- Modify: `tests/webhook-route.integration.test.ts`

This is the security core of the release: a forged payload must not be able to
create a fulfillment. It earns its own task because if it ever silently stops
holding, the entire trust model is gone.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("POST /hooks/printful/:token", ...)` block:

```typescript
      it("ignores a payload that lies about the status", async () => {
        // The payload claims the order shipped. The Printful API — the only
        // source we trust — still reports it pending, so nothing may be created.
        const printful = getContainer().resolve("printful")
        const client = await printful.getClient()
        const originalGetOrder = client.getOrder.bind(client)
        client.getOrder = async () => ({ id: 4242, status: "pending", shipments: [] })

        try {
          const res = await api.post(`/hooks/printful/${SECRET}`, {
            type: "package_shipped",
            created: 4242,
            data: {
              order: { id: 4242 },
              shipment: { id: 90001, tracking_number: "FORGED" },
            },
          })
          expect(res.status).toBe(200)

          await new Promise((r) => setTimeout(r, 1000))

          const stored = await printful.findWebhookEvent(res.data.event_id)
          expect(stored).toBeTruthy()

          // No fulfillment may reference the forged shipment id.
          const link = await printful.findOrderLinkByPrintfulId("4242")
          if (link) {
            const orderModule = getContainer().resolve("order")
            const order = await orderModule.retrieveOrder(link.medusa_order_id, {
              relations: ["fulfillments"],
            })
            const forged = (order.fulfillments ?? []).filter(
              (f) =>
                (f.data as Record<string, unknown> | null)
                  ?.printful_shipment_id === "90001"
            )
            expect(forged).toHaveLength(0)
          }
        } finally {
          client.getOrder = originalGetOrder
        }
      })
```

- [ ] **Step 2: Run the integration suite**

Run: `DATABASE_URL=postgres://localhost/print2medusa_test npm run test:integration`
Expected: PASS. The forged shipment must not appear.

- [ ] **Step 3: Commit**

```bash
git add tests/webhook-route.integration.test.ts
git commit -m "test: forged payload cannot create a fulfillment

Refs #2"
```

---

## Task 10: Retry job

**Files:**
- Create: `src/jobs/retry-webhook-events.ts`

- [ ] **Step 1: Create the job**

```typescript
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINTFUL_MODULE } from "../modules/printful"
import type PrintfulModuleService from "../modules/printful/service"
import { MAX_WEBHOOK_ATTEMPTS } from "../modules/printful/service"
import applyOrderStatusWorkflow from "../workflows/apply-order-status"

/**
 * Drains webhook events that could not be applied on arrival — most often
 * because the order link had not been written yet when the webhook landed.
 */
export default async function retryPrintfulWebhookEvents(
  container: MedusaContainer
) {
  const printful: PrintfulModuleService = container.resolve(PRINTFUL_MODULE)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  const due = await printful.listDueWebhookEvents(50)
  if (!due.length) {
    return
  }

  logger.info(`Printful: retrying ${due.length} webhook event(s)`)

  for (const event of due) {
    try {
      await applyOrderStatusWorkflow(container).run({
        input: { event_id_row: event.id },
      })
    } catch (err) {
      const attempts = (event.attempts ?? 0) + 1
      await printful.updatePrintfulWebhookEvents({
        id: event.id,
        status: attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed" : "deferred",
        error_message: err instanceof Error ? err.message : String(err),
      })
      logger.error(
        `Printful: retry failed for event ${event.event_id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

export const config = {
  name: "printful-retry-webhook-events",
  schedule: "*/5 * * * *",
}
```

- [ ] **Step 2: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 3: Commit**

```bash
git add src/jobs/retry-webhook-events.ts
git commit -m "feat: scheduled retry for deferred webhook events

Refs #2"
```

---

## Task 11: Admin webhook config route and order widget

**Files:**
- Create: `src/api/admin/printful/webhook/route.ts`
- Create: `src/admin/widgets/printful-order-widget.tsx`

- [ ] **Step 1: Create the admin config route**

```typescript
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import { PRINTFUL_WEBHOOK_TYPES } from "../../../../utils/webhook-events"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const client = await printful.getClient()
  const options = await printful.getOptions()

  const current = await client.getWebhookConfig()

  res.status(200).json({
    current,
    configured_types: PRINTFUL_WEBHOOK_TYPES,
    secret_set: Boolean(options.webhookSecret),
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const client = await printful.getClient()
  const options = await printful.getOptions()

  if (!options.webhookSecret) {
    res.status(400).json({
      message: "Set the webhookSecret plugin option before registering a webhook",
    })
    return
  }

  const body = (req.body ?? {}) as { base_url?: string }
  if (!body.base_url) {
    res.status(400).json({ message: "base_url is required" })
    return
  }

  const url = `${body.base_url.replace(/\/$/, "")}/hooks/printful/${options.webhookSecret}`

  // Printful keeps one config per store, so this replaces the whole allowlist.
  const updated = await client.setWebhookConfig(url, [...PRINTFUL_WEBHOOK_TYPES])

  res.status(200).json({ current: updated })
}
```

- [ ] **Step 2: Create the order widget**

```typescript
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"

type PrintfulShipment = {
  id: string
  carrier?: string
  service?: string
  tracking_number?: string
  tracking_url?: string
  ship_date?: string
}

const ATTENTION = new Set(["failed", "canceled", "onhold"])

const PrintfulOrderWidget = ({ data: order }: DetailWidgetProps<AdminOrder>) => {
  const meta = (order?.metadata ?? {}) as Record<string, unknown>
  const printfulOrderId = meta.printful_order_id as string | undefined

  if (!printfulOrderId) {
    return null
  }

  const status = (meta.printful_status as string) ?? "unknown"
  const shipments = (meta.printful_shipments as PrintfulShipment[]) ?? []
  const updatedAt = meta.printful_status_updated_at as string | undefined

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Printful</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Order {printfulOrderId}
          </Text>
        </div>
        <Badge color={ATTENTION.has(status) ? "red" : "green"}>{status}</Badge>
      </div>

      <div className="px-6 py-4 flex flex-col gap-2">
        {shipments.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            No shipments yet.
          </Text>
        ) : (
          shipments.map((s) => (
            <div key={s.id} className="flex flex-col gap-1">
              <Text size="small">
                {[s.carrier, s.service].filter(Boolean).join(" · ") || "Shipment"}
                {s.ship_date ? ` · ${s.ship_date}` : ""}
              </Text>
              {s.tracking_number ? (
                <Text size="small" className="text-ui-fg-subtle">
                  {s.tracking_url ? (
                    <a href={s.tracking_url} target="_blank" rel="noreferrer">
                      {s.tracking_number}
                    </a>
                  ) : (
                    s.tracking_number
                  )}
                </Text>
              ) : null}
            </div>
          ))
        )}
        {updatedAt ? (
          <Text size="small" className="text-ui-fg-subtle">
            Last synced {new Date(updatedAt).toLocaleString()}
          </Text>
        ) : null}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default PrintfulOrderWidget
```

- [ ] **Step 3: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0

- [ ] **Step 4: Commit**

```bash
git add src/api/admin/printful/webhook/ src/admin/widgets/printful-order-widget.tsx
git commit -m "feat: webhook config route and order status widget

Refs #2"
```

---

## Task 12: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Document the webhook setup in README**

Insert after the "What it does (MVP)" table:

```markdown
## Webhooks

Set `webhookSecret` in the plugin options, then register the endpoint from
Medusa Admin (Products list → Printful → Webhooks) or by calling
`POST /admin/printful/webhook` with your public base URL.

The endpoint Printful will call is:

```
https://<your-store>/hooks/printful/<webhookSecret>
```

Printful keeps **one webhook configuration per store**, so registering replaces
the existing URL and event list. Subscribed events: `package_shipped`,
`order_failed`, `order_canceled`, `package_returned`.

Incoming events are stored in `printful_webhook_event` and applied by re-reading
`GET /orders/{id}` — the payload itself is never trusted. Events that arrive
before their order link exists are retried every 5 minutes with exponential
backoff, up to 20 attempts.
```

- [ ] **Step 2: Update the CHANGELOG**

Replace the `## Unreleased` section heading block with:

```markdown
## Unreleased

### Added

- Public webhook endpoint `POST /hooks/printful/:token` with constant-time token checks
- `printful_webhook_event` log with derived event ids for idempotency
- Order status applied by re-reading `GET /orders/{id}`; webhook payloads are never trusted
- Medusa fulfillments and shipments created per Printful package, with tracking
- Scheduled retry job for events that arrive before their order link exists
- Admin order widget showing Printful status and tracking
- Webhook configuration route `GET`/`POST /admin/printful/webhook`
```

- [ ] **Step 3: Bump the version**

In `package.json`, set:

```json
  "version": "0.2.0",
```

- [ ] **Step 4: Run the full verification suite**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: lint 0 errors, typecheck exit 0, all unit tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: webhook setup and 0.2.0 changelog

Closes #2"
```

---

## Verification Checklist

Before considering 0.2.0 done:

- [ ] `npm run lint` reports 0 errors
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` passes with the new unit tests (webhook-events, order-state, order-link)
- [ ] `npm run test:integration` passes against a real Postgres
- [ ] `npm run build` succeeds
- [ ] A wrong token returns `404` and writes nothing
- [ ] A redelivered event creates exactly one row and one fulfillment
- [ ] A payload claiming `fulfilled` while the API says `pending` creates no fulfillment
- [ ] An event arriving before its order link ends `deferred`, then `processed` after the retry job
