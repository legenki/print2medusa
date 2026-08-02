/**
 * Tracking for products created during a sync but not yet linked back to
 * Printful.
 *
 * A product becomes visible to the next sync only through its link row:
 * `findProductLink` is what decides create-vs-update. Between
 * `createProductsWorkflow` returning and the link row being written there is a
 * window where the product exists in Medusa but nothing points at it. A crash
 * in that window strands it — invisible to every later sync, and duplicated the
 * next time the same Printful product comes around.
 *
 * The compensation deletes exactly those stranded products. Which makes the
 * boundary load-bearing in the dangerous direction: tracking too *little* leaks
 * a draft product, but tracking too *much* deletes products that synced
 * successfully. This lives apart from the workflow so that boundary can be
 * tested without a database, a container, or the six modules
 * `createProductsWorkflow` transitively needs.
 */
export class OrphanTracker {
  private readonly ids: string[] = []

  /** Created in Medusa, no link row yet — deletable if the sync fails here. */
  track(productId: string): void {
    this.ids.push(productId)
  }

  /**
   * The link row exists, so the product is reachable by the next sync and must
   * survive a rollback. Idempotent: releasing an id that was never tracked, or
   * releasing twice, is a no-op rather than an error.
   */
  release(productId: string): void {
    const idx = this.ids.indexOf(productId)
    if (idx !== -1) {
      this.ids.splice(idx, 1)
    }
  }

  /** The ids the compensation may delete, in creation order. */
  toDelete(): string[] {
    return [...this.ids]
  }
}
