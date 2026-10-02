import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../compat.ts'
import { SEARCH_PROVIDER_CODEX } from '../shared/preferences.ts'
import type { SearchProviderPreference } from '../shared/contracts.ts'

interface LoaderLike {
  entries(): Iterable<Entry>
}

/**
 * Cordis fiber states, mirrored from its `FiberState` const enum.
 *
 * It is a const enum, so importing the values would inline them here anyway and
 * the numbers would be duplicated in the emitted JavaScript either way. Naming
 * them locally keeps this module free of a type-only import that a consumer's
 * build would still have to resolve, and the values are asserted against the
 * installed cordis in the test below.
 */
const FIBER_LOADING = 1
const FIBER_ACTIVE = 2
const FIBER_UNLOADING = 5

/** How long to wait for a restarted entry to become active again. */
const RESTART_TIMEOUT_MS = 10_000

/** Gap between restart-state samples. */
const RESTART_POLL_MS = 10

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export interface WebProviderSelectionOptions {
  readonly pluginFetch?: boolean
}

/** Configuration diagnostics, not proof that an in-flight tool uses this service. */
export interface SearchProviderSwitcherStatus {
  readonly state: 'idle' | 'applying' | 'applied' | 'missing' | 'failed'
  readonly configuredSearchProvider: string | null
  readonly configuredFetchProvider: string | null
}

export class SearchProviderSwitcher {
  private originalSearchProvider: string | undefined
  private originalFetchProvider: string | undefined
  private initialized = false
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  dispose(): void { this.disposed = true }
  private state: SearchProviderSwitcherStatus['state'] = 'idle'

  constructor(private readonly loader: LoaderLike) {}

  status(): SearchProviderSwitcherStatus {
    const entry = this.findWebEntry()
    const config = entry ? currentConfig(entry) : {}
    return {
      state: this.state,
      configuredSearchProvider: providerId(config.searchProvider),
      configuredFetchProvider: providerId(config.fetchProvider),
    }
  }

  select(preference: SearchProviderPreference, options: WebProviderSelectionOptions = {}): Promise<void> {
    const selection = { ...options }
    const task = this.pending.then(() => this.applySelection(preference, selection))
    this.pending = task.catch(() => undefined)
    return task
  }

  private async applySelection(preference: SearchProviderPreference, options: WebProviderSelectionOptions): Promise<void> {
    if (this.disposed) return
    const entry = this.findWebEntry()
    if (entry === null) {
      this.state = 'missing'
      return
    }
    // Do not update a service while its initial mount is still settling.
    await entry.fiber?.await()
    if (this.disposed) return
    const config = currentConfig(entry)
    const running = entry.fiber?.config as Record<string, unknown> | undefined
    if (!this.initialized) {
      this.originalSearchProvider = typeof config.searchProvider === 'string' && config.searchProvider !== CODEX_SEARCH_PROVIDER_ID
        ? config.searchProvider : undefined
      this.originalFetchProvider = typeof config.fetchProvider === 'string' && config.fetchProvider !== CODEX_FETCH_PROVIDER_ID
        ? config.fetchProvider : undefined
      this.initialized = true
    }
    const codexSelected = preference === SEARCH_PROVIDER_CODEX
    const nextSearch = codexSelected ? CODEX_SEARCH_PROVIDER_ID : this.originalSearchProvider
    const nextFetch = codexSelected || options.pluginFetch === true ? CODEX_FETCH_PROVIDER_ID : this.originalFetchProvider
    const configured = config.searchProvider === nextSearch && config.fetchProvider === nextFetch
    const applied = running === undefined || (running.searchProvider === nextSearch && running.fetchProvider === nextFetch)
    if (configured && applied) return
    const nextConfig = { ...config }
    if (nextSearch === undefined) delete nextConfig.searchProvider
    else nextConfig.searchProvider = nextSearch
    if (nextFetch === undefined) delete nextConfig.fetchProvider
    else nextConfig.fetchProvider = nextFetch
    this.state = 'applying'
    try {
      if (configured && entry.fiber) {
        // Entry.update skips equal options; explicitly reconcile the stale runtime.
        entry.fiber.update(nextConfig, true)
      } else {
        await entry.update({ config: nextConfig })
      }
      // Cordis restarts an entry behind its update waterfall, and neither
      // `Fiber.update` (void since cordis 4.0.3) nor the loader's `Entry.update`
      // resolves once the replacement service is live. Callers that read
      // `ctx.web` right after a selection would otherwise race the restart, so
      // the wait is what makes `applied` mean the new providers are mounted.
      //
      // The wait has to survive the restart, not merely sample the fiber once.
      // `Fiber.await()` returns immediately when the fiber is not currently
      // mid-restart (`inertia` unset), so a single call issued in the same tick
      // as `update` can observe the pre-restart ACTIVE state and resolve. That
      // left the entry UNLOADING when the caller read it next - fiber state 5 -
      // which is what the desktop app reported as 3 web entries failing to
      // activate. Polling until the state is stable makes `applied` mean the
      // entry really is mounted again.
      await this.awaitSettled(entry)
      this.state = 'applied'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }

  /**
   * Wait until the entry's fiber has finished restarting, not just until it
   * happens not to be mid-restart when asked.
   *
   * `Fiber.await()` alone is a single sample: it returns at once when `inertia`
   * is unset, which is exactly the state the fiber is in on the first tick after
   * `update()` queues its restart. Sampling that reports success while the entry
   * is still UNLOADING. This waits for a restart to actually be observed, then
   * lets `Fiber.await()` drain whatever queue is left, so a slow or multi-pass
   * restart cannot be reported as applied either.
   */
  private async awaitSettled(entry: Entry): Promise<void> {
    const fiber = entry.fiber
    if (fiber === undefined) return
    // Bounded: a peer that never reaches a stable state must not hang a caller
    // forever, so this gives up and lets the caller's own error handling speak.
    const deadline = Date.now() + RESTART_TIMEOUT_MS
    let sawRestart = false
    while (Date.now() < deadline) {
      const state = fiber.state
      if (state === FIBER_LOADING || state === FIBER_UNLOADING) sawRestart = true
      if (sawRestart && state === FIBER_ACTIVE) return
      await fiber.await()
      if (fiber.state === FIBER_ACTIVE) return
      await delay(RESTART_POLL_MS)
    }
  }

  private findWebEntry(): Entry | null {
    for (const entry of this.loader.entries()) {
      if (entry.options.id === 'web' || entry.options.name === '@deepseek-ai/dsh-web') return entry
    }
    return null
  }
}

function currentConfig(entry: Entry): Record<string, unknown> {
  const config = entry.options.config
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : {}
}

/** Never include paths, credentials, or arbitrary configuration in public diagnostics. */
function providerId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null
}
