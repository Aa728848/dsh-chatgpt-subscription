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
      status: () => ({ subagentModel: 'gpt-5.6-luna' }),
    }
    expect(installSubagentModelPreference(ctx as never, preferences as never)).toBe(dispose)

    const base = { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 }
    await expect(listener!({ agent: { session: { header: { origin: 'subagent' } } } } as never, async () => base)).resolves.toEqual({
      ...base,
      provider: 'codex-chatgpt',
      model: 'gpt-5.6-luna',
    })
    await expect(listener!({ agent: { session: { header: {} } } } as never, async () => base)).resolves.toBe(base)
  })
})
