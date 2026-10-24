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

  it('keeps an explicit origin alone even when the id is enabled', () => {
    const parsed = parseClinePassModelSettings({
      catalogModels: [{ id: 'deepseek/explicit', origin: 'gateway' }],
      enabledModelIds: ['deepseek/explicit'],
    })
    expect(parsed.catalogModels[0]?.origin).toBe('gateway')
    expect(listedClinePassCatalogModels(parsed)).toHaveLength(0)
  })

  it('treats "no filter" as every row in use, so an exposeCatalog user keeps their models', () => {
    // `enabledModelIds: null` is how this store spells "no filter": every
    // catalogued model is enabled. It is exactly the cohort an `exposeCatalog`
    // user who never touched the checklist is in, and reading null as an empty
    // selection hid all of their gateway rows on upgrade.
    const parsed = parseClinePassModelSettings({
      catalogModels: [
        { id: 'deepseek/legacy-enabled' },
        { id: 'moonshotai/kimi-k3' },
      ],
      enabledModelIds: null,
      exposeCatalog: true,
    })
    expect(parsed.enabledModelIds).toBeNull()
    expect(parsed.catalogModels.map((model) => model.origin)).toEqual(['custom', 'custom'])
    expect(listedClinePassCatalogModels(parsed).map((model) => model.id))
      .toEqual(['deepseek/legacy-enabled', 'moonshotai/kimi-k3'])
  })

  it('still hides every untouched row when the selection is an explicit empty list', () => {
    // An empty array is a real selection that switched everything off, and must
    // not be read as "no filter" — that would resurrect models the user removed.
    const parsed = parseClinePassModelSettings({
      catalogModels: [{ id: 'deepseek/legacy-unused' }],
      enabledModelIds: [],
    })
    expect(parsed.catalogModels[0]?.origin).toBeUndefined()
    expect(listedClinePassCatalogModels(parsed)).toHaveLength(0)
  })
})
