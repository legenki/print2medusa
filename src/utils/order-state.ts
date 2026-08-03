import type { PrintfulOrder } from "./types"
import { planCostMetadata } from "./costs"

export type PlannedShipmentItem = {
  /** Printful line item id; join to Medusa via the order item's external_id. */
  item_id: number
  quantity: number
}

export type PlannedShipment = {
  printful_shipment_id: string
  carrier?: string
  service?: string
  tracking_number?: string
  tracking_url?: string
  ship_date?: string
  /** True when Printful re-shipped this parcel. */
  reshipment?: boolean
  /**
   * Items in this parcel. Undefined when Printful omitted the breakdown, which
   * callers must treat as "unknown", not as "empty".
   */
  items?: PlannedShipmentItem[]
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
 * has already recorded. Performs nothing — returns intent. The decision logic
 * is deterministic; only the `printful_status_updated_at` breadcrumb reads the
 * clock.
 *
 * The caller passes the order fetched from GET /orders/{id} — never the webhook
 * payload, which is untrusted.
 *
 * Printful splits orders across facilities, so every unrecorded shipment
 * becomes its own planned entry rather than one action closing the order.
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
    reshipment: s.reshipment,
    // Left undefined when Printful omits the breakdown so the caller can tell
    // "no item data" apart from "a parcel containing nothing".
    items: s.items?.map((i) => ({
      item_id: Number(i.item_id),
      quantity: Number(i.quantity),
    })),
  }))

  return {
    shipments: allShipments.filter(
      (s) => !recorded.has(s.printful_shipment_id)
    ),
    metadata: {
      // Spread first so a status key always wins a name collision rather than
      // being silently overwritten by a cost key.
      ...planCostMetadata(order),
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
        // A reshipment clamps to zero remaining quantity in apply-order-status,
        // so it produces no Medusa fulfillment and this metadata entry is the
        // only record of the replacement parcel's tracking. Normalized to a
        // boolean because Printful omits the field on ordinary parcels.
        reshipment: s.reshipment ?? false,
      })),
    },
    needsAttention: ATTENTION_STATES.has(order.status),
  }
}
