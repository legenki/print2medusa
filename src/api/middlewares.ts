import { defineMiddlewares } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/hooks/printful/*",
      middlewares: [
        (req, _res, next) => {
          // Medusa's error handler logs req.path verbatim
          // (node_modules/@medusajs/framework/dist/http/middlewares/error-handler.js),
          // and our path carries the webhook secret as its last segment.
          // Redact it before any downstream handler or the error middleware
          // can write it to a log.
          //
          // Verified: overriding req.path this way does not affect
          // req.params.token (routing/param extraction already happened by
          // the time this middleware runs), so the route's auth check is
          // unaffected. NOT covered: errors thrown by the global body-parser
          // (oversized body, malformed JSON) — that middleware is registered
          // ahead of this one in Medusa's stack and reaches the error handler
          // without ever running ours, so the real token can still reach logs
          // in that one case.
          const redacted = req.path.replace(
            /^(\/hooks\/printful\/)[^/]+/,
            "$1[redacted]"
          )
          Object.defineProperty(req, "path", {
            value: redacted,
            configurable: true,
          })
          next()
        },
      ],
    },
  ],
})
