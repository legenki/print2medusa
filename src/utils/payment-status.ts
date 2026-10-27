/** The fields of a payment collection the capture check reads. */
export type PaymentCollectionForCapture = {
  status?: string | null
  amount?: number | string | null
  captured_amount?: number | string | null
}

/**
 * Whether every live payment collection on an order has been captured in full.
 *
 * Mirrors the arithmetic of Medusa's own `getLastPaymentStatus`
 * (core-flows order/utils/aggregate-status.js) rather than trusting a status
 * string, since an authorized-but-uncaptured collection is exactly the case
 * this exists to catch. Canceled collections do not count either way, and an
 * order with no live collection is not paid.
 */
export function isFullyCaptured(
  collections: ReadonlyArray<PaymentCollectionForCapture> | null | undefined
): boolean {
  const live = (collections ?? []).filter((c) => c?.status !== "canceled")
  if (!live.length) {
    return false
  }
  return live.every((c) => {
    const amount = Number(c.amount ?? NaN)
    const captured = Number(c.captured_amount ?? 0)
    return Number.isFinite(amount) && captured >= amount
  })
}
