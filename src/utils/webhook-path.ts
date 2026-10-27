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

/** Hosts where an `http:` webhook URL keeps the secret on this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export type WebhookUrlResult =
  { ok: true; url: string } | { ok: false; reason: string }

/**
 * The URL to register with Printful for a store at `baseUrl`.
 *
 * The secret rides in this URL, so its shape is checked rather than trusted:
 *
 * - `https:` only, because over `http:` the secret crosses the network in
 *   cleartext with every delivery. Loopback hosts are exempt for local work.
 * - No query string or fragment. Either would leave the secret somewhere other
 *   than the last path segment, which is the only part `GET
 *   /admin/printful/webhook` masks — the admin would be shown the live secret.
 * - No credentials, which Printful would store and echo back.
 *
 * A path prefix is kept, for stores served below the domain root.
 *
 * The secret is encoded because it is a path segment: a base64 secret
 * carrying "/" or "+" would otherwise split the path or change on decoding,
 * and every delivery would 404. Express decodes `req.params.token` back to
 * the configured value before the comparison.
 */
export function webhookUrlFor(
  baseUrl: unknown,
  secret: string
): WebhookUrlResult {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return { ok: false, reason: "base_url is required" }
  }

  let parsed: URL
  try {
    parsed = new URL(baseUrl.trim())
  } catch {
    return { ok: false, reason: "base_url is not a valid URL" }
  }

  const secure =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
  if (!secure) {
    return {
      ok: false,
      reason:
        "base_url must use https:// (http:// is accepted only for localhost)",
    }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "base_url must not contain credentials" }
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      reason: "base_url must not contain a query string or fragment",
    }
  }

  const prefix = parsed.pathname.replace(/\/+$/, "")
  return {
    ok: true,
    url: `${parsed.origin}${prefix}/hooks/printful/${encodeURIComponent(secret)}`,
  }
}
