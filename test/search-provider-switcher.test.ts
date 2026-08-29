import { describe, expect, it, vi } from 'vitest'
import { restoreDefaultWebProviders } from '../src/host/search-provider-switcher.ts'

describe('restoreDefaultWebProviders', () => {
  it('cleans up codex-subscription search and fetch configs', async () => {
    const entry = fakeWebEntry({ searchProvider: 'codex-subscription', fetchProvider: 'codex-subscription', extra: 'kept' })
    await restoreDefaultWebProviders({ entries: () => [entry] as never })

    expect(entry.update).toHaveBeenCalledWith({ config: { extra: 'kept' } }, true)
  })

  it('leaves other configs untouched', async () => {
    const entry = fakeWebEntry({ searchProvider: 'deepseek-official', fetchProvider: 'http' })
    await restoreDefaultWebProviders({ entries: () => [entry] as never })

    expect(entry.update).not.toHaveBeenCalled()
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
