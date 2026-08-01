import { asValue } from "awilix"
import { MedusaModule } from "@medusajs/framework/modules-sdk"
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  createPgConnection,
  Module,
  Modules,
  ModulesSdkUtils,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { POST as webhookRoute } from "../src/api/hooks/printful/[token]/route"
import { PRINTFUL_MODULE } from "../src/modules/printful"
import { Migration20260726000000 } from "../src/modules/printful/migrations/Migration20260726000000"
import { Migration20260731000000 } from "../src/modules/printful/migrations/Migration20260731000000"
import PrintfulOrderLink from "../src/modules/printful/models/printful-order-link"
import PrintfulProductLink from "../src/modules/printful/models/printful-product-link"
import PrintfulSyncLog from "../src/modules/printful/models/printful-sync-log"
import PrintfulVariantLink from "../src/modules/printful/models/printful-variant-link"
import PrintfulWebhookEvent from "../src/modules/printful/models/printful-webhook-event"
import PrintfulModuleServiceClass, {
  MAX_WEBHOOK_ATTEMPTS,
} from "../src/modules/printful/service"
import type PrintfulModuleService from "../src/modules/printful/service"
import { planOrderStateActions } from "../src/utils/order-state"
import { PrintfulClient } from "../src/utils/printful-client"
import applyOrderStatusWorkflow from "../src/workflows/apply-order-status"

/**
 * Integration tests for the public Printful webhook endpoint, run against a
 * real Postgres.
 *
 * Why not `medusaIntegrationTestRunner`: it boots a full Medusa application
 * from a `medusa-config.ts` at the project root. This repo is a PLUGIN — it has
 * no such config and no application to boot — and the runner is additionally
 * bound to Jest's globals, which vitest does not provide. `initModules` fails
 * for a narrower reason: it resolves a module through `require.resolve` +
 * `require`, so it can only load COMPILED JavaScript, and `.medusa/server` is
 * a build output with no `package.json`.
 *
 * `MedusaModule.bootstrap` accepts `moduleExports` and `moduleDefinition`
 * directly, which bypasses path resolution entirely and lets vitest's own
 * transform supply the TypeScript sources. Supplying `moduleExports` means
 * `prepareLoaders` no longer auto-discovers `models/`, so the connection and
 * container loaders are constructed explicitly below from the same model
 * definitions the module itself registers.
 *
 * What this exercises for real: the migration SQL (including the partial unique
 * index on `event_id`), the module service, MikroORM filter translation, and
 * the route handler itself. What it does not exercise: Express routing, the
 * body-parser sizing, and the path-redaction middleware — all of which are
 * covered by the unit tests in tests/webhook-body-limit.test.ts and
 * tests/webhook-path.test.ts.
 */

const WEBHOOK_SECRET = "integration-test-secret"
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://andy@localhost:5432/print2medusa_test"

type Pg = ReturnType<typeof createPgConnection>

let pg: Pg
let printful: PrintfulModuleService

/** Collect a migration's SQL without a MikroORM driver, then run it directly. */
async function runMigration(
  MigrationClass:
    typeof Migration20260726000000 | typeof Migration20260731000000
): Promise<void> {
  const statements: string[] = []
  const migration = Object.create(MigrationClass.prototype) as {
    addSql: (sql: string) => void
    up: () => Promise<void>
  }
  migration.addSql = (sql: string) => {
    statements.push(sql)
  }
  await migration.up()
  for (const sql of statements) {
    await pg.raw(sql)
  }
}

/**
 * Minimal MedusaResponse stand-in. Only `status`/`json` are reachable from the
 * route, so anything else being touched is a signal the route changed shape.
 */
type CapturedResponse = {
  statusCode: number
  body: unknown
  status: (code: number) => CapturedResponse
  json: (payload: unknown) => CapturedResponse
}

function createResponse(): CapturedResponse {
  const res: CapturedResponse = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res
}

const loggedErrors: string[] = []

function createRequest(token: string, body: unknown) {
  return {
    params: { token },
    body,
    scope: {
      resolve(key: string) {
        if (key === PRINTFUL_MODULE) {
          return printful
        }
        if (key === ContainerRegistrationKeys.LOGGER) {
          return {
            error: (msg: string) => loggedErrors.push(msg),
            warn: () => {},
            info: () => {},
            debug: () => {},
          }
        }
        throw new Error(`Unexpected container resolution in test: ${key}`)
      },
    },
  }
}

