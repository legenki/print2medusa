/** Terminal states a finished sync log can carry. `running` is set at claim time. */
export type SyncLogStatus = "success" | "partial" | "failed"

export type SyncOutcomeCounters = {
  created: number
  updated: number
  failed: number
}

/**
 * Decide how a finished sync run should be reported.
 *
 * The distinction that matters is between "nothing worked" and "some of it
 * worked". Collapsing the second into `success` is operationally misleading:
 * a run with 100 failures and one successful update used to show the merchant
 * a green sync while most of the catalog never imported.
 *
 * - nothing succeeded and something failed → `failed`
 * - something failed but something succeeded → `partial`
 * - nothing failed → `success`
 *
 * A run that created and updated nothing without failing is still `success` —
 * an empty Printful store is not an error, there was simply nothing to do.
 */
export function planSyncLogStatus(
  counters: SyncOutcomeCounters
): SyncLogStatus {
  if (counters.failed <= 0) {
    return "success"
  }

  const succeeded = counters.created > 0 || counters.updated > 0
  return succeeded ? "partial" : "failed"
}
