import { describe, expect, it } from 'vitest'
import { CodexChatGptAdapter, PROVIDER_ID } from '../src/host/adapter.ts'

describe('CodexChatGptAdapter', () => {
  it('advertises the provider, complete model catalog, modalities and bounded retry policy', async () => {
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never)
    expect(adapter.providerInfo(PROVIDER_ID)).toEqual({ id: 'codex-chatgpt', name: 'Codex（ChatGPT 订阅）' })
    expect(await adapter.listModels()).toMatchObject([
      { id: 'gpt-5.6-sol', name: '5.6 Sol', inputModalities: ['text', 'image'] },
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
      mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'NETWORK'],
    })

    const configured = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never, {
      status: () => ({
        quickQuotaVisible: false,
        searchProvider: 'dsh',
        subagentProvider: 'codex-chatgpt',
        subagentModel: 'gpt-5.6-luna',
        subagentReasoningEffort: 'max',
        subagentContextWindow: 272_000,
        contextWindowOverrides: { 'gpt-5.6-sol': 1_000_000, 'gpt-5.6-terra': 200_000, 'gpt-5.6-luna': 256_000 },
        writable: true,
      }),
    } as never)
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.6-sol')).resolves.toMatchObject({ context: { contextWindow: 1_000_000 } })
    await expect(configured.resolveModel(PROVIDER_ID, 'gpt-5.4')).resolves.toMatchObject({ context: { contextWindow: 272_000 } })
  })
})
