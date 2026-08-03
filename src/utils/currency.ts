import { defaultCurrencies } from "@medusajs/framework/utils"

/**
 * How many minor units make one major unit of a currency.
 *
 * Most currencies have 100 — $12.34 is stored as 1234. Some have none at all:
 * ¥1500 is fifteen hundred yen, and Medusa stores it as 1500, not 150000.
 * Scaling those by 100 anyway produces a value a hundredfold too large for
 * anything reading it back with Medusa's own conventions.
 *
 * The table is Medusa's `defaultCurrencies` (126 entries, each carrying
 * `decimal_digits`) rather than a list written out here. A hand-kept list is
 * how HUF, ISK and CLP get missed — they are zero-decimal and rarely on the
 * short list people remember. `@medusajs/framework` is a peer dependency, so
 * the table is always present in a host app; this is plain data, not a
 * container binding, so `src/utils/` stays testable without one.
 */
export function minorUnitFactor(
  currencyCode: string | null | undefined
): number {
  return isZeroDecimalCurrency(currencyCode) ? 1 : 100
}

/**
 * True when the currency has no subunit.
 *
 * An unrecognized or missing code answers `false`. Two decimals is the
 * overwhelming default, and the asymmetry matters: guessing zero for a
 * currency that has subunits deflates every amount by 100, while guessing two
 * for an unrecognized zero-decimal currency inflates it — but only for a
 * currency Medusa itself does not know, which cannot be a Medusa region's
 * currency in the first place.
 */
export function isZeroDecimalCurrency(
  currencyCode: string | null | undefined
): boolean {
  if (!currencyCode) {
    return false
  }
  // Printful sends "USD", Medusa stores "usd", and both reach this.
  const entry = defaultCurrencies[currencyCode.toUpperCase()]
  return entry?.decimal_digits === 0
}
