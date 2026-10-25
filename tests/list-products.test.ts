import { describe, expect, it, vi } from "vitest"
import { listAllProducts, PRODUCT_PAGE_SIZE } from "../src/utils/list-products"

describe("listAllProducts", () => {
  it("walks every page rather than stopping at the first", async () => {
    const total = PRODUCT_PAGE_SIZE * 2 + 7
    const rows = Array.from({ length: total }, (_, i) => ({ id: `prod_${i}` }))
    const listProducts = vi.fn(
      async (_f: Record<string, unknown>, c: { take: number; skip: number }) =>
        rows.slice(c.skip, c.skip + c.take)
    )

    const all = await listAllProducts({ listProducts })

    expect(all).toHaveLength(total)
    expect(listProducts).toHaveBeenCalledTimes(3)
    expect(listProducts.mock.calls[2][1]).toMatchObject({
      skip: PRODUCT_PAGE_SIZE * 2,
      relations: ["variants"],
    })
  })

  it("stops after one short page", async () => {
    const listProducts = vi.fn(async () => [{ id: "prod_1" }])
    expect(await listAllProducts({ listProducts })).toHaveLength(1)
    expect(listProducts).toHaveBeenCalledTimes(1)
  })
})
