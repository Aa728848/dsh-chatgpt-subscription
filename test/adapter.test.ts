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
      { id: 'gpt-5.6-terra', name: '5.6 Terra', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.6-luna', name: '5.6 Luna', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.5', name: '5.5', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.4', name: '5.4', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.4-mini', name: '5.4 Mini', inputModalities: ['text', 'image'] },
      { id: 'gpt-5.3-codex-spark', name: '5.3 Codex Spark', inputModalities: ['text'] },
    ])
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const resolved = await adapter.resolveModel(PROVIDER_ID, model)
      expect(resolved).toMatchObject({
        inputModalities: ['text', 'image'],
        context: { contextWindow: 272_000 },
        reasoning: { defaultEffort: 'medium' },
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
        contextWindowOverrides: { 'gpt-5.6-sol': 1_000_000, 'gpt-5.6-terra': 200_000, 'gpt-5.6-luna': 256_000 },
        subagentContextWindow: 128_000,
        subagentMaxDepth: 2,
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
      reasoning: { defaultEffort: 'medium' },
    })
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.4')).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
      reasoning: { defaultEffort: 'none' },
    })
  })

  it('exposes Astra by default with subscription capabilities and its configured context', async () => {
    let preferences = structuredClone({ ...DEFAULT_PREFERENCES, writable: true })
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, {
      status: () => preferences,
    } as never)
    expect(await adapter.listModels()).toContainEqual({
      provider: PROVIDER_ID, id: 'gpt-6-astra', name: '6 Astra', inputModalities: ['text', 'image'],
    })
    const prepared = await adapter.prepareCall(PROVIDER_ID, 'gpt-6-astra')
    expect(prepared.model).toMatchObject({
      id: 'gpt-6-astra',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 272_000 },
      reasoning: { defaultEffort: 'medium' },
    })
    expect(prepared.model.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    preferences.contextWindowOverrides['gpt-6-astra'] = 872_000
    expect((await adapter.resolveModel(PROVIDER_ID, 'gpt-6-astra')).context?.contextWindow).toBe(872_000)
    expect(prepared.model.context?.contextWindow).toBe(272_000)
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
})
