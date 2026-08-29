import { describe, expect, it, vi } from 'vitest'
import { CODEX_SEARCH_PROVIDER_ID } from '../src/compat.ts'
import { SearchProviderSwitcher } from '../src/host/search-provider-switcher.ts'

describe('SearchProviderSwitcher', () => {
  it('restores the original provider when leaving Codex search', async () => {
    const entry = fakeWebEntry({ searchProvider: 'deepseek-official', fetchProvider: 'local' })
    const switcher = new SearchProviderSwitcher({ entries: () => [entry] as never })

    await switcher.select('codex')
    await switcher.select('dsh')

    expect(entry.update).toHaveBeenNthCalledWith(1, { config: { searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_SEARCH_PROVIDER_ID } }, true)
    expect(entry.update).toHaveBeenNthCalledWith(2, { config: { searchProvider: 'deepseek-official', fetchProvider: 'local' } }, true)
  })

  it('unsets Codex search and fetch when it was already the persisted provider at startup', async () => {
    const entry = fakeWebEntry({ searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_SEARCH_PROVIDER_ID })
    const switcher = new SearchProviderSwitcher({ entries: () => [entry] as never })

    await switcher.select('dsh')

    expect(entry.update).toHaveBeenCalledWith({ config: {} }, true)
  })
})

function fakeWebEntry(config: Record<string, unknown>) {
  const entry = {
    options: { id: 'web', name: '@deepseek-ai/dsh-web', config },
    update: vi.fn(async (patch: { config?: Record<string, unknown> }) => {
      if (patch.config !== undefined) entry.options.config = patch.config
    }),
  }
  return entry
}
