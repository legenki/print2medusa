/**
 * Printful reports money as JSON numbers in major units (12.34), and Medusa
 * stores integer minor units (1234). Everything crossing that boundary goes
 * through here.
 *
 * `undefined` means "we could not trust this value" and is deliberately
 * distinct from `0`. Reporting an unparseable cost as zero would show the
 * owner a 100% margin on an order that in fact cost them money.
 */
export function toMinorUnits(
  value: string | number | null | undefined
): number | undefined {
  if (value === null || value === undefined || value === "") {
    return 0
  }

  let n: number
  if (typeof value === "number") {
    n = value
  } else if (typeof value === "string") {
    // Number() rejects trailing garbage that parseFloat would silently accept:
    // Number("4.99abc") is NaN, parseFloat("4.99abc") is 4.99.
    n = Number(value)
  } else {
    return undefined
  }

  if (!Number.isFinite(n)) {
    return undefined
  }

  return Math.round(n * 100)
}
