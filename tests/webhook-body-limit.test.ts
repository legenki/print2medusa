import express from "express"
import { createRequire } from "module"
import type { AddressInfo } from "net"
import path from "path"
import { describe, expect, it } from "vitest"
import middlewaresConfig from "../src/api/middlewares"

// @medusajs/framework's "exports" map does not expose these internals, but they
// are plain CJS. Load them by absolute path so the test drives the framework's
// real implementation rather than a reimplementation of it.
const require_ = createRequire(import.meta.url)
const frameworkHttp = path.dirname(require_.resolve("@medusajs/framework/http"))
const { RoutesFinder } = require_(path.join(frameworkHttp, "routes-finder.js"))
const { RoutesSorter } = require_(path.join(frameworkHttp, "routes-sorter.js"))
const { createBodyParserMiddlewaresStack } = require_(
  path.join(frameworkHttp, "middlewares", "bodyparser.js")
)
const { HTTP_METHODS } = require_(path.join(frameworkHttp, "types.js"))

/**
 * These tests exercise Medusa's REAL body-parser stack and route matching,
 * assembled in the same order as
 * @medusajs/framework/dist/http/router.js:
 *
 *   1. the body parser at app.use("/", ...) — global, runs first
 *   2. plugin middlewares from defineMiddlewares — route-scoped, run after
 *   3. the error handler, which logs `Error ${statusCode} at ${req.path}`
 *
 * That ordering is the whole problem: a body-parser error (413/malformed JSON)
 * short-circuits to the error handler without ever running step 2, so the
 * redaction there cannot save us. Only keeping the parser from erroring on
 * legitimate traffic does.
 */

const SECRET = "live-webhook-secret-do-not-log"

type Harness = {
  url: string
  logs: string[]
  close: () => Promise<void>
}

async function startServer(): Promise<Harness> {
  const app = express()
  const logs: string[] = []

  const routes = middlewaresConfig.routes ?? []

  // (1) Global body parser, configured exactly as Medusa configures it.
  // Mirrors MiddlewareFileLoader#processMiddlewareFile: entries carry the
  // methods they apply to, defaulting to every HTTP method.
  const bodyParserConfigRoutes = routes
    .filter((r) => r.bodyParser !== undefined)
    .map((r) => ({
      matcher: String(r.matcher),
      methods: r.methods ?? [...HTTP_METHODS],
      config: r.bodyParser,
    }))
  const finder = new RoutesFinder(
    new RoutesSorter(bodyParserConfigRoutes as never).sort([
      "static",
      "params",
      "regex",
      "wildcard",
      "global",
    ]) as never
  )
  app.use("/", ...createBodyParserMiddlewaresStack("/", finder as never))

  // (2) Plugin middlewares, registered after the parser as Medusa does.
  for (const route of routes) {
    for (const mw of route.middlewares ?? []) {
      app.use(route.matcher as string, mw as express.RequestHandler)
    }
  }

  // Stands in for a failure raised by the route handler itself (e.g. the
  // storage failure our real route turns into a 500).
  app.post("/hooks/printful/:token/boom", (_req, _res, next) => {
    next(Object.assign(new Error("storage failed"), { statusCode: 500 }))
  })

  app.post("/hooks/printful/:token", (_req, res) => {
    res.status(200).json({ received: true })
  })

  // (3) Medusa's error handler logs this exact shape.
  app.use(
    (
      err: { statusCode?: number; status?: number },
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const statusCode = err.statusCode ?? err.status ?? 500
      logs.push(`Error ${statusCode} at ${req.path}`)
      res.status(statusCode).json({ message: "error" })
    }
  )

  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      ),
  }
}

async function withServer(fn: (h: Harness) => Promise<void>) {
  const h = await startServer()
  try {
    await fn(h)
  } finally {
    await h.close()
  }
}

/** A JSON body of approximately `bytes` size. */
function bodyOfSize(bytes: number): string {
  const filler = "x".repeat(Math.max(0, bytes - 40))
  return JSON.stringify({ type: "package_shipped", filler })
}

describe("webhook body-parser limit", () => {
  it("accepts a realistic large package_shipped body (~262KB)", async () => {
    await withServer(async ({ url, logs }) => {
      const res = await fetch(`${url}/hooks/printful/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyOfSize(262 * 1024),
      })

      // Under Express's 100KB default this would be a 413.
      expect(res.status).toBe(200)
      expect(logs).toEqual([])
    })
  })

  it("still accepts a body that would exceed the 100KB default", async () => {
    await withServer(async ({ url }) => {
      const res = await fetch(`${url}/hooks/printful/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyOfSize(150 * 1024),
      })
      expect(res.status).toBe(200)
    })
  })

  /**
   * The residual gap, asserted rather than assumed.
   *
   * These two cases document a limitation we cannot fix from plugin code: the
   * body parser is registered globally, ahead of route-scoped middleware, so
   * when IT throws, our redaction never runs and the error handler logs the
   * real path. The only lever Medusa offers is `errorHandler` on
   * defineMiddlewares, but that REPLACES the single global handler
   * (middleware-file-loader.js: "Global error handler"), so a plugin taking it
   * would override the host application's own — too invasive for this fix.
   *
   * Raising the size limit narrows this to bodies no genuine Printful delivery
   * produces; it does not close it. If these tests ever start failing because
   * the secret is now redacted, the limitation has been fixed upstream and the
   * README's rotation guidance can be revisited.
   */
  it("leaks the secret on an oversized body (known, documented limitation)", async () => {
    await withServer(async ({ url, logs }) => {
      const res = await fetch(`${url}/hooks/printful/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyOfSize(2 * 1024 * 1024), // beyond the 1mb limit
      })

      expect(res.status).toBe(413)
      expect(logs).toEqual([`Error 413 at /hooks/printful/${SECRET}`])
    })
  })

  it("leaks the secret on malformed JSON (known, documented limitation)", async () => {
    await withServer(async ({ url, logs }) => {
      const res = await fetch(`${url}/hooks/printful/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      })

      expect(res.status).toBe(400)
      expect(logs).toEqual([`Error 400 at /hooks/printful/${SECRET}`])
    })
  })

  /**
   * By contrast, errors raised after the parser DO get redacted, because
   * route-scoped middleware has run by then. This also pins the useful part:
   * the log keeps the real route shape, so an operator can still tell which
   * endpoint failed.
   */
  it("redacts the secret for errors raised after the parser", async () => {
    await withServer(async ({ url, logs }) => {
      const res = await fetch(`${url}/hooks/printful/${SECRET}/boom`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "package_shipped" }),
      })

      expect(res.status).toBe(500)
      expect(logs).toHaveLength(1)
      expect(logs[0]).not.toContain(SECRET)
      expect(logs[0]).toBe("Error 500 at /hooks/printful/[redacted]/boom")
    })
  })

  /**
   * Regression guard. Medusa mounts plugin middleware with
   * app.use(matcher, handler), so req.path inside it is "/" and the secret
   * lives in req.baseUrl. Redacting req.path there would silently no-op and
   * merely blank the path; the redaction must be driven by req.originalUrl.
   */
  it("keeps the route identifiable rather than blanking the path", async () => {
    await withServer(async ({ url, logs }) => {
      await fetch(`${url}/hooks/printful/${SECRET}/boom`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })

      expect(logs[0]).toContain("/hooks/printful/")
      expect(logs[0]).not.toBe("Error 500 at /")
    })
  })
})
