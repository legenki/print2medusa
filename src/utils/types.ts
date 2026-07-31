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
    id: number
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