/**
 * Container for running the apply workflow directly. Only the printful module
 * is real; the Order module and Query are stubs that throw if touched, because
 * every test that uses this container asserts on a branch that returns BEFORE
 * reaching them. A throw here means the code took an unexpected path, which is
 * exactly what should fail the test rather than pass silently.
 */
function makeWorkflowContainer(overrides: Record<string, unknown> = {}) {
  // Must be a real Awilix container: the workflow engine wraps whatever it is
  // given (@medusajs/orchestration local-workflow) and calls through to the
  // container's own `resolve`, so a plain object with a `resolve` method is
  // bypassed entirely.
  const container = createMedusaContainer()
  container.register(
    PRINTFUL_MODULE,
    asValue(printful as unknown as Record<string, unknown>)
  )
  container.register(
    ContainerRegistrationKeys.LOGGER,
    asValue({
      error: (msg: string) => loggedErrors.push(msg),
      warn: () => {},
      info: () => {},
      debug: () => {},
    })
  )
  // The step resolves these two eagerly, before the branch under test is
  // reached. They are registered as objects whose every method throws, so
  // resolving them stays harmless while USING them still fails loudly — a
  // silent pass here would mean the code took a path the test does not cover.
  container.register(
    Modules.ORDER,
    asValue({
      updateOrders: () => {
        throw new Error("Order module used unexpectedly in this test")
      },
      retrieveOrder: () => {
        throw new Error("Order module used unexpectedly in this test")
      },
    })
  )
  container.register(
    ContainerRegistrationKeys.QUERY,
    asValue({
      graph: () => {
        throw new Error("Query used unexpectedly in this test")
      },
    })
  )
  for (const [key, value] of Object.entries(overrides)) {
    container.register(key, asValue(value as never))
  }
  return container
}

/** Drive the route exactly as Express would, and wait for its async tail. */
async function postWebhook(token: string, body: unknown) {
  const res = createResponse()
  const req = createRequest(token, body)
  await (
    webhookRoute as unknown as (req: unknown, res: unknown) => Promise<void>
  )(req, res)
  // The route answers 200 and then fires the apply workflow without awaiting
  // it. Yield so that fire-and-forget tail settles before assertions run.
  await new Promise((resolve) => setImmediate(resolve))
  return res
}

function shippedPayload(overrides: {
  orderId: number
  shipmentId?: number
  created?: number
  type?: string
}) {
  return {
    type: overrides.type ?? "package_shipped",
    created: overrides.created ?? 1_700_000_000,
    retries: 0,
    store: 42,
    data: {
      order: {
        id: overrides.orderId,
        external_id: `order_${overrides.orderId}`,
      },
      ...(overrides.shipmentId === undefined
        ? {}
        : {
            shipment: {
              id: overrides.shipmentId,
              carrier: "USPS",
              service: "Ground",
              tracking_number: "TRK123",
            },
          }),
    },
  }
}

async function countEvents(printfulOrderId: string): Promise<number> {
  const rows = await pg.raw(
    `select count(*)::int as count from printful_webhook_event where printful_order_id = ?`,
    [printfulOrderId]
  )
  return rows.rows[0].count
}

beforeAll(async () => {
  pg = createPgConnection({ clientUrl: DATABASE_URL, schema: "public" })

  await runMigration(Migration20260726000000)
  await runMigration(Migration20260731000000)

  const models = toMikroOrmEntities([
    PrintfulProductLink,
    PrintfulVariantLink,
    PrintfulSyncLog,
    PrintfulOrderLink,
    PrintfulWebhookEvent,
  ] as never) as unknown as Array<{ name: string }>

  const connectionLoader = ModulesSdkUtils.mikroOrmConnectionLoaderFactory({
    moduleName: PRINTFUL_MODULE,
    moduleModels: models as never,
    migrationsPath: "",
  })
  const containerLoader = ModulesSdkUtils.moduleContainerLoaderFactory({
    moduleModels: models.reduce<Record<string, unknown>>((acc, model) => {
      acc[model.name] = model
      return acc
    }, {}),
    moduleRepositories: {},
    moduleServices: {},
  })

  const moduleExports = Module(PRINTFUL_MODULE, {
    service: PrintfulModuleServiceClass as never,
    loaders: [connectionLoader as never, containerLoader as never],
  })

  const loaded = (await MedusaModule.bootstrap({
    moduleKey: PRINTFUL_MODULE,
    defaultPath: "",
    declaration: {
      scope: "internal",
      options: {
        apiToken: "test-token",
        storeId: "test-store",
        webhookSecret: WEBHOOK_SECRET,
      },
    } as never,
    moduleExports: moduleExports as never,
    moduleDefinition: {
      key: PRINTFUL_MODULE,
      label: "Printful",
      isRequired: false,
      defaultPackage: "",
      dependencies: [
        ContainerRegistrationKeys.PG_CONNECTION,
        ContainerRegistrationKeys.LOGGER,
      ],
      defaultModuleDeclaration: { scope: "internal" },
    } as never,
    injectedDependencies: {
      [ContainerRegistrationKeys.PG_CONNECTION]: pg,
    },
  })) as unknown as Record<string, PrintfulModuleService>

  printful = loaded[PRINTFUL_MODULE]
})

