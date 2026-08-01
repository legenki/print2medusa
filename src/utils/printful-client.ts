import { PrintfulApiError, PrintfulConfigError } from "./errors"
import type {
  ListSyncProductsParams,
  PrintfulApiResponse,
  PrintfulCreateOrderInput,
  PrintfulOrder,
  PrintfulSyncProductDetail,
  PrintfulSyncProductSummary,
  PrintfulWebhookConfig,
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
}

const DEFAULT_BASE_URL = "https://api.printful.com"

export class PrintfulClient {
  private readonly apiToken: string
  private readonly storeId?: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly retryBaseMs: number

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
        const response = await this.fetchImpl(url, {
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
