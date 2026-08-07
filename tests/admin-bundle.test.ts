import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Nothing the admin loads may import a server package.
 *
 * Admin widgets and routes run in the browser. `@medusajs/framework/utils`
 * reaches `@medusajs/utils/dist/auth/token.js` → `jsonwebtoken` → `jws`, which
 * calls `util.inherits` — absent in a browser. The whole admin fails to load
 * with `chr.inherits is not a function`, and the failure is total: not a broken
 * widget, a blank admin.
 *
 * Typecheck cannot catch this. The import is valid TypeScript and the module
 * exists; only the runtime environment makes it wrong. So the guard is a test
 * that walks what the admin actually pulls in.
 */

const ADMIN_DIR = join(__dirname, "..", "src", "admin")
const SRC_DIR = join(__dirname, "..", "src")

/** Packages that only exist server-side. */
const SERVER_ONLY = [
  "@medusajs/framework",
  "@medusajs/medusa",
  "@medusajs/utils",
  "jsonwebtoken",
  "awilix",
  "pg",
]

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory()
      ? listFiles(full)
      : /\.(ts|tsx)$/.test(full)
        ? [full]
        : []
  })

/** Local imports resolved to a file, so the walk follows the real graph. */
const localImportsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8")
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])

  return specifiers
    .filter((s) => s.startsWith("."))
    .flatMap((s) => {
      const base = join(file, "..", s)
      for (const candidate of [
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
      ]) {
        try {
          if (statSync(candidate).isFile()) {
            return [candidate]
          }
        } catch {
          // Not this extension; try the next.
        }
      }
      return []
    })
}

/**
 * Package imports that survive compilation.
 *
 * `import type` is erased by the compiler and never reaches the bundle, so a
 * type-only import of a server package is harmless — the widget's own
 * `import type { AdminOrder } from "@medusajs/framework/types"` is exactly
 * that. Flagging it would make this test cry wolf on the safe case and teach
 * the next person to disable it.
 */
const packageImportsOf = (file: string): string[] =>
  [
    ...readFileSync(file, "utf8").matchAll(
      /(^|\n)\s*import\s+([^"]*?)from\s+"([^"]+)"/g
    ),
  ]
    .filter((m) => !/^type\s/.test(m[2].trim()))
    .map((m) => m[3])
    .filter((s) => !s.startsWith("."))

/** Every file the admin reaches, directly or through `src/utils`. */
const reachableFromAdmin = (): Map<string, string[]> => {
  const chains = new Map<string, string[]>()
  const queue: Array<{ file: string; chain: string[] }> = listFiles(
    ADMIN_DIR
  ).map((file) => ({ file, chain: [file] }))

  while (queue.length) {
    const { file, chain } = queue.shift()!
    if (chains.has(file)) {
      continue
    }
    chains.set(file, chain)
    for (const next of localImportsOf(file)) {
      queue.push({ file: next, chain: chain.concat(next) })
    }
  }

  return chains
}

describe("admin bundle", () => {
  it("pulls in no server-only package", () => {
    const offenders: string[] = []

    for (const [file, chain] of reachableFromAdmin()) {
      for (const pkg of packageImportsOf(file)) {
        if (SERVER_ONLY.some((s) => pkg === s || pkg.startsWith(`${s}/`))) {
          offenders.push(
            `${pkg} via ${chain.map((f) => f.replace(SRC_DIR, "src")).join(" → ")}`
          )
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("walks past the entry file into what it imports", () => {
    // Guards the guard: a walk that only checked admin files directly would
    // have missed this bug entirely, since the offending import was one hop
    // away in src/utils/currency.ts.
    const reached = [...reachableFromAdmin().keys()]

    expect(reached.some((f) => f.includes("admin"))).toBe(true)
    expect(reached.some((f) => f.includes(join("src", "utils")))).toBe(true)
  })
})
