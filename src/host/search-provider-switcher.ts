import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../compat.ts'
import { SEARCH_PROVIDER_CODEX } from '../shared/preferences.ts'
import type { SearchProviderPreference } from '../shared/contracts.ts'

interface LoaderLike {
  entries(): Iterable<Entry>
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
        await entry.fiber.update(nextConfig, true)
      } else {
        await entry.update({ config: nextConfig })
      }
      this.state = 'applied'
    } catch (error) {
      this.state = 'failed'
      throw error
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
