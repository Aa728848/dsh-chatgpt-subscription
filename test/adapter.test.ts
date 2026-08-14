import { describe, expect, it } from 'vitest'
import { CodexChatGptAdapter, PROVIDER_ID } from '../src/host/adapter.ts'

describe('CodexChatGptAdapter', () => {
  it('advertises the provider, complete model catalog, modalities and bounded retry policy', async () => {
    const adapter = new CodexChatGptAdapter({ stream: () => { throw new Error('unused') } } as never)
    expect(adapter.providerInfo(PROVIDER_ID)).toEqual({ id: 'codex-chatgpt', name: 'Codex（ChatGPT 订阅）' })
    expect((await adapter.listModels()).map((model) => model.id)).toEqual([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2',
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
      ['gpt-5.2', 'none'],
    ] as const) {
      const resolved = await adapter.resolveModel(PROVIDER_ID, model)
      expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(expectedStandardEfforts)
      expect(resolved.reasoning?.defaultEffort).toBe(defaultEffort)
    }
    expect(adapter.providerRetryPolicy()).toMatchObject({
      mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'NETWORK'],
    })
  })
})
