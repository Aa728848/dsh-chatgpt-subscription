/**
 * Periodic reconciliation of the `web` entry against this plugin's selection.
 *
 * Selecting a backend writes the loader entry's config, and nothing in the
 * loader promises that write survives every later composition of that entry.
 * When it does not, the entry keeps DSH's own providers while the switcher's
 * last verdict still reads `applied`, so no preference change, proxy detection,
 * or injection ever fires again — the tool stays on the built-in provider for
 * the rest of the process. On a machine whose proxy answers DNS with a fake-ip
 * range that provider refuses every fetch before the proxy is consulted.
 *
 * A dry re-check costs one loader scan, and `select()` returns without
 * restarting anything when the entry already holds what the selection wants;
 * a timer is therefore the one reconciliation trigger that does not depend on
 * an event this plugin does not own.
 *
 * @module dsh-chatgpt-subscription/web-provider-reconciler
 */

/** How often the running `web` configuration is compared with the selection. */
export const WEB_PROVIDER_RECONCILE_INTERVAL_MS = 30_000

export interface WebProviderReconcilerOptions {
  /** Re-reads the current selection and re-applies it when the entry drifted. */
  reconcile: () => void
  /** Override for tests; defaults to {@link WEB_PROVIDER_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number
}

/**
 * Start reconciling the web provider selection on a timer.
 *
 * @param options - the reconcile callback and an optional interval.
 * @returns the disposer that stops the timer.
 */
export function startWebProviderReconciler(options: WebProviderReconcilerOptions): () => void {
  const intervalMs = options.intervalMs ?? WEB_PROVIDER_RECONCILE_INTERVAL_MS
  const timer = setInterval(() => {
    try {
      options.reconcile()
    } catch {
      // One bad pass — a loader mid-restart, a store that throws — must not stop
      // every later pass. Reporting is the caller's job, and it is the caller
      // that already logs a failed selection.
    }
  }, intervalMs)
  // A host with nothing else to do must still be able to exit.
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    clearInterval(timer)
  }
}
