import { defineMiddlewares } from "@medusajs/framework/http"
import {
  redactWebhookPath,
  WEBHOOK_BODY_SIZE_LIMIT,
} from "../utils/webhook-path"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/hooks/printful/*",
      /**
       * Sized deliberately, for two reasons.
       *
       * Correctness: Express defaults to 100KB, and a real `package_shipped`
       * body for a ~25-line-item order already exceeds that (~132KB; ~262KB at
       * 50 items). Under the default, Printful deliveries for large orders are
       * rejected outright.
       *
       * Secrecy: that rejection is a 413 raised by the GLOBAL body-parser,
       * which Medusa registers at `app.use("/", ...)` before any route-scoped
       * middleware (@medusajs/framework/dist/http/router.js). Such an error
       * goes straight to the error handler without ever running the redaction
       * below, so the live secret in the path would be logged in cleartext.
       * Raising the limit keeps legitimate traffic from ever reaching that
       * path. This config IS honoured despite the global registration: the
       * parser resolves its config per request via a RoutesFinder lookup on
       * `req.path` (dist/http/middlewares/bodyparser.js).
       */
      bodyParser: { sizeLimit: WEBHOOK_BODY_SIZE_LIMIT },
      middlewares: [
        (req, _res, next) => {
          // Medusa's error handler logs `Error ${statusCode} at ${req.path}`
          // (@medusajs/framework/dist/http/middlewares/error-handler.js), and
          // our path carries the webhook secret as a segment. Redact it before
          // any downstream handler or the error middleware can write it out.
          //
          // Medusa registers plugin middleware with app.use(matcher, handler),
          // so inside THIS function Express has already stripped the matched
          // prefix: req.path is "/" and the secret sits in req.baseUrl. The
          // full path is only reassembled downstream, which is why we redact
          // req.originalUrl and pin req.path to the redacted full path — the
          // value the error handler ends up reading.
          //
          // Verified: this does not affect req.params.token (param extraction
          // happens in the route layer from the untouched URL), so the route's
          // auth check is unaffected.
          const redacted = redactWebhookPath(req.originalUrl)
          Object.defineProperty(req, "path", {
            value: redacted,
            configurable: true,
          })
          Object.defineProperty(req, "originalUrl", {
            value: redacted,
            configurable: true,
          })
          next()
        },
      ],
    },
  ],
})
