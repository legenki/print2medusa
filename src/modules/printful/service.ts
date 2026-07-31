import { MedusaService } from "@medusajs/framework/utils"
import { PrintfulClient } from "../../utils/printful-client"
import type { PrintfulPluginOptions } from "../../utils/types"
import PrintfulOrderLink from "./models/printful-order-link"
import PrintfulProductLink from "./models/printful-product-link"
import PrintfulSyncLog from "./models/printful-sync-log"
import PrintfulVariantLink from "./models/printful-variant-link"
import PrintfulWebhookEvent from "./models/printful-webhook-event"

type InjectedDependencies = Record<string, unknown>

/** Sentinel stored in a placeholder link before the Printful order exists. */
export const PENDING_PRINTFUL_ORDER_ID = "pending"

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505) regardless of
 * how the ORM wraps the driver error. Used to turn a lost insert race into a
 * clean "already claimed" signal instead of a thrown error.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false
  }
  const e = err as { code?: string; cause?: unknown; message?: string }
  if (e.code === "23505") {
    return true
  }
  if (typeof e.message === "string" && e.message.includes("23505")) {
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

  constructor(container: InjectedDependencies, options?: PrintfulPluginOptions) {
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
}

export default PrintfulModuleService
