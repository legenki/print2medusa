import { MedusaService } from "@medusajs/framework/utils"
import { createHash } from "crypto"
import { PrintfulClient } from "../../utils/printful-client"
import type { PrintfulPluginOptions } from "../../utils/types"
import PrintfulOrderLink from "./models/printful-order-link"
import PrintfulProductLink from "./models/printful-product-link"
import PrintfulSyncLog from "./models/printful-sync-log"
import PrintfulVariantLink from "./models/printful-variant-link"
import PrintfulWebhookEvent from "./models/printful-webhook-event"

type InjectedDependencies = Record<string, unknown>

/**
 * Minimal shape of MikroORM's SqlEntityManager that we depend on.
 *
 * `baseRepository_` is assigned by MedusaService's constructor from
 * `container.baseRepository` (see @medusajs/utils AbstractModuleService_), but
 * it is not part of the factory's declared return type, so a subclass has to
 * redeclare it to reach `getActiveManager()`.
 */
type SqlLikeManager = {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>
}

type BaseRepositoryLike = {
  getActiveManager<TManager = unknown>(context?: {
    transactionManager?: unknown
    manager?: unknown
  }): TManager
  transaction<T>(
    task: (manager: SqlLikeManager) => Promise<T>,
    options?: unknown
  ): Promise<T>
}

/**
 * Sentinel stored in a placeholder link before the Printful order exists.
 *
 * Migration20260731000000 excludes this exact value from the unique index on
 * printful_order_id. Changing it without updating that migration reintroduces
 * the concurrent-claim race; tests/order-link.test.ts guards the pairing.
 */
export const PENDING_PRINTFUL_ORDER_ID = "pending"

/** Attempts before an event is parked as permanently failed. */
export const MAX_WEBHOOK_ATTEMPTS = 20

/** Backoff: 5 minutes doubling per attempt, capped at 6 hours. */
export function nextRetryDelayMs(attempts: number): number {
  const FIVE_MINUTES = 5 * 60 * 1000
  const SIX_HOURS = 6 * 60 * 60 * 1000
  return Math.min(FIVE_MINUTES * Math.pow(2, attempts), SIX_HOURS)
}

/**
 * Stable 32-bit key for pg_advisory_xact_lock, derived from the order id.
 *
 * readInt32BE yields a signed 32-bit integer, which is exactly the width
 * pg_advisory_xact_lock's single-argument form takes. The order id itself never
 * reaches SQL — only this number does, and it is passed as a bind parameter.
 *
 * 32 bits means distinct orders can collide (~2 per 200k ids). A collision
 * only serializes two unrelated orders against each other, which is slower
 * but never incorrect, so the simpler single-argument lock form is worth it.
 */
export function lockKeyFor(printfulOrderId: string): number {
  const digest = createHash("sha256").update(String(printfulOrderId)).digest()
  return digest.readInt32BE(0)
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505) regardless of
 * how the ORM wraps the driver error. Used to turn a lost insert race into a
 * clean "already claimed" signal instead of a thrown error.
 *
 * The mapped-MedusaError branch is load-bearing and cannot be dropped. Medusa's
 * dbErrorMapper (@medusajs/utils dal/mikro-orm/db-error-mapper) intercepts the
 * driver's 23505 and throws a BRAND NEW MedusaError carrying only
 * `type: "invalid_data"` and a prose message ending "already exists." — no
 * `code`, no `cause` chain, and no "23505" anywhere in the text. Every other
 * branch here misses it. Without this check a redelivered webhook (which
 * Printful sends by design) surfaces as a 500 instead of being absorbed as a
 * duplicate, and Printful then retries an event that can never succeed.
 * Verified against a real Postgres in tests/webhook-route.integration.test.ts.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false
  }
  const e = err as {
    code?: string
    cause?: unknown
    message?: string
    type?: string
  }
  if (e.code === "23505") {
    return true
  }
  if (typeof e.message === "string" && e.message.includes("23505")) {
    return true
  }
  if (
    e.type === "invalid_data" &&
    typeof e.message === "string" &&
    /already exists\.?$/i.test(e.message.trim())
  ) {
    return true
  }
  if (e.cause && e.cause !== err) {
    return isUniqueViolation(e.cause)
  }
  return false
}

