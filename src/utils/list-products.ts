/** Rows per page when walking the whole catalogue. */
export const PRODUCT_PAGE_SIZE = 200

type ProductPage<T> = (
  filters: Record<string, unknown>,
  config: {
    relations: string[]
    take: number
    skip: number
    order: Record<string, "ASC" | "DESC">
  }
) => Promise<T[]>

/**
 * Every product with its variants, a page at a time.
 *
 * Bundles reference variants on *other* products, so anything that resolves
 * them needs the whole catalogue. A single `take: 1000` silently stops there:
 * on a bigger store the admin reports live members as "missing" and the sync
 * decides a bundle's availability from part of its members.
 *
 * Ordered by id so pages are stable while the catalogue is being read.
 */
export async function listAllProducts<T>(productModule: {
  listProducts: ProductPage<T>
}): Promise<T[]> {
  const all: T[] = []
  for (let skip = 0; ; skip += PRODUCT_PAGE_SIZE) {
    const page = await productModule.listProducts(
      {},
      {
        relations: ["variants"],
        take: PRODUCT_PAGE_SIZE,
        skip,
        order: { id: "ASC" },
      }
    )
    all.push(...page)
    if (page.length < PRODUCT_PAGE_SIZE) {
      return all
    }
  }
}
