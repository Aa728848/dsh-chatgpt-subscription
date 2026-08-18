import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { CODEX_SEARCH_PROVIDER_ID } from '../compat.ts'
import { SEARCH_PROVIDER_CODEX, SEARCH_PROVIDER_DSH } from '../shared/preferences.ts'
import type { SearchProviderPreference } from '../shared/contracts.ts'

interface LoaderLike {
  entries(): Iterable<Entry>
}

export class SearchProviderSwitcher {
  private originalProvider: string | undefined
  private initialized = false

  constructor(private readonly loader: LoaderLike) {}

  async select(preference: SearchProviderPreference): Promise<void> {
    const entry = this.findWebEntry()
    if (entry === null) return
    const config = currentConfig(entry)
    if (!this.initialized) {
      this.originalProvider = typeof config.searchProvider === 'string' && config.searchProvider !== CODEX_SEARCH_PROVIDER_ID
        ? config.searchProvider
        : undefined
      this.initialized = true
    }
    const selected = preference === SEARCH_PROVIDER_CODEX
      ? CODEX_SEARCH_PROVIDER_ID
      : this.originalProvider
    if (config.searchProvider === selected) return
    const nextConfig = { ...config }
    if (selected === undefined) {
      delete nextConfig.searchProvider
    } else {
      nextConfig.searchProvider = selected
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
