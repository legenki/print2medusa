import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Container, Heading, Text } from "@medusajs/ui"

type PrintfulShipment = {
  id: string
  carrier?: string
  service?: string
  tracking_number?: string
  tracking_url?: string
  ship_date?: string
}

/** Printful states that mean a human should look at the order; mirrors order-state.ts. */
const ATTENTION_STATES = new Set(["failed", "canceled", "onhold"])

const PrintfulOrderWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>
  const printfulOrderId = metadata.printful_order_id as string | undefined

  if (!printfulOrderId) {
    return null
  }

  const status = metadata.printful_status as string | undefined
  const statusUpdatedAt = metadata.printful_status_updated_at as
    | string
    | undefined
  const shipments = (metadata.printful_shipments ?? []) as PrintfulShipment[]

  const isAttention = status ? ATTENTION_STATES.has(status) : false

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Printful</Heading>
        {status ? (
          <Badge color={isAttention ? "red" : "green"}>{status}</Badge>
        ) : null}
      </div>
      <div className="px-6 py-4 flex flex-col gap-2">
        <Text size="small">
          Printful order: <strong>{printfulOrderId}</strong>
        </Text>
        {shipments.length > 0 ? (
          <div className="flex flex-col gap-3 pt-1">
            {shipments.map((shipment) => (
              <div key={shipment.id} className="flex flex-col gap-0.5">
                <Text size="small">
                  {shipment.carrier ?? "Unknown carrier"}
                  {shipment.service ? ` · ${shipment.service}` : ""}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  {shipment.ship_date
                    ? `Shipped ${new Date(shipment.ship_date).toLocaleDateString()}`
                    : "Ship date pending"}
                </Text>
                {shipment.tracking_number ? (
                  shipment.tracking_url ? (
                    <a
                      href={shipment.tracking_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-ui-fg-interactive text-sm hover:underline"
                    >
                      {shipment.tracking_number}
                    </a>
                  ) : (
                    <Text size="small">{shipment.tracking_number}</Text>
                  )
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            No shipments yet.
          </Text>
        )}
        {statusUpdatedAt ? (
          <Text size="small" className="text-ui-fg-subtle pt-1">
            Last synced: {new Date(statusUpdatedAt).toLocaleString()}
          </Text>
        ) : null}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.before",
})

export default PrintfulOrderWidget
