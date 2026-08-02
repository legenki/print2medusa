export type PrintfulPluginOptions = {
  apiToken: string
  storeId?: string
  /** When true, confirm Printful draft orders for fulfillment immediately */
  autoSubmitOrders?: boolean
  /** Also listen to order.placed (for capture-on-place flows) */
  createOnOrderPlaced?: boolean
  /** Skip non-Printful line items instead of failing the whole order */
  allowPartialOrders?: boolean
  /** Default currency for mapped prices when missing (lowercase ISO) */
  defaultCurrency?: string
  /** Markup percent applied to Printful retail prices on sync */
  markupPercent?: number
  webhookSecret?: string
  /** Enable live shipping rates. Requires fallbackShippingRates. */
  liveShippingRates?: boolean
  /** Flat rate per method id, in minor units. Required when live rates are on. */
  fallbackShippingRates?: Record<string, number>
  /** How long a quote counts as fresh. Default 600. */
  shippingRateCacheTtlSeconds?: number
  /** How long a quote is retained for emergency use. Default 86400. */
  shippingRateStaleSeconds?: number
}

export type PrintfulApiResponse<T> = {
  code: number
  result: T
  error?: {
    reason?: string
    message?: string
  }
  paging?: {
    total: number
    offset: number
    limit: number
  }
}

export type PrintfulSyncProductSummary = {
  id: number
  external_id: string | null
  name: string
  variants: number
  synced: number
  thumbnail_url?: string | null
  is_ignored?: boolean
}

export type PrintfulSyncFile = {
  id?: number
  type?: string
  url?: string
  preview_url?: string
  thumbnail_url?: string
}

export type PrintfulSyncVariant = {
  id: number
  external_id?: string | null
  sync_product_id: number
  name: string
  synced?: boolean
  variant_id?: number | null
  retail_price?: string | null
  currency?: string
  sku?: string | null
  product?: {
    variant_id?: number
    product_id?: number
    image?: string
    name?: string
  }
  files?: PrintfulSyncFile[]
  size?: string | null
  color?: string | null
  availability_status?: string
}

export type PrintfulSyncProductDetail = {
  sync_product: PrintfulSyncProductSummary & {
    id: number
  }
  sync_variants: PrintfulSyncVariant[]
}

export type PrintfulRecipient = {
  name: string
  address1: string
  address2?: string
  city: string
  state_code?: string
  country_code: string
  zip: string
  phone?: string
  email?: string
}

export type PrintfulOrderItemInput = {
  sync_variant_id: number
  quantity: number
  retail_price?: string
  name?: string
  external_id?: string
}

export type PrintfulCreateOrderInput = {
  external_id?: string
  shipping?: string
  recipient: PrintfulRecipient
  items: PrintfulOrderItemInput[]
  confirm?: boolean
}

export type PrintfulOrder = {
  id: number
  external_id?: string | null
  status: string
  shipping?: string
  created?: number
  updated?: number
  recipient?: PrintfulRecipient
  items?: Array<{
    /** Printful line item id, referenced by OrderShipmentItem.item_id. */
    id: number
    /** Line item id from the external system — we set the Medusa line item id. */
    external_id?: string
    variant_id?: number
    sync_variant_id?: number
    quantity: number
    name?: string
  }>
  shipments?: Array<{
    id: number
    carrier?: string
    service?: string
    tracking_number?: string
    tracking_url?: string
    ship_date?: string
    /** True when Printful re-shipped a parcel; must not be double-counted. */
    reshipment?: boolean
    /** Per-parcel item breakdown. Absent on older/partial payloads. */
    items?: Array<{
      item_id: number
      quantity: number
      picked?: number
      printed?: number
    }>
  }>
}

export type ListSyncProductsParams = {
  offset?: number
  limit?: number
  status?: string
}

export type PrintfulWebhookConfig = {
  url: string | null
  types: string[]
  params?: Record<string, unknown>
}

/** One shipping method returned by POST /shipping/rates. */
export type ShippingInfo = {
  id: string
  name: string
  /** Decimal string, e.g. "4.99" — never parse this as a float for money. */
  rate: string
  currency: string
  minDeliveryDays?: number
  maxDeliveryDays?: number
  minDeliveryDate?: string
  maxDeliveryDate?: string
}

/** One item in a shipping rate request. */
export type ShippingRateItem = {
  /** Printful Catalog variant id. */
  variant_id: number
  quantity: number
  /** Item retail value; helps Printful compute duties. */
  value?: string
}

export type ShippingRatesRequest = {
  recipient: {
    address1?: string
    address2?: string
    city?: string
    state_code?: string
    country_code: string
    zip?: string
    phone?: string
  }
  items: ShippingRateItem[]
  /** Printful converts the quote into this currency when set. */
  currency?: string
  locale?: string
}

/**
 * A cached rate response. Stored with the STALE ttl, not the freshness ttl —
 * freshness is decided from `cached_at`, so an expired-but-retained quote can
 * still serve as a fallback.
 */
export type CachedQuote = {
  rates: ShippingInfo[]
  currency: string
  cached_at: number
}

/** Where a returned price came from. Recorded on the shipping method. */
export type RateSource =
  | "live"
  | "fresh_cache"
  | "stale_cache"
  | "flat_fallback"
  | "misconfigured_zero"

/** Why a live quote was not used. */
export type FallbackReason =
  | "printful_unreachable"
  | "method_unavailable"
  | "currency_mismatch"
  | "incomplete_address"
  | "no_printful_items"
  | "query_unavailable"
  | "misconfigured_zero"
