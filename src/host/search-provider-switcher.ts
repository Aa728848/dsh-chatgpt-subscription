import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../compat.ts'
import { SEARCH_PROVIDER_CODEX } from '../shared/preferences.ts'
import type { SearchProviderPreference } from '../shared/contracts.ts'

interface LoaderLike {
  entries(): Iterable<Entry>
}

/** What one selection asks for on top of the settings preference. */
export interface WebProviderSelectionOptions {
  /**
   * Whether this plugin's fetch provider must serve the `web_fetch` tool.
   *
   * DSH's built-in provider resolves and pins every destination before it
   * connects and routes through a proxy only when the process environment names
   * one, so an OS-level proxy plus the fake-ip DNS that usually comes with it
   * fails every fetch with `WEB_BLOCKED_URL`. Selecting this plugin's provider
   * hands the origin's resolution to the configured proxy — the same
   * proxied-hop semantics DSH applies to a URL it routes through a proxy.
   */
  readonly pluginFetch?: boolean
}

export class SearchProviderSwitcher {
  private originalSearchProvider: string | undefined
  private originalFetchProvider: string | undefined
  private initialized = false

  constructor(private readonly loader: LoaderLike) {}

  async select(preference: SearchProviderPreference, options: WebProviderSelectionOptions = {}): Promise<void> {
    const entry = this.findWebEntry()
    if (entry === null) return
    const config = currentConfig(entry)
    if (!this.initialized) {
      this.originalSearchProvider = typeof config.searchProvider === 'string' && config.searchProvider !== CODEX_SEARCH_PROVIDER_ID
        ? config.searchProvider
        : undefined
      this.originalFetchProvider = typeof config.fetchProvider === 'string' && config.fetchProvider !== CODEX_FETCH_PROVIDER_ID
        ? config.fetchProvider
        : undefined
      this.initialized = true
    }
    const codexSelected = preference === SEARCH_PROVIDER_CODEX
    const nextSearch = codexSelected ? CODEX_SEARCH_PROVIDER_ID : this.originalSearchProvider
    const nextFetch = codexSelected || options.pluginFetch === true
      ? CODEX_FETCH_PROVIDER_ID
      : this.originalFetchProvider

    if (config.searchProvider === nextSearch && config.fetchProvider === nextFetch) return
    const nextConfig = { ...config }
    if (nextSearch === undefined) {
      delete nextConfig.searchProvider
    } else {
      nextConfig.searchProvider = nextSearch
    }
    if (nextFetch === undefined) {
      delete nextConfig.fetchProvider
    } else {
      nextConfig.fetchProvider = nextFetch
    }
    await entry.update({ config: nextConfig })
  }

  private findWebEntry(): Entry | null {
    for (const entry of this.loader.entries()) {
      if (entry.options.id === 'web') return entry
      if (entry.options.name === '@deepseek-ai/dsh-web') return entry
    }
    return null
  }
}

function currentConfig(entry: Entry): Record<string, unknown> {
  const config = entry.options.config
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}
