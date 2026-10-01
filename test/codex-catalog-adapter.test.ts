import { describe, expect, it, vi } from 'vitest'
import { CodexChatGptAdapter, PROVIDER_ID } from '../src/host/adapter.ts'
import type { CodexCatalogEntry } from '../src/host/codex-catalog.ts'

const client = { stream: () => { throw new Error('unused') } } as never

describe('CodexChatGptAdapter live catalog', () => {
  it('serves the listing the account can call, including a model the shipped table never had', async () => {
    const live: CodexCatalogEntry[] = [
      { id: 'gpt-6-astra', name: '6 Astra', contextWindow: 400_000, inputModalities: ['text', 'image'] },
      { id: 'gpt-7-unreleased', name: '7 Unreleased', contextWindow: 900_000, inputModalities: ['text'] },
    ]
    const adapter = new CodexChatGptAdapter(client, undefined, async () => live)

    expect(await adapter.listModels()).toMatchObject([
      { id: 'gpt-6-astra', name: '6 Astra' },
      { id: 'gpt-7-unreleased', name: '7 Unreleased' },
    ])

    // The backend's window outranks the shipped table's starting value.
    const resolved = await adapter.resolveModel(PROVIDER_ID, 'gpt-7-unreleased')
    expect(resolved.name).toBe('7 Unreleased')
    expect(resolved.context?.contextWindow).toBe(900_000)
    expect(resolved.inputModalities).toEqual(['text'])
  })

  it('takes the reasoning levels the listing states', async () => {
    const adapter = new CodexChatGptAdapter(client, undefined, async () => [
      {
        id: 'gpt-6-sol',
        name: '6 Sol',
        contextWindow: null,
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
    ])

    const resolved = await adapter.resolveModel(PROVIDER_ID, 'gpt-6-sol')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('drops a reasoning level this line cannot express', async () => {
    // A level outside the shared vocabulary is not an effort the picker can
    // offer, so it must not reach the model as an option.
    const adapter = new CodexChatGptAdapter(client, undefined, async () => [
      {
        id: 'gpt-6-sol',
        name: '6 Sol',
        contextWindow: null,
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'ultra-turbo', 'high'],
        defaultReasoningEffort: 'ultra-turbo',
      },
    ])

    const resolved = await adapter.resolveModel(PROVIDER_ID, 'gpt-6-sol')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
    // The default is taken from what survived, not from the dropped level.
    expect(resolved.reasoning?.defaultEffort).toBe('low')
  })

  it('falls back to the shipped table when the listing names nothing', async () => {
    const adapter = new CodexChatGptAdapter(client, undefined, async () => [])

    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((model) => model.id)).toContain('gpt-6-sol')
  })

  it('keeps the picker populated when the listing carries no chat model', async () => {
    // Several plans answer the subscription listing with only the account's
    // code-review slug, naming no chat model at all. Honouring that literally
    // would delete every model the user's own selection asks for and leave an
    // empty picker, so the shipped table has to answer instead.
    const adapter = new CodexChatGptAdapter(client, {
      status: () => ({ visibleModelIds: ['gpt-6-astra'] }),
    } as never, async () => [
      {
        id: 'codex-auto-review',
        name: 'Codex Auto Review',
        contextWindow: 272_000,
        inputModalities: ['text', 'image'],
      },
    ])

    expect((await adapter.listModels()).map((model) => model.id)).toEqual(['gpt-6-astra'])
  })

  it('still narrows to the listing when it does offer a selected model', async () => {
    // The fallback is for a listing that cannot satisfy the selection, not a
    // licence to widen every picker: a listing naming a selected model stays
    // authoritative and keeps the models the user did not select out.
    const adapter = new CodexChatGptAdapter(client, {
      status: () => ({ visibleModelIds: ['gpt-6-astra', 'gpt-6-sol'] }),
    } as never, async () => [
      { id: 'gpt-6-astra', name: '6 Astra', contextWindow: null, inputModalities: ['text', 'image'] },
      { id: 'codex-auto-review', name: 'Codex Auto Review', contextWindow: 272_000, inputModalities: ['text'] },
    ])

    expect((await adapter.listModels()).map((model) => model.id)).toEqual(['gpt-6-astra'])
  })

  it('never lets a failing listing break the picker', async () => {
    // A catalog is an optimization; a rejected or unreachable endpoint must not
    // turn into a failed model selection.
    const adapter = new CodexChatGptAdapter(client, undefined, async () => {
      throw new Error('listing unavailable')
    })

    expect((await adapter.listModels()).map((model) => model.id)).toContain('gpt-6-sol')
    expect((await adapter.resolveModel(PROVIDER_ID, 'gpt-6-sol')).id).toBe('gpt-6-sol')
  })

  it('passes the abort signal through to the loader', async () => {
    const loadCatalog = vi.fn(async () => [] as CodexCatalogEntry[])
    const adapter = new CodexChatGptAdapter(client, undefined, loadCatalog)
    const controller = new AbortController()

    await adapter.resolveModel(PROVIDER_ID, 'gpt-6-sol', controller.signal)

    expect(loadCatalog).toHaveBeenCalledWith({ signal: controller.signal })
  })
})