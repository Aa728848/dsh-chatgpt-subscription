import { describe, expect, it } from 'vitest'
import { CodexChatGptAdapter, PROVIDER_ID } from '../src/host/adapter.ts'
import { DEFAULT_PREFERENCES } from '../src/shared/preferences.ts'

describe('CodexChatGptAdapter', () => {
  it('advertises the provider, complete model catalog, modalities and bounded retry policy', async () => {
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never)
    expect(adapter.providerInfo(PROVIDER_ID)).toEqual({ id: 'codex-chatgpt', name: 'Codex（ChatGPT 订阅）' })
    expect(await adapter.listModels()).toMatchObject([
      { id: 'gpt-5.6-sol', name: '5.6 Sol', inputModalities: ['text', 'image'] },
      { id: 'gpt-6-astra', name: '6 Astra', inputModalities: ['text', 'image'] },
      { id: 'gpt-6.1-sol', name: '6.1 Sol', inputModalities: ['text', 'image'] },
      { id: 'gpt-6.1-terra', name: '6.1 Terra', inputModalities: ['text', 'image'] },
      { id: 'gpt-6-sol', name: '6 Sol', inputModalities: ['text', 'image'] },
      { id: 'gpt-6-luna', name: '6 Luna', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.6-terra', name: '5.6 Terra', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.6-luna', name: '5.6 Luna', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.5', name: '5.5', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.4', name: '5.4', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.4-mini', name: '5.4 Mini', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.3-codex-spark', name: '5.3 Codex Spark', inputModalities: ['text'] },
    ])
    // The windows and the default reasoning levels are the official 0.166.0
    // catalog's, not this line's guesses: 5.6 Sol starts at `low` while its
    // Terra and Luna siblings start at `medium`.
    for (const [model, defaultEffort] of [
      ['gpt-5.6-sol', 'low'],
      ['gpt-5.6-terra', 'medium'],
      ['gpt-5.6-luna', 'medium'],
    ] as const) {
      const resolved = await adapter.resolveModel(PROVIDER_ID, model)
      expect(resolved).toMatchObject({
        inputModalities: ['text', 'image'],
        context: { contextWindow: 272_000 },
        defaultMaxTokens: 32_768,
        reasoning: { defaultEffort },
      })
      expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual([
        'none', 'low', 'medium', 'high', 'xhigh', 'max',
      ])
    }

    const expectedStandardEfforts = ['none', 'low', 'medium', 'high', 'xhigh']
    for (const [model, defaultEffort] of [
      ['gpt-5.5', 'medium'],
      ['gpt-5.4', 'none'],
      ['gpt-5.4-mini', 'none'],
      ['gpt-5.3-codex-spark', 'high'],
    ] as const) {
      const resolved = await adapter.resolveModel(PROVIDER_ID, model)
      expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(expectedStandardEfforts)
      expect(resolved.reasoning?.defaultEffort).toBe(defaultEffort)
    }
    await expect(adapter.resolveModel(PROVIDER_ID, 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      name: '5.3 Codex Spark',
      inputModalities: ['text'],
      context: { contextWindow: 258_000 },
      defaultMaxTokens: 32_768,
    })
    expect(adapter.providerRetryPolicy()).toMatchObject({
      mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'SERVER', 'NETWORK', 'TIMEOUT', 'TRANSPORT'],
    })
    expect(adapter.imageRequestPricing(PROVIDER_ID, 'gpt-5.6-sol')).toBeUndefined()

    const configured = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, {
      status: () => ({
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: 'dsh',
        contextWindowOverrides: { 'gpt-5.6-sol': 1_000_000, 'gpt-5.6-terra': 200_000, 'gpt-5.6-luna': 256_000, 'gpt-5.4': 400_000 },
        proxyMode: 'auto',
        customProxyUrl: null,
        writable: true,
      }),
    } as never)
    await expect(configured.listModels()).resolves.toHaveLength(3)
    await expect(configured.listModels()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-5.6-sol' }),
      expect.objectContaining({ id: 'gpt-5.6-terra' }),
      expect.objectContaining({ id: 'gpt-5.6-luna' }),
    ]))
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.6-sol')).resolves.toMatchObject({
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_768,
      reasoning: { defaultEffort: 'low' },
    })
    // A model outside the default-visible set carries an override too; one with
    // none still resolves to its catalog context window.
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.4')).resolves.toMatchObject({
      context: { contextWindow: 400_000 },
      defaultMaxTokens: 32_768,
      reasoning: { defaultEffort: 'none' },
    })
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      context: { contextWindow: 258_000 },
    })
  })

  it('exposes the GPT-6 family by default with subscription capabilities and its configured context', async () => {
    let preferences = structuredClone({ ...DEFAULT_PREFERENCES, writable: true })
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, {
      status: () => preferences,
    } as never)
    // The GPT-6 family windows and default levels come from the official
    // 0.166.0 catalog: 6.1 Terra carries 500K while Astra and the 6.x Sol/Luna
    // models carry 272K, and the default level is `low` for Astra and 6.1
    // Terra but `medium` for 6 Sol and 6 Luna.
    for (const [model, name, contextWindow, defaultEffort] of [
      ['gpt-6-astra', '6 Astra', 272_000, 'low'],
      ['gpt-6.1-terra', '6.1 Terra', 500_000, 'low'],
      ['gpt-6-sol', '6 Sol', 272_000, 'medium'],
      ['gpt-6-luna', '6 Luna', 272_000, 'medium'],
    ] as const) {
      expect(await adapter.listModels()).toContainEqual({
        provider: PROVIDER_ID, id: model, name, inputModalities: ['text', 'image'],
      })
      const prepared = await adapter.prepareCall(PROVIDER_ID, model)
      expect(prepared.model).toMatchObject({
        id: model,
        inputModalities: ['text', 'image'],
        context: { contextWindow },
        defaultMaxTokens: 128_000,
        reasoning: { defaultEffort },
      })
      expect(prepared.model.reasoning?.efforts.map(effort => effort.id)).toEqual([
        'low', 'medium', 'high', 'xhigh', 'max',
      ])
      preferences.contextWindowOverrides[model] = 872_000
      expect((await adapter.resolveModel(PROVIDER_ID, model)).context?.contextWindow).toBe(872_000)
      // The prepared call keeps the generation it was bound to.
      expect(prepared.model.context?.contextWindow).toBe(contextWindow)
      preferences.contextWindowOverrides[model] = contextWindow
    }
    preferences = { ...preferences, visibleModelIds: ['gpt-5.6-sol'] }
    expect(await adapter.listModels()).toHaveLength(1)
  })

  it('binds one model-resolution generation to its eventual stream via prepareCall', async () => {
    const client = { stream: () => { throw new Error('unused') } } as never
    const adapter = new CodexChatGptAdapter(client)
    const prepared = await adapter.prepareCall(PROVIDER_ID, 'gpt-5.6-luna')
    expect(prepared.model).toMatchObject({
      provider: 'codex-chatgpt',
      id: 'gpt-5.6-luna',
      inputModalities: ['text', 'image'],
      reasoning: { defaultEffort: 'medium' },
    })
    expect(typeof prepared.stream).toBe('function')
  })

  it('binds the listing it resolved against to the prepared call', async () => {
    // The live listing is the authority on what the plan serves, so the request
    // has to speak the protocol THAT listing states. A listing that says a model
    // is not Lite outranks the shipped table, which says it is.
    let resolve: ((model: string) => { useResponsesLite: boolean }) | undefined
    const client = {
      stream: (
        _options: unknown,
        capabilities?: (model: string) => { useResponsesLite: boolean },
      ) => {
        resolve = capabilities
        return (async function* noChunks() { /* the call is never read here */ })()
      },
    } as never
    const listing = [{
      id: 'gpt-6-astra',
      name: '6 Astra',
      contextWindow: 400_000,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      useResponsesLite: false,
    }]
    const adapter = new CodexChatGptAdapter(client, undefined, async () => listing)

    const prepared = await adapter.prepareCall(PROVIDER_ID, 'gpt-6-astra')
    expect(prepared.model.context?.contextWindow).toBe(400_000)
    for await (const _chunk of prepared.stream({} as never)) { /* drain */ }

    expect(resolve?.('gpt-6-astra')).toEqual({ useResponsesLite: false })
    // A model the listing says nothing about still falls back to the shipped table.
    expect(resolve?.('gpt-5.5')).toEqual({ useResponsesLite: false })
  })
  it('returns empty model list when disabled or visibleModelIds is empty', async () => {
    const disabledPrefs = {
      status: () => ({ ...DEFAULT_PREFERENCES, enabled: false, writable: true }),
      update: async () => ({ ...DEFAULT_PREFERENCES, enabled: false, writable: true }),
      watch: () => () => undefined,
    }
    const disabledAdapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, disabledPrefs as never)
    expect(await disabledAdapter.listModels()).toEqual([])

    const emptyModelsPrefs = {
      status: () => ({ ...DEFAULT_PREFERENCES, visibleModelIds: [], writable: true }),
      update: async () => ({ ...DEFAULT_PREFERENCES, visibleModelIds: [], writable: true }),
      watch: () => () => undefined,
    }
    const emptyAdapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, emptyModelsPrefs as never)
    expect(await emptyAdapter.listModels()).toEqual([])
  })
})
