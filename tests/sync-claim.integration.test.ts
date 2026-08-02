import { MedusaModule } from "@medusajs/framework/modules-sdk"
import {
  ContainerRegistrationKeys,
  createPgConnection,
  Module,
  ModulesSdkUtils,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PRINTFUL_MODULE } from "../src/modules/printful"
import { Migration20260726000000 } from "../src/modules/printful/migrations/Migration20260726000000"
import { Migration20260731000000 } from "../src/modules/printful/migrations/Migration20260731000000"
import { Migration20260802000000 } from "../src/modules/printful/migrations/Migration20260802000000"
import PrintfulOrderLink from "../src/modules/printful/models/printful-order-link"
import PrintfulProductLink from "../src/modules/printful/models/printful-product-link"
import PrintfulSyncLog from "../src/modules/printful/models/printful-sync-log"
import PrintfulVariantLink from "../src/modules/printful/models/printful-variant-link"
import PrintfulWebhookEvent from "../src/modules/printful/models/printful-webhook-event"
import PrintfulModuleServiceClass from "../src/modules/printful/service"
import type PrintfulModuleService from "../src/modules/printful/service"

/**
 * Integration tests for the atomic sync claim, run against a real Postgres.
 *
 * The harness is the one established in tests/webhook-route.integration.test.ts
 * — see the long note there for why `medusaIntegrationTestRunner` and
 * `initModules` cannot work in a plugin repo with no root `medusa-config.ts`.
 *
 * What only a real database can prove here: that two concurrent `claimSyncLog`
 * calls cannot both succeed. The guarantee lives entirely in the partial unique
 * index created by Migration20260802000000; nothing in the TypeScript would
 * change if that index were missing, which is exactly why this file exists.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://andy@localhost:5432/print2medusa_test"

type Pg = ReturnType<typeof createPgConnection>

let pg: Pg
let service: PrintfulModuleService

/** Collect a migration's SQL without a MikroORM driver, then run it directly. */
async function runMigration(
  MigrationClass:
    | typeof Migration20260726000000
    | typeof Migration20260731000000
    | typeof Migration20260802000000
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

beforeAll(async () => {
  pg = createPgConnection({ clientUrl: DATABASE_URL, schema: "public" })

  await runMigration(Migration20260726000000)
  await runMigration(Migration20260731000000)
  await runMigration(Migration20260802000000)

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

  service = loaded[PRINTFUL_MODULE]
})

afterAll(async () => {
  MedusaModule.clearInstances()
  await pg.destroy()
})

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

    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it("refuses a claim while another sync is running", async () => {
    expect(await service.claimSyncLog(60)).toBeTruthy()
    expect(await service.claimSyncLog(60)).toBeNull()
  })

  it("allows a claim once the running sync's heartbeat is stale", async () => {
    const first = await service.claimSyncLog(60)
    expect(first).toBeTruthy()

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

  it("reaps a running sync that never got a heartbeat", async () => {
    const first = await service.claimSyncLog(60)
    await service.updatePrintfulSyncLogs({
      id: first!.id,
      heartbeat_at: null,
    })

    expect(await service.claimSyncLog(60)).toBeTruthy()
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

  it("reports the running sync for a 409 body", async () => {
    const claim = await service.claimSyncLog(60)
    const running = await service.getRunningSyncLog()

    expect(running?.id).toBe(claim!.id)
    expect(running?.started_at).toBeTruthy()
    expect(running?.heartbeat_at).toBeTruthy()
  })

  it("records progress through the heartbeat", async () => {
    const claim = await service.claimSyncLog(60)
    await service.heartbeatSyncLog(claim!.id, {
      products_processed: 7,
      products_total: 42,
    })

    const log = await service.retrievePrintfulSyncLog(claim!.id)
    expect(log.products_processed).toBe(7)
    expect(log.products_total).toBe(42)
  })
})
