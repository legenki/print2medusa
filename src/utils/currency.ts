/**
 * How many minor units make one major unit of a currency.
 *
 * Most currencies have 100 — $12.34 is stored as 1234. Some have none at all:
 * ¥1500 is fifteen hundred yen, and Medusa stores it as 1500, not 150000.
 * Scaling those by 100 anyway produces a value a hundredfold too large for
 * anything reading it back with Medusa's own conventions.
 *
 * **Why the list is written out here rather than imported.** It used to come
 * from `defaultCurrencies` in `@medusajs/framework/utils`, which is correct for
 * server code and fatal for the browser: this file is also imported by the
 * admin order widget, and `@medusajs/framework/utils` reaches
 * `@medusajs/utils/dist/auth/token.js` → `jsonwebtoken` → `jws`, which calls
 * `util.inherits`. That does not exist in a browser, so the whole Medusa admin
 * failed to load with `chr.inherits is not a function` — not a broken widget,
 * a blank admin.
 *
 * The usual objection to a hand-kept list is that HUF, ISK and CLP get missed.
 * That is answered by a test rather than by discipline: `currency.test.ts`
 * compares this set against Medusa's own table and fails if they diverge, so
 * the data stays Medusa's while the import stays server-side.
 */

/**
 * Currencies with no subunit, from Medusa's `defaultCurrencies`
 * (`decimal_digits === 0`). Kept in sync by test, not by hand.
 *
 * Exported so `currency.test.ts` can compare the set itself against Medusa's
 * table in both directions — a code invented here is invisible to any check
 * that only walks Medusa's side.
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "AFN",
  "ALL",
  "AMD",
  "BIF",
  "CLP",
  "COP",
  "CRC",
  "DJF",
  "GNF",
  "HUF",
  "IDR",
  "IQD",
  "IRR",
  "IRT",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "LBP",
  "MGA",
  "MMK",
  "MNT",
  "MUR",
  "PKR",
  "PYG",
  "RSD",
  "RWF",
  "SOS",
  "SYP",
  "TZS",
  "UGX",
  "UZS",
  "VND",
  "XAF",
  "XOF",
  "XPF",
  "YER",
  "ZMK",
  "ZWL",
])

/**
 * Currencies with three decimal places rather than two.
 *
 * Dinars, mostly. 1 KWD is 1000 fils, so a price Medusa stores as 1.234
 * is 1234 minor units — not 123, which is what scaling by 100 produces.
 * Six currencies, and the same test that guards the zero-decimal set above
 * compares this one against Medusa's `decimal_digits` in both directions.
 */
export const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
])

/** True when the currency has three decimal places instead of two. */
export function isThreeDecimalCurrency(
  currencyCode: string | null | undefined
): boolean {
  if (!currencyCode) {
    return false
  }
  return THREE_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())
}

export function minorUnitFactor(
  currencyCode: string | null | undefined
): number {
  if (isZeroDecimalCurrency(currencyCode)) {
    return 1
  }
  if (isThreeDecimalCurrency(currencyCode)) {
    return 1000
  }
  return 100
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
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())
}
