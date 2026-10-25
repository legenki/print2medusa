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

  // Items are left undefined when Printful omits the breakdown so the caller
  // can tell "no item data" apart from "a parcel containing nothing".
  const allShipments = allPlannedShipments(order)

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

/** Fulfillment metadata key that ties a Medusa fulfillment to a Printful parcel. */
export const SHIPMENT_ID_KEY = "printful_shipment_id"

export type ShipmentLabel = {
  tracking_number: string
  tracking_url: string
  label_url: string
}

/** Labels Medusa records for one parcel. Empty when there is no tracking yet. */
export function labelsFor(shipment: {
  tracking_number?: string
  tracking_url?: string
}): ShipmentLabel[] {
  return shipment.tracking_number
    ? [
        {
          tracking_number: shipment.tracking_number,
          tracking_url: shipment.tracking_url ?? "",
          // Printful's v1 Shipment schema exposes no customer-facing label
          // URL. Empty beats a plausible-looking wrong link.
          label_url: "",
        },
      ]
    : []
}

/** A Medusa fulfillment as the webhook path reads it through Query. */
export type RecordedFulfillment = {
  id: string
  metadata?: Record<string, unknown> | null
  shipped_at?: Date | string | null
  canceled_at?: Date | string | null
  items?: Array<{ line_item_id?: string | null; quantity?: number }> | null
}

/**
 * Printful parcels Medusa already holds a live fulfillment for.
 *
 * A canceled fulfillment does not count: the parcel exists whatever happened
 * to its Medusa record, so it must be recorded again rather than vanish.
 */
export function recordedShipmentIds(
  fulfillments: RecordedFulfillment[]
): string[] {
  return fulfillments
    .filter((f) => !f.canceled_at)
    .map((f) => f.metadata?.[SHIPMENT_ID_KEY])
    .filter((v): v is string => typeof v === "string")
}

export type ShipmentRepair = {
  fulfillment_id: string
  items: { id: string; quantity: number }[]
  labels: ShipmentLabel[]
}

/**
 * Parcel fulfillments that were created but never marked shipped.
 *
 * Recording a parcel is two workflows — create the fulfillment, then the
 * shipment — and the fulfillment is what marks the parcel as recorded. A
 * failure between the two left it unshipped for good: every retry saw the
 * parcel as done. This finds those so the shipment can be completed.
 */
export function planShipmentRepairs(
  fulfillments: RecordedFulfillment[],
  shipments: PlannedShipment[]
): ShipmentRepair[] {
  const byId = new Map(shipments.map((s) => [s.printful_shipment_id, s]))
  const repairs: ShipmentRepair[] = []

  for (const f of fulfillments) {
    const shipmentId = f.metadata?.[SHIPMENT_ID_KEY]
    if (typeof shipmentId !== "string" || f.shipped_at || f.canceled_at) {
      continue
    }
    const items = (f.items ?? [])
      .filter((i) => i.line_item_id && Number(i.quantity) > 0)
      .map((i) => ({
        id: i.line_item_id as string,
        quantity: Number(i.quantity),
      }))
    if (!items.length) {
      continue
    }
    repairs.push({
      fulfillment_id: f.id,
      items,
      labels: labelsFor(byId.get(shipmentId) ?? {}),
    })
  }

  return repairs
}

/** Every parcel on a Printful order, recorded or not, in Printful's order. */
export function allPlannedShipments(order: PrintfulOrder): PlannedShipment[] {
  return (order.shipments ?? []).map((s) => ({
    printful_shipment_id: String(s.id),
    carrier: s.carrier,
    service: s.service,
    tracking_number: s.tracking_number,
    tracking_url: s.tracking_url,
    ship_date: s.ship_date,
    reshipment: s.reshipment,
    items: s.items?.map((i) => ({
      item_id: Number(i.item_id),
      quantity: Number(i.quantity),
    })),
  }))
}