afterAll(async () => {
  MedusaModule.clearInstances()
  await pg.destroy()
})

beforeEach(async () => {
  loggedErrors.length = 0
  await pg.raw(`truncate table printful_webhook_event`)
  await pg.raw(`truncate table printful_order_link`)
})

describe("POST /hooks/printful/:token", () => {
  it("rejects an invalid token with 404 and writes nothing", async () => {
    const res = await postWebhook(
      "not-the-secret",
      shippedPayload({ orderId: 1001, shipmentId: 5001 })
    )

    expect(res.statusCode).toBe(404)
    // 404 rather than 401: the endpoint must not confirm that it exists.
    expect(res.body).toEqual({ message: "Not found" })

    const total = await pg.raw(
      `select count(*)::int as count from printful_webhook_event`
    )
    expect(total.rows[0].count).toBe(0)
  })

  it("stores the event on a valid token", async () => {
    const res = await postWebhook(
      WEBHOOK_SECRET,
      shippedPayload({ orderId: 1002, shipmentId: 5002 })
    )

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ received: true })

    const rows = await pg.raw(
      `select printful_order_id, printful_shipment_id, type, status
       from printful_webhook_event where printful_order_id = ?`,
      ["1002"]
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      printful_order_id: "1002",
      printful_shipment_id: "5002",
      type: "package_shipped",
    })
  })

  it("absorbs a redelivery into exactly one row", async () => {
    // Printful redelivers by design, varying only the delivery envelope
    // (`retries`, `store`). Both must derive the same event_id and collide on
    // the unique index, or a redelivery becomes a duplicate fulfillment.
    const first = shippedPayload({ orderId: 1003, shipmentId: 5003 })
    const redelivery = { ...first, retries: 3, store: 999 }

    const res1 = await postWebhook(WEBHOOK_SECRET, first)
    const res2 = await postWebhook(WEBHOOK_SECRET, redelivery)

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
    expect(res2.body).toMatchObject({ duplicate: true })
    expect((res1.body as { event_id: string }).event_id).toBe(
      (res2.body as { event_id: string }).event_id
    )

    expect(await countEvents("1003")).toBe(1)
  })

  it("absorbs a redelivery that must fall back to the payload fingerprint", async () => {
    // The previous case keys its event id on the shipment id, so the delivery
    // envelope never reaches the hash there. This payload omits `created`,
    // which forces the timeKey down the stableFingerprint path — the ONE place
    // `retries`/`store` could leak into the hash. Printful varies both between
    // redeliveries of the same event, so if they were hashed, this redelivery
    // would derive a fresh event_id, slip past the unique index, and land as a
    // second row — downstream, a second fulfillment for one parcel.
    const first = {
      type: "order_canceled",
      retries: 0,
      store: 42,
      data: { order: { id: 1006, external_id: "order_1006" } },
    }
    const redelivery = { ...first, retries: 7, store: 4242 }

    const res1 = await postWebhook(WEBHOOK_SECRET, first)
    const res2 = await postWebhook(WEBHOOK_SECRET, redelivery)

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
    expect((res1.body as { event_id: string }).event_id).toBe(
      (res2.body as { event_id: string }).event_id
    )
    expect(await countEvents("1006")).toBe(1)
  })

  it("keeps distinct parcels of one order as distinct events", async () => {
    // The mirror of idempotency: Printful splits an order across facilities, so
    // two shipments must NOT collapse into one event id.
    await postWebhook(
      WEBHOOK_SECRET,
      shippedPayload({ orderId: 1007, shipmentId: 6001 })
    )
    await postWebhook(
      WEBHOOK_SECRET,
      shippedPayload({ orderId: 1007, shipmentId: 6002 })
    )

    expect(await countEvents("1007")).toBe(2)
  })

  it("stores an unknown event type as ignored", async () => {
    const res = await postWebhook(WEBHOOK_SECRET, {
      type: "product_synced",
      created: 1_700_000_100,
      data: { order: { id: 1004 } },
    })

    expect(res.statusCode).toBe(200)

    const rows = await pg.raw(
      `select type, status from printful_webhook_event where printful_order_id = ?`,
      ["1004"]
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      type: "product_synced",
      status: "ignored",
    })
  })

  it("does not mark an event failed when the order link is missing", async () => {
    // A webhook can legitimately beat `payment.captured`, which is what writes
    // the order link. That is a wait-and-retry condition, never a failure — a
    // `failed` row here would strand a real shipment permanently.
    //
    // The route fires the apply workflow without awaiting it, and that
    // fire-and-forget tail cannot resolve the Order/Query modules in this
    // harness. So rather than assert on a status the workflow never had a
    // chance to write (which would pass vacuously), run the workflow
    // explicitly and assert on the branch it actually took.
    const res = await postWebhook(
      WEBHOOK_SECRET,
      shippedPayload({ orderId: 1005, shipmentId: 5005 })
    )
    expect(res.statusCode).toBe(200)

    const eventId = (res.body as { event_id: string }).event_id
    const stored = await printful.findWebhookEvent(eventId)
    expect(stored).toBeTruthy()

    // No printful_order_link exists for order 1005 — beforeEach truncated the
    // table — which is exactly the pre-`payment.captured` race.
    const linkBefore = await printful.findOrderLinkByPrintfulId("1005")
    expect(linkBefore).toBeNull()

    const { result } = await applyOrderStatusWorkflow(
      makeWorkflowContainer()
    ).run({
      input: { event_row_id: (stored as { id: string }).id },
    })

    expect(result).toMatchObject({
      status: "deferred",
      reason: "link_missing",
      shipments_created: 0,
    })

    const rows = await pg.raw(
      `select status, attempts, next_retry_at from printful_webhook_event where printful_order_id = ?`,
      ["1005"]
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].status).toBe("deferred")
    expect(rows.rows[0].status).not.toBe("failed")
    // Deferred means "come back later", so it must carry a retry time.
    expect(rows.rows[0].next_retry_at).toBeTruthy()
  })
})

