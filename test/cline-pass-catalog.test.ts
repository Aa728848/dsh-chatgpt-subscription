import { describe, expect, it } from 'vitest'
import {
  listedClinePassCatalogModels,
  parseClinePassModelSettings,
} from '../src/host/cline-pass/token-store.ts'

describe('Cline Pass catalog migration', () => {
  it('keeps a legacy gateway row the user enabled or pinned', () => {
    const parsed = parseClinePassModelSettings({
      catalogModels: [
        { id: 'deepseek/legacy-enabled' },
        { id: 'moonshotai/kimi-k3' },
        { id: 'openai/legacy-unused' },
      ],
      enabledModelIds: ['deepseek/legacy-enabled'],
      pins: { 'moonshotai/kimi-k3': { upstreams: [], exclude: [], pinMode: 'strict', sort: '', has: [] } },
    })
    // A row the user already selected becomes custom; the untouched gateway
    // rows stay a hidden search index so an upgrade cannot drop a working model.
    expect(parsed.catalogModels.find((model) => model.id === 'deepseek/legacy-enabled')?.origin).toBe('custom')
    expect(parsed.catalogModels.find((model) => model.id === 'moonshotai/kimi-k3')?.origin).toBe('custom')
    expect(parsed.catalogModels.find((model) => model.id === 'openai/legacy-unused')?.origin).toBeUndefined()
    expect(listedClinePassCatalogModels(parsed).map((model) => model.id)).toEqual(['deepseek/legacy-enabled', 'moonshotai/kimi-k3'])
  })

  it('leaves an explicit origin alone even when the id is enabled', () => {
    const parsed = parseClinePassModelSettings({
      catalogModels: [{ id: 'deepseek/explicit', origin: 'gateway' }],
      enabledModelIds: ['deepseek/explicit'],
    })
    expect(parsed.catalogModels[0]?.origin).toBe('gateway')
    expect(listedClinePassCatalogModels(parsed)).toHaveLength(0)
  })
})
