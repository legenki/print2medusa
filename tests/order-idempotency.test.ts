import { describe, expect, it } from "vitest"
import { PrintfulApiError } from "../src/utils/errors"
import {
  assertUsableExternalId,
  classifyCreateFailure,
  isUnresolvedLink,
  PRINTFUL_EXTERNAL_ID_MAX,
} from "../src/utils/order-idempotency"
import { PENDING_PRINTFUL_ORDER_ID } from "../src/modules/printful/service"

const apiError = (status: number) =>
  new PrintfulApiError(`status ${status}`, { status })

describe("classifyCreateFailure", () => {
  it("treats an outright rejection as proof the order was not created", () => {
    // Printful read the request and refused it, so releasing the claim and
    // retrying cannot duplicate anything.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyCreateFailure(apiError(status))).toBe("not_created")
    }
  })

  it("treats 409 as unknown, not as a rejection", () => {
    // On create, 409 can mean "an order with this external_id already exists".
    // Releasing the claim on that would print and ship a second order — the
    // exact bug this module exists to prevent.
    expect(classifyCreateFailure(apiError(409))).toBe("unknown")
  })

  it("treats throttling and server errors as unknown", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyCreateFailure(apiError(status))).toBe("unknown")
    }
  })

  it("treats a transport failure with no status as unknown", () => {
    // A timeout is precisely the case where Printful may have accepted the
    // order and only the response was lost.
    expect(classifyCreateFailure(new Error("socket hang up"))).toBe("unknown")
    expect(classifyCreateFailure(apiError(0))).toBe("unknown")
    expect(classifyCreateFailure(undefined)).toBe("unknown")
  })

  it("defaults to unknown for anything unrecognised", () => {
    expect(classifyCreateFailure({ status: 400 })).toBe("unknown")
  })
})

describe("assertUsableExternalId", () => {
  it("accepts a Medusa order id, which is exactly at the limit", () => {
    const id = `order_${"0123456789ABCDEFGHJKMNPQRS"}`
    expect(id).toHaveLength(PRINTFUL_EXTERNAL_ID_MAX)
    expect(() => assertUsableExternalId(id)).not.toThrow()
  })

  it("refuses an id one character over the limit", () => {
    // Printful would truncate or reject it, and a shortened key cannot
    // identify the order on retry — so fail before anything is created.
    expect(() => assertUsableExternalId("o".repeat(33))).toThrow(/at most 32/)
  })

  it("names the offending id and its length", () => {
    expect(() => assertUsableExternalId("x".repeat(40))).toThrow(/is 40/)
  })

  it("refuses characters Printful does not accept", () => {
    expect(() => assertUsableExternalId("order 01ABC")).toThrow(/letters/)
    expect(() => assertUsableExternalId("order:01ABC")).toThrow(/letters/)
  })

  it("refuses an empty id", () => {
    expect(() => assertUsableExternalId("")).toThrow(/empty/)
  })

  it("never silently rewrites the id", () => {
    // The guard's whole purpose is that the key reaching Printful is the key
    // we can look up later, unchanged.
    const id = "order_01JQ8ZK3M9XN2VWTB7YHRF"
    expect(assertUsableExternalId(id)).toBeUndefined()
  })
})

describe("isUnresolvedLink", () => {
  it("recognises a claim that has no real Printful order behind it", () => {
    expect(
      isUnresolvedLink(
        { printful_order_id: PENDING_PRINTFUL_ORDER_ID },
        PENDING_PRINTFUL_ORDER_ID
      )
    ).toBe(true)
  })

  it("does not treat a finished link as unresolved", () => {
    expect(
      isUnresolvedLink({ printful_order_id: "98765" }, PENDING_PRINTFUL_ORDER_ID)
    ).toBe(false)
  })

  it("is false for a missing link", () => {
    expect(isUnresolvedLink(null, PENDING_PRINTFUL_ORDER_ID)).toBe(false)
    expect(isUnresolvedLink(undefined, PENDING_PRINTFUL_ORDER_ID)).toBe(false)
  })

  it("treats a blank order id as unresolved rather than done", () => {
    // Erring towards "unresolved" means we look the order up; erring the other
    // way would mark it complete and never ship it.
    expect(isUnresolvedLink({ printful_order_id: "" }, "")).toBe(true)
  })
})