describe("listDueWebhookEvents filter operators", () => {
  /**
   * The single most valuable test here. `listDueWebhookEvents` builds its
   * filter from three constructs that TypeScript cannot check the semantics of:
   * an implicit `$in` (`status: [...]`), a `{ $lte }` on next_retry_at, and a
   * `{ $lt }` on attempts. If any one of them were silently ignored or
   * mistranslated by MikroORM, the query would still typecheck, still return
   * rows, and still look healthy — while the retry sweep quietly picked up
   * events it must never touch (already processed, not yet due, or past the
   * attempt cap). Only a real database can tell the difference.
   *
   * Every seeded row below is excluded for EXACTLY ONE reason, so a failure
   * names the operator that broke.
   */
  const HOUR = 60 * 60 * 1000

  async function seed(row: {
    key: string
    status: string
    next_retry_at: Date | null
    attempts: number
  }) {
    const created = await printful.recordWebhookEvent({
      event_id: `filter-${row.key}`,
      type: "package_shipped",
      printful_order_id: `order-${row.key}`,
      payload: {},
      status: row.status,
    })
    // recordWebhookEvent always stamps attempts 0 / next_retry_at now, so the
    // discriminating columns are set explicitly afterwards.
    await printful.updatePrintfulWebhookEvents({
      id: (created as { id: string }).id,
      attempts: row.attempts,
      next_retry_at: row.next_retry_at,
    })
    return (created as { id: string }).id
  }

  it("returns only rows that pass every operator", async () => {
    const past = new Date(Date.now() - HOUR)
    const future = new Date(Date.now() + HOUR)

    // --- should be returned ---
    const dueReceived = await seed({
      key: "due-received",
      status: "received",
      next_retry_at: past,
      attempts: 0,
    })
    const dueDeferred = await seed({
      key: "due-deferred",
      status: "deferred",
      next_retry_at: past,
      attempts: MAX_WEBHOOK_ATTEMPTS - 1, // $lt boundary: still under the cap
    })

    // --- excluded, one reason each ---
    await seed({
      key: "wrong-status-processed",
      status: "processed",
      next_retry_at: past,
      attempts: 0,
    })
    await seed({
      key: "wrong-status-ignored",
      status: "ignored",
      next_retry_at: past,
      attempts: 0,
    })
    await seed({
      key: "wrong-status-failed",
      status: "failed",
      next_retry_at: past,
      attempts: 0,
    })
    await seed({
      key: "not-yet-due",
      status: "received",
      next_retry_at: future,
      attempts: 0,
    })
    await seed({
      key: "at-attempt-cap",
      status: "received",
      next_retry_at: past,
      attempts: MAX_WEBHOOK_ATTEMPTS, // $lt is exclusive: the cap is excluded
    })
    await seed({
      key: "over-attempt-cap",
      status: "deferred",
      next_retry_at: past,
      attempts: MAX_WEBHOOK_ATTEMPTS + 5,
    })

    const due = await printful.listDueWebhookEvents(50)
    const dueIds = due.map((e: { id: string }) => e.id).sort()

    expect(dueIds).toEqual([dueReceived, dueDeferred].sort())
  })

  it("orders the most overdue event first", async () => {
    // The sweep orders by next_retry_at so the ("status", "next_retry_at")
    // index can satisfy the sort. Seeded out of order on purpose.
    const newer = await seed({
      key: "order-newer",
      status: "received",
      next_retry_at: new Date(Date.now() - HOUR),
      attempts: 0,
    })
    const oldest = await seed({
      key: "order-oldest",
      status: "received",
      next_retry_at: new Date(Date.now() - 5 * HOUR),
      attempts: 0,
    })
    const middle = await seed({
      key: "order-middle",
      status: "received",
      next_retry_at: new Date(Date.now() - 3 * HOUR),
      attempts: 0,
    })

    const due = await printful.listDueWebhookEvents(50)
    expect(due.map((e: { id: string }) => e.id)).toEqual([
      oldest,
      middle,
      newer,
    ])
  })

  it("honours the limit without losing the ordering", async () => {
    for (let i = 0; i < 5; i++) {
      await seed({
        key: `limit-${i}`,
        status: "received",
        // i=0 is the most overdue.
        next_retry_at: new Date(Date.now() - (5 - i) * HOUR),
        attempts: 0,
      })
    }

    const due = await printful.listDueWebhookEvents(2)
    expect(due).toHaveLength(2)
    expect(due.map((e: { event_id: string }) => e.event_id)).toEqual([
      "filter-limit-0",
      "filter-limit-1",
    ])
  })

  it("treats a null next_retry_at as not due", async () => {
    // A null retry time carries no instruction to run now. `$lte` on NULL is
    // NULL in SQL, so such a row must not be swept up.
    await seed({
      key: "null-retry",
      status: "received",
      next_retry_at: null,
      attempts: 0,
    })

    const due = await printful.listDueWebhookEvents(50)
    expect(due).toHaveLength(0)
  })
})

