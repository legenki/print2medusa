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
  if (typeof configured !== "string" || typeof provided !== "string") {
    return false
  }
  if (!configured || !provided) {
    return false
  }
  const a = createHash("sha256").update(configured).digest()
  const b = createHash("sha256").update(provided).digest()
  return timingSafeEqual(a, b)
}

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
