import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../compat.ts'
import { SEARCH_PROVIDER_CODEX, SEARCH_PROVIDER_DSH } from '../shared/preferences.ts'
import type { SearchProviderPreference } from '../shared/contracts.ts'

interface LoaderLike {
  entries(): Iterable<Entry>
}

export class SearchProviderSwitcher {
  private originalSearchProvider: string | undefined
  private originalFetchProvider: string | undefined
  private initialized = false

  constructor(private readonly loader: LoaderLike) {}

  async select(preference: SearchProviderPreference): Promise<void> {
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
    const selected = preference === SEARCH_PROVIDER_CODEX
      ? CODEX_SEARCH_PROVIDER_ID
      : undefined
    const nextSearch = selected ?? this.originalSearchProvider
    const nextFetch = selected ? CODEX_FETCH_PROVIDER_ID : this.originalFetchProvider

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
    await entry.update({ config: nextConfig }, true)
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
