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

  async select(preference: SearchProviderPreference, options: WebProviderSelectionOptions = {}): Promise<void> {
    const entry = this.findWebEntry()
    if (entry === null) {
      this.state = 'missing'
      return
    }
    const config = currentConfig(entry)
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
    if (config.searchProvider === nextSearch && config.fetchProvider === nextFetch) return
    const nextConfig = { ...config }
    if (nextSearch === undefined) delete nextConfig.searchProvider
    else nextConfig.searchProvider = nextSearch
    if (nextFetch === undefined) delete nextConfig.fetchProvider
    else nextConfig.fetchProvider = nextFetch
    this.state = 'applying'
    try {
      await entry.update({ config: nextConfig })
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