class PrintfulModuleService extends MedusaService({
  PrintfulProductLink,
  PrintfulVariantLink,
  PrintfulSyncLog,
  PrintfulOrderLink,
  PrintfulWebhookEvent,
}) {
  protected options_: PrintfulPluginOptions
  protected client_: PrintfulClient | null = null
  /** Injected by MedusaService's constructor; see BaseRepositoryLike above. */
  declare protected baseRepository_: BaseRepositoryLike

  constructor(
    container: InjectedDependencies,
    options?: PrintfulPluginOptions
  ) {
    // MedusaService multi-arg constructor
    super(...arguments)
    this.options_ = options ?? ({} as PrintfulPluginOptions)
  }

  async getOptions(): Promise<PrintfulPluginOptions> {
    return this.options_
  }

  async getClient(): Promise<PrintfulClient> {
    if (!this.client_) {
      if (!this.options_?.apiToken) {
        throw new Error(
          "Printful apiToken is missing. Set it in plugin options (PRINTFUL_API_TOKEN)."
        )
      }
      this.client_ = new PrintfulClient({
        apiToken: this.options_.apiToken,
        storeId: this.options_.storeId,
      })
    }
    return this.client_
  }

  async getStoreId(): Promise<string> {
    return this.options_?.storeId ?? "default"
  }

  async findProductLink(syncProductId: string) {
    const storeId = await this.getStoreId()
    const [link] = await this.listPrintfulProductLinks({
      printful_store_id: storeId,
      printful_sync_product_id: String(syncProductId),
    })
    return link ?? null
  }

  async findVariantLink(syncVariantId: string) {
    const storeId = await this.getStoreId()
    const [link] = await this.listPrintfulVariantLinks({
      printful_store_id: storeId,
      printful_sync_variant_id: String(syncVariantId),
    })
    return link ?? null
  }

  async findVariantLinkByMedusaId(medusaVariantId: string) {
    const [link] = await this.listPrintfulVariantLinks({
      medusa_variant_id: medusaVariantId,
    })
    return link ?? null
  }

  async findOrderLink(medusaOrderId: string) {
    const [link] = await this.listPrintfulOrderLinks({
      medusa_order_id: medusaOrderId,
    })
    return link ?? null
  }

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

  /**
   * Events due for another processing attempt, most overdue first. Ordering by
   * next_retry_at (not created_at) lets the ("status", "next_retry_at") index
   * satisfy the sort instead of paying an explicit Sort node on every sweep.
   */
  async listDueWebhookEvents(limit = 50) {
    return this.listPrintfulWebhookEvents(
      {
        status: ["received", "deferred"],
        next_retry_at: { $lte: new Date() },
        attempts: { $lt: MAX_WEBHOOK_ATTEMPTS },
      },
      { take: limit, order: { next_retry_at: "ASC" } }
    )
  }

  /**
   * Serialize work per Printful order. Two events for one order must not be
   * applied concurrently: both could pass the "shipment already recorded"
   * check before either writes, producing two fulfillments for one parcel.
   * Different orders remain parallel.
   *
   * This provides serialization, NOT atomicity. Work performed inside `fn`
   * (core-flow runs, module-service writes) uses its own managers and commits
   * independently of this transaction, so a later failure does not roll the
   * earlier writes back. Callers must not assume all-or-nothing semantics.
   *
   * Uses the transaction-scoped lock deliberately. The session-scoped variant
   * cannot work here: getActiveManager() forks without a transaction context,
   * so knex takes a fresh pool connection per statement and the unlock can land
   * on a different connection than the lock — leaking the lock permanently.
   * pg_advisory_xact_lock is released by Postgres on commit or rollback.
   */
  async withOrderLock<T>(
    printfulOrderId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = lockKeyFor(printfulOrderId)
    return this.baseRepository_.transaction(
      async (txManager: SqlLikeManager) => {
        await txManager.execute("select pg_advisory_xact_lock(?)", [key])
        return await fn()
      }
    )
  }

  /**
   * Atomically claim an order for Printful creation. Relies on the unique index
   * on `medusa_order_id` so that concurrent captures cannot both proceed to
   * `client.createOrder` — the loser hits a unique-constraint violation and is
   * reported as `claimed: false`, avoiding duplicate Printful orders.
   *
   * Returns the created placeholder link on success, or null if already claimed.
   */
  async claimOrderLink(medusaOrderId: string): Promise<{
    id: string
    printful_order_id: string
  } | null> {
    try {
      const link = await this.createPrintfulOrderLinks({
        medusa_order_id: medusaOrderId,
        printful_order_id: PENDING_PRINTFUL_ORDER_ID,
        external_id: medusaOrderId,
        status: "pending",
      })
      return link
    } catch (err) {
      if (isUniqueViolation(err)) {
        return null
      }
      throw err
    }
  }

  async getLatestSyncLog() {
    const logs = await this.listPrintfulSyncLogs(
      {},
      { take: 1, order: { started_at: "DESC" } }
    )
    return logs[0] ?? null
  }

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
      $or: [{ heartbeat_at: { $lt: cutoff } }, { heartbeat_at: null }],
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
  async claimSyncLog(staleMinutes: number): Promise<{ id: string } | null> {
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

  /**
   * Clear a specific stuck sync on an operator's instruction.
   *
   * Separate from `reapStaleSyncLogs` on purpose. That one is the timeout
   * reaper: it selects its own victims by age and stamps them `stale_running`.
   * This one clears exactly the row the operator was looking at and records a
   * marker naming them as the cause, so the two are distinguishable in the log
   * long after the fact.
   *
   * The `heartbeat_at` predicate makes the write conditional on the row still
   * being as stale as the caller observed. Between the route's read and this
   * write, a sync everyone believed dead can emit one more heartbeat; without
   * this predicate that row would be marked `failed` underneath a live
   * process. With it, the late heartbeat moves `heartbeat_at` past the
   * observed value, the update matches nothing, and the caller is told the
   * sync is alive after all.
   *
   * Returns true when a row was actually cleared.
   */
  async clearStuckSyncLog(input: {
    id: string
    /** The heartbeat the caller based its decision on; null if there was none. */
    observedHeartbeatAt: Date | null
    errorMessage: string
  }): Promise<boolean> {
    const stillStale = await this.listPrintfulSyncLogs({
      id: input.id,
      status: "running",
      heartbeat_at: input.observedHeartbeatAt
        ? { $lte: input.observedHeartbeatAt }
        : null,
    })

    if (stillStale.length === 0) {
      return false
    }

    await this.updatePrintfulSyncLogs({
      id: input.id,
      status: "failed",
      error_message: input.errorMessage,
      finished_at: new Date(),
    })

    return true
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
}

export default PrintfulModuleService
