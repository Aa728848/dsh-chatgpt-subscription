import { describe, expect, it, vi } from 'vitest'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../src/compat.ts'
import { SearchProviderSwitcher } from '../src/host/search-provider-switcher.ts'

describe('SearchProviderSwitcher', () => {
  it('switches both search and fetch providers when selecting Codex', async () => {
    const entry = fakeWebEntry({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    const switcher = new SearchProviderSwitcher({ entries: () => [entry] as never })

    await switcher.select('codex')
    expect(entry.update).toHaveBeenCalledWith({ config: { searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_FETCH_PROVIDER_ID } }, true)

    await switcher.select('dsh')
    expect(entry.update).toHaveBeenCalledWith({ config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } }, true)
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