describe("a forged payload cannot create a fulfillment", () => {
  /**
   * The security core of the whole release.
   *
   * Printful API v1 does not sign its webhooks. Anyone who learns the URL can
   * POST anything to it, so the payload is never evidence — it only names which
   * order to go and inspect. Every decision must come from re-reading
   * GET /orders/{id}, whose response is authenticated by our own API token.
   *
   * The attack: POST a payload claiming `package_shipped` with a shipment id,
   * for an order the Printful API reports as still `pending` with no shipments.
   * If the payload were trusted anywhere, this mints a fulfillment (and a
   * tracking number, and a shipped notification) for a parcel that does not
   * exist. It must produce NO fulfillment.
   *
   * Stubbing: injected at `fetchImpl`, the HTTP boundary, rather than by
   * replacing `getOrder` or the whole client. That keeps the REAL PrintfulClient
   * in the path — its URL construction, auth headers, retry loop and response
   * parsing all still run — so the test exercises the actual code that reads the
   * API instead of a stand-in for it. The client is seeded into the service's
   * `client_` cache, which `getClient()` returns as-is when already set.
   */
  const FORGED_SHIPMENT_ID = "9999999"
  const PRINTFUL_ORDER_ID = "2001"
  const MEDUSA_ORDER_ID = "order_forged_test"

  /** What the Printful API actually reports: pending, nothing shipped. */
  const authoritativeOrder = {
    id: Number(PRINTFUL_ORDER_ID),
    external_id: MEDUSA_ORDER_ID,
    status: "pending",
    shipments: [],
    items: [],
  }

  let getOrderCalls: string[]

  beforeEach(() => {
    getOrderCalls = []
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url)
      getOrderCalls.push(href)
      return new Response(
        JSON.stringify({ code: 200, result: authoritativeOrder }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    }) as unknown as typeof fetch

    // Seed the client cache so getClient() hands back a client whose only
    // difference from production is where its HTTP requests go.
    ;(printful as unknown as { client_: PrintfulClient | null }).client_ =
      new PrintfulClient({
        apiToken: "test-token",
        storeId: "test-store",
        fetchImpl,
      })
  })

  afterAll(() => {
    ;(printful as unknown as { client_: PrintfulClient | null }).client_ = null
  })

  it("creates no fulfillment for a shipment the Printful API does not report", async () => {
    // The link exists, so the run gets past the missing-link branch and all the
    // way to the authoritative re-fetch. This isolates the trust question.
    await printful.createPrintfulOrderLinks({
      medusa_order_id: MEDUSA_ORDER_ID,
      printful_order_id: PRINTFUL_ORDER_ID,
      external_id: MEDUSA_ORDER_ID,
      status: "pending",
    })

    const forged = {
      type: "package_shipped",
      created: 1_700_000_900,
      retries: 0,
      store: 42,
      data: {
        order: {
          id: Number(PRINTFUL_ORDER_ID),
          external_id: MEDUSA_ORDER_ID,
          // The forger also lies about the order's own state.
          status: "fulfilled",
        },
        shipment: {
          id: Number(FORGED_SHIPMENT_ID),
          carrier: "ATTACKER",
          service: "Overnight",
          tracking_number: "FORGED-TRACKING-1",
          tracking_url: "https://attacker.example/track",
        },
      },
    }

    const res = await postWebhook(WEBHOOK_SECRET, forged)
    // The endpoint still answers 200: storing a payload is not trusting it, and
    // a non-200 would only make Printful redeliver.
    expect(res.statusCode).toBe(200)

    const stored = await printful.findWebhookEvent(
      (res.body as { event_id: string }).event_id
    )
    expect(stored).toBeTruthy()

    // Every fulfillment Medusa creates is routed through the Fulfillment
    // module. Recording each call here is what turns "no fulfillment" from an
    // absence of errors into a positive, checkable fact.
    const createdFulfillments: Array<Record<string, unknown>> = []
    const fulfillmentModuleStub = {
      createFulfillment: async (data: Record<string, unknown>) => {
        createdFulfillments.push(data)
        return { id: "ful_should_not_exist", ...data }
      },
      createFulfillments: async (data: Record<string, unknown>) => {
        createdFulfillments.push(data)
        return [{ id: "ful_should_not_exist", ...data }]
      },
    }
    const orderModuleStub = {
      updateOrders: async () => ({}),
      retrieveOrder: async () => ({ id: MEDUSA_ORDER_ID }),
      registerFulfillment: async (data: Record<string, unknown>) => {
        createdFulfillments.push(data)
        return {}
      },
    }
    const queryStub = {
      graph: async () => ({
        data: [
          {
            id: MEDUSA_ORDER_ID,
            metadata: {},
            // One open line item: Medusa has quantity available to fulfill, so
            // nothing here prevents a fulfillment except the API's own report.
            items: [
              { id: "item_1", quantity: 1, detail: { fulfilled_quantity: 0 } },
            ],
            fulfillments: [],
          },
        ],
      }),
    }

    // Tripwire. If the workflow ever trusts the payload, it reaches deep into
    // the real fulfillment machinery and dies there on some incidental missing
    // stub — a failure that says nothing about WHY. Asserting here, on the
    // planner fed the same response the API just returned, makes a
    // payload-trusting regression fail while still naming the forged shipment.
    const plannedFromApi = planOrderStateActions(
      authoritativeOrder as never,
      []
    )
    expect(
      plannedFromApi.shipments.map((s) => s.printful_shipment_id)
    ).not.toContain(FORGED_SHIPMENT_ID)
    expect(plannedFromApi.shipments).toHaveLength(0)

    // A correct implementation completes cleanly. A payload-trusting one dives
    // into the real fulfillment machinery and throws somewhere inside it. Both
    // outcomes are captured so the assertions below decide the verdict, rather
    // than an incidental stack trace deciding it for us.
    let result: unknown
    let runError: unknown
    try {
      ;({ result } = await applyOrderStatusWorkflow(
        makeWorkflowContainer({
          [Modules.ORDER]: orderModuleStub,
          [Modules.FULFILLMENT]: fulfillmentModuleStub,
          [ContainerRegistrationKeys.QUERY]: queryStub,
          // Registered so a payload-trusting implementation gets all the way
          // INTO createOrderFulfillmentWorkflow and is recorded above, rather
          // than dying early on an unrelated missing registration.
          [ContainerRegistrationKeys.REMOTE_QUERY]: async () => [
            {
              id: MEDUSA_ORDER_ID,
              items: [
                {
                  id: "item_1",
                  quantity: 1,
                  detail: { fulfilled_quantity: 0 },
                },
              ],
            },
          ],
        })
      ).run({ input: { event_row_id: (stored as { id: string }).id } }))
    } catch (err) {
      runError = err
    }

    // The authoritative source was actually consulted.
    expect(
      getOrderCalls.some((u) => u.endsWith(`/orders/${PRINTFUL_ORDER_ID}`))
    ).toBe(true)

    // The heart of it: the API reported no shipments, so the run must have
    // reached the end with nothing fulfilled. Trying and failing to fulfill is
    // just as much a failure of this property as succeeding would be.
    expect(
      runError,
      `the run must not attempt any fulfillment work for a shipment the API never reported, but it threw: ${String(runError)}`
    ).toBeUndefined()
    expect(result).toMatchObject({
      status: "processed",
      shipments_created: 0,
    })

    // No Medusa fulfillment was created at all...
    expect(createdFulfillments).toHaveLength(0)

    // ...and specifically none carrying the forged shipment id.
    const forgedFulfillments = createdFulfillments.filter((f) =>
      JSON.stringify(f).includes(FORGED_SHIPMENT_ID)
    )
    expect(forgedFulfillments).toHaveLength(0)

    // The order link reflects the API's status, not the payload's lie.
    const link = await printful.findOrderLinkByPrintfulId(PRINTFUL_ORDER_ID)
    expect((link as { status: string }).status).toBe("pending")
    expect((link as { status: string }).status).not.toBe("fulfilled")
  })

  it("would have fulfilled had the API reported the very same shipment", async () => {
    // The control that makes the test above meaningful. Without it, "zero
    // fulfillments" could simply mean this code path never fulfills anything.
    //
    // Same order, same shipment id, same recorded-shipment state — the ONLY
    // thing changed is what the authoritative GET /orders/{id} reports. Feeding
    // both API responses through the very planner the workflow uses shows the
    // decision tracks the API and nothing else.
    const recorded: string[] = []

    const forgedCase = planOrderStateActions(
      authoritativeOrder as never,
      recorded
    )
    // The API says pending with no shipments: nothing to do.
    expect(forgedCase.shipments).toHaveLength(0)

    const apiReportsTheParcel = {
      ...authoritativeOrder,
      status: "fulfilled",
      shipments: [
        {
          id: Number(FORGED_SHIPMENT_ID),
          carrier: "USPS",
          service: "Ground",
          tracking_number: "REAL-TRACKING-1",
          items: [{ item_id: 55, quantity: 1 }],
        },
      ],
    }

    const honestCase = planOrderStateActions(
      apiReportsTheParcel as never,
      recorded
    )
    // Identical payload, identical shipment id — but now the API vouches for
    // it, and exactly one parcel is planned.
    expect(honestCase.shipments).toHaveLength(1)
    expect(honestCase.shipments[0].printful_shipment_id).toBe(
      FORGED_SHIPMENT_ID
    )
  })
})
