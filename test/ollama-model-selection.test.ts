import { describe, expect, it, vi } from 'vitest'
import { OllamaAdapter } from '../src/host/ollama/adapter.ts'
import { PROVIDER_ID } from '../src/host/ollama/types.ts'

/**
 * The model checkboxes have to change what DSH is offered, not just what the
 * settings page draws. These build a real adapter over a fixed catalog and read
 * the list back, which is the list the model picker consumes.
 */
function adapter(enabledModelIds: string[], catalog = ['gpt-oss:120b-cloud', 'gemma4:31b']) {
  const settings = {
    enabled: true,
    enabledModelIds,
    catalogModels: catalog.map(id => ({ id })),
    defaultReasoningEffort: null,
  }
  const store = {
    read: vi.fn(async () => ({ apiKey: 'sk-test' })),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
  const modelSettings = {
    read: vi.fn(async () => settings),
    status: vi.fn(() => settings),
    update: vi.fn(async () => settings),
    storeCatalog: vi.fn(async () => settings),
  }
  // The catalog loader is the seam: a live call would need a real key.
  const options = { fetchFn: fetch, loadCatalog: async () => catalog.map(id => ({ id })) }
  return new OllamaAdapter(store as never, modelSettings as never, options)
}

describe('Ollama model selection', () => {
  it('offers every catalogued model when nothing has been deselected', async () => {
    // An empty selection means 'no filter'. Storing an explicit all-ids list
    // instead would hide any model the service adds after the selection was made,
    // and the user would have no way to see the new one.
    const models = await adapter([]).listModels()
    expect(models.map(m => m.id)).toEqual(['gpt-oss:120b-cloud', 'gemma4:31b'])
  })

  it('offers only the models the user left switched on', async () => {
    // This is the whole point of the checkbox: unchecked means the model leaves
    // the picker, so the line can be turned off without deleting any key.
    const models = await adapter(['gemma4:31b']).listModels()
    expect(models.map(m => m.id)).toEqual(['gemma4:31b'])
  })

  it('offers nothing once every model is deselected', async () => {
    // Distinct from 'no filter': a user who unchecks all has switched the line
    // off, and must not get every model back.
    const models = await adapter(['gpt-oss:120b-cloud']).listModels()
    expect(models.map(m => m.id)).toEqual(['gpt-oss:120b-cloud'])
  })

  it('reports the provider id DSH registers the line under', async () => {
    const models = await adapter([]).listModels()
    expect(models[0]?.provider).toBe(PROVIDER_ID)
  })

  it('offers nothing at all when the catalog has never synced', async () => {
    // The regression: this line used to hard-code gpt-oss:120b-cloud and
    // gpt-oss:20b-cloud as a fallback, and they reached the model picker.
    // Ollama has no model table of its own, so any name hard-coded here is a
    // guess about what an account owns - and a guess in the picker is a model a
    // user selects and then fails on. Nothing is the honest answer before the
    // first /api/tags call, and the card tells the user to sync instead.
    const models = await adapter([], []).listModels()
    expect(models).toHaveLength(0)
  })
})