import { describe, expect, it } from 'vitest'
import { installSubagentModelPreference } from '../src/host/subagent-model-preference.ts'

describe('subagent model preference', () => {
  it('routes only delegated agents through the configured subscription model', async () => {
    let listener: ((payload: never, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) | undefined
    const dispose = () => undefined
    const ctx = {
      on(name: string, callback: typeof listener) {
        expect(name).toBe('agent/request')
        listener = callback
        return dispose
      },
    }
    const preferences = {
      status: () => ({ subagentProvider: 'deepseek-official', subagentModel: 'deepseek-v4-flash', subagentReasoningEffort: 'high', subagentContextWindow: 128_000 }),
    }
    expect(installSubagentModelPreference(ctx as never, preferences as never)).toBe(dispose)

    const codexBase = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', maxTokens: 8192 }
    await expect(listener!({ agent: { session: { header: { origin: 'subagent' } } } } as never, async () => codexBase)).resolves.toEqual({
      ...codexBase,
      provider: 'dsh-subagent-model-override',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    })
    const dshDefault = { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 }
    await expect(listener!({ agent: { session: { header: { origin: 'subagent' } } } } as never, async () => dshDefault)).resolves.toBe(dshDefault)
    await expect(listener!({ agent: { session: { header: {} } } } as never, async () => codexBase)).resolves.toBe(codexBase)
  })
})
