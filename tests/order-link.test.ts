import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  isUniqueViolation,
  PENDING_PRINTFUL_ORDER_ID,
} from "../src/modules/printful/service"

describe("isUniqueViolation", () => {
  it("detects a direct 23505 code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true)
  })

  it("detects 23505 nested in a cause chain", () => {
    const err = new Error("insert failed")
    ;(err as unknown as { cause: unknown }).cause = {
      cause: { code: "23505" },
    }
    expect(isUniqueViolation(err)).toBe(true)
  })

  it("detects 23505 mentioned in the message", () => {
    expect(
      isUniqueViolation(new Error('duplicate key value ... code 23505'))
    ).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(isUniqueViolation(new Error("network down"))).toBe(false)
    expect(isUniqueViolation({ code: "23503" })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation("string error")).toBe(false)
  })

  it("does not infinitely recurse on a self-referential cause", () => {
    const err: { cause?: unknown; code?: string } = { code: "42P01" }
    err.cause = err
    expect(isUniqueViolation(err)).toBe(false)
  })
})

describe("PENDING_PRINTFUL_ORDER_ID", () => {
  it("is a stable non-empty sentinel", () => {
    expect(PENDING_PRINTFUL_ORDER_ID).toBe("pending")
  })
})

describe("sentinel coupling between service and migration", () => {
  it("keeps the migration's exclusion predicate in sync with PENDING_PRINTFUL_ORDER_ID", () => {
    const migration = readFileSync(
      join(
        __dirname,
        "../src/modules/printful/migrations/Migration20260731000000.ts"
      ),
      "utf8"
    )

    // The reverse index must exclude the placeholder written by claimOrderLink.
    // Migrations cannot import the constant (they are historical records), so
    // this test is what keeps the literal and the constant from drifting apart.
    expect(migration).toContain(
      `"printful_order_id" <> '${PENDING_PRINTFUL_ORDER_ID}'`
    )
  })
})
