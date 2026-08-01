/**
 * The webhook secret travels in the URL path because Printful API v1's webhook
 * config accepts only `url`, `types` and `params` — there is no custom-header
 * support to carry it out of band. Everything here exists to keep that secret
 * out of logs.
 */

/** Path prefix of the public webhook endpoint; the next segment is the secret. */
const WEBHOOK_PATH = /^(\/hooks\/printful\/)[^/?#]+/

/**
 * Strip the secret from a webhook request path.
 *
 * Medusa's error handler logs `Error ${statusCode} at ${req.path}` verbatim
 * (@medusajs/framework/dist/http/middlewares/error-handler.js), so any error
 * raised for this route would otherwise write the live secret in cleartext.
 *
 * Pure and total: it never throws and never returns the original token, so it
 * is safe to call from an error path where input shape is not guaranteed.
 */
export function redactWebhookPath(path: string): string {
  if (typeof path !== "string") {
    return ""
  }
  return path.replace(WEBHOOK_PATH, "$1[redacted]")
}

/**
 * Body-parser size limit for the webhook route.
 *
 * Express defaults to 100KB, which real traffic exceeds: a `package_shipped`
 * body for a ~25-line-item order already measures ~132KB, and a 50-item order
 * ~262KB (modelled from Printful's published OpenAPI shapes with 6 print files
 * per item and realistic CDN URLs). Under the default, such a delivery is
 * rejected with a 413 raised by the GLOBAL body-parser — which runs before any
 * route-scoped middleware and therefore reaches the error handler with the
 * un-redacted path, leaking the live secret.
 *
 * 1MB clears the measured worst case with roughly 4x headroom while staying
 * bounded, so the public endpoint is not an unbounded memory sink.
 */
export const WEBHOOK_BODY_SIZE_LIMIT = "1mb"
