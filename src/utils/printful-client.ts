import { PrintfulApiError, PrintfulConfigError } from "./errors"
import type {
  ListSyncProductsParams,
  PrintfulApiResponse,
  PrintfulCreateOrderInput,
  PrintfulOrder,
  PrintfulSyncProductDetail,
  PrintfulSyncProductSummary,
  PrintfulWebhookConfig,
  ShippingInfo,
  ShippingRatesRequest,
  PrintfulStatisticsParams,
  PrintfulStoreStatistics,
} from "./types"
import { PRINTFUL_WEBHOOK_TYPES } from "./webhook-events"

export type PrintfulClientOptions = {
  apiToken: string
  storeId?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  maxRetries?: number
  /** Base delay in ms for exponential backoff */
  retryBaseMs?: number
  /**
   * Per-attempt deadline in ms. Default 15000.
   *
   * Node's fetch bounds headers and body at 300s each and imposes no overall
   * deadline, so a Printful that hangs rather than fails would stall the
   * caller — multiplied by the retry count. That is tolerable on a background
   * sync and not on `validateFulfillmentData`, which since 0.7.0 runs inside
   * the customer's own "add shipping method" request.
   */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = "https://api.printful.com"

export class PrintfulClient {
  private readonly apiToken: string
  private readonly storeId?: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly timeoutMs: number

  constructor(options: PrintfulClientOptions) {
    if (!options.apiToken) {
      throw new PrintfulConfigError("Printful apiToken is required")
    }

    this.apiToken = options.apiToken
    this.storeId = options.storeId
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxRetries = options.maxRetries ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.timeoutMs =
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000
  }

  async listSyncProducts(params: ListSyncProductsParams = {}): Promise<{
    items: PrintfulSyncProductSummary[]
    paging?: PrintfulApiResponse<unknown>["paging"]
  }> {
    const search = new URLSearchParams()
    if (params.offset != null) {
      search.set("offset", String(params.offset))
    }
    if (params.limit != null) {
      search.set("limit", String(params.limit))
    }
    if (params.status) {
      search.set("status", params.status)
    }

    const qs = search.toString()
    const path = qs ? `/store/products?${qs}` : "/store/products"
    const data = await this.request<PrintfulSyncProductSummary[]>(path)

    return {
      items: data.result ?? [],
      paging: data.paging,
    }
  }

  async listAllSyncProducts(
    params: Omit<ListSyncProductsParams, "offset"> = {}
  ): Promise<PrintfulSyncProductSummary[]> {
    const limit = params.limit ?? 100
    let offset = 0
    const all: PrintfulSyncProductSummary[] = []

    for (;;) {
      const page = await this.listSyncProducts({
        ...params,
        offset,
        limit,
      })
      all.push(...page.items)

      const total = page.paging?.total
      offset += page.items.length

      if (page.items.length === 0) {
        break
      }
      if (total != null && offset >= total) {
        break
      }
      if (page.items.length < limit) {
        break
      }
    }

    return all
  }

  async getSyncProduct(
    id: number | string
  ): Promise<PrintfulSyncProductDetail> {
    const data = await this.request<PrintfulSyncProductDetail>(
      `/store/products/${id}`
    )
    return data.result
  }

  async createOrder(input: PrintfulCreateOrderInput): Promise<PrintfulOrder> {
    const confirm = input.confirm === true
    const path = confirm ? "/orders?confirm=1" : "/orders"
    const { confirm: _confirm, ...body } = input
    const data = await this.request<PrintfulOrder>(path, {
      method: "POST",
      body: JSON.stringify(body),
    })
    return data.result
  }

  async getOrder(id: number | string): Promise<PrintfulOrder> {
    const data = await this.request<PrintfulOrder>(`/orders/${id}`)
    return data.result
  }

  async cancelOrder(id: number | string): Promise<PrintfulOrder> {
    const data = await this.request<PrintfulOrder>(`/orders/${id}`, {
      method: "DELETE",
    })
    return data.result
  }

  async getWebhookConfig(): Promise<PrintfulWebhookConfig> {
    const data = await this.request<PrintfulWebhookConfig>("/webhooks")
    return data.result ?? { url: null, types: [] }
  }

  /**
   * Printful v1 keeps a single webhook configuration per store, so this
   * replaces the URL and the entire type list. Always pass the full allowlist —
   * a partial list silently drops the types you omit.
   */
  async setWebhookConfig(
    url: string,
    types: ReadonlyArray<(typeof PRINTFUL_WEBHOOK_TYPES)[number]>
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
    return data.result ?? { url: null, types: [] }
  }

  /**
   * Sales, costs and profit for a date range.
   *
   * Returns the per-store list, empty when Printful reports none — the admin
   * page maps over this, and a missing key must not crash the one screen whose
   * job is telling the owner what is going on.
   *
   * `currency` is omitted rather than defaulted when absent: Printful then
   * reports in the store's own currency, which is a different request from
   * asking for a specific one.
   */
  async getStatistics(
    params: PrintfulStatisticsParams
  ): Promise<PrintfulStoreStatistics[]> {
    const search = new URLSearchParams()
    search.set("date_from", params.dateFrom)
    search.set("date_to", params.dateTo)
    search.set("report_types", params.reportTypes)
    if (params.currency) {
      search.set("currency", params.currency)
    }

    const data = await this.request<{
      store_statistics?: PrintfulStoreStatistics[]
    }>(`/reports/statistics?${search.toString()}`)

    return data.result?.store_statistics ?? []
  }

  /**
   * Quote shipping for a cart. Returns every method Printful offers for that
   * destination in one response — the caller picks the one it needs.
   *
   * Setting `currency` asks Printful to convert the quote, so we never source
   * an exchange rate ourselves.
   */
  async getShippingRates(input: ShippingRatesRequest): Promise<ShippingInfo[]> {
    const data = await this.request<ShippingInfo[]>("/shipping/rates", {
      method: "POST",
      body: JSON.stringify(input),
    })
    return data.result ?? []
  }

  private async request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<PrintfulApiResponse<T>> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    }

    if (this.storeId) {
      headers["X-PF-Store-Id"] = this.storeId
    }

    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // A fresh signal per attempt. Sharing one would abort every retry the
        // moment the first attempt's deadline passed, turning a transient 500
        // into a permanent failure. A caller-supplied signal still wins.
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(this.timeoutMs),
          ...init,
          headers,
        })

        const text = await response.text()
        let json: PrintfulApiResponse<T> | null = null

        if (text) {
          try {
            json = JSON.parse(text) as PrintfulApiResponse<T>
          } catch {
            json = null
          }
        }

        if (!response.ok) {
          const message =
            json?.error?.message ||
            (typeof json?.result === "string" ? json.result : null) ||
            `Printful API error ${response.status}`

          const error = new PrintfulApiError(String(message), {
            status: response.status,
            reason: json?.error?.reason,
            body: json ?? text,
          })

          if (error.isRetryable && attempt < this.maxRetries) {
            await this.sleep(this.retryDelay(attempt, response))
            lastError = error
            continue
          }

          throw error
        }

        if (!json) {
          throw new PrintfulApiError("Empty or invalid JSON from Printful", {
            status: response.status,
            body: text,
          })
        }

        return json
      } catch (err) {
        lastError = err
        if (err instanceof PrintfulApiError && !err.isRetryable) {
          throw err
        }
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(attempt))
          continue
        }
        throw err
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PrintfulApiError("Printful request failed", { status: 0 })
  }

  private retryDelay(attempt: number, response?: Response): number {
    const retryAfter = response?.headers?.get?.("retry-after")
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds * 1000
      }
    }
    return this.retryBaseMs * Math.pow(2, attempt)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
