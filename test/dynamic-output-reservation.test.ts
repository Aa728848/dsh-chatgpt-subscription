import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import { KIMI_CODE_MODELS } from '../src/host/kimi-code/model-catalog.ts'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'
import { MinimaxCodeCredentialStore, MinimaxCodeModelSettingsStore, parseMinimaxCodeCredentials } from '../src/host/minimax-code/token-store.ts'
import { MINIMAX_CODE_MODELS } from '../src/host/minimax-code/model-catalog.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function fixture(provider: string, anthropic = false, overrides: Record<string, number> = {}) {
  const bodies: Record<string, unknown>[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const frames = provider === 'minimax-code' || anthropic
      ? [{ type: 'message_start', message: { id: 'test', usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' }]
      : [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
  }
  if (provider === 'kimi-code') {
    const store = new FileCredentialStore('unused-kimi-credentials.json')
    vi.spyOn(store, 'read').mockResolvedValue({ accessToken: 'test', refreshToken: 'test',
      expiresAt: Date.now() + 86_400_000, expiresIn: 86_400, region: 'mainland-cn',
      oauthHost: 'https://auth.kimi.com', baseUrl: 'https://api.kimi.com/coding' })
    const settings = new FileModelSettingsStore('unused-kimi-models.json')
    vi.spyOn(settings, 'read').mockResolvedValue({ enabledModelIds: KIMI_CODE_MODELS.map(m => m.id),
      catalogModels: [], contextWindowOverrides: overrides, defaultReasoningEffort: null, cacheTtl: null })
    return { bodies, adapter: new KimiCodeAdapter(store, settings, undefined, { fetchFn,
      loadCatalog: async () => KIMI_CODE_MODELS.map(m => ({ id: m.id, contextWindow: m.contextWindow,
        ...(anthropic ? { protocol: 'anthropic' as const } : {}) })) }) }
  }
  const store = new MinimaxCodeCredentialStore()
  vi.spyOn(store, 'read').mockResolvedValue(parseMinimaxCodeCredentials({ accessToken: 'test',
    refreshToken: 'test', expiresAtMs: Date.now() + 86_400_000, region: 'cn' }, { region: 'cn' }))
  const settings = new MinimaxCodeModelSettingsStore()
  vi.spyOn(settings, 'read').mockResolvedValue({ enabled: true, enabledModelIds: MINIMAX_CODE_MODELS.map(m => m.id),
    contextWindowOverrides: overrides, defaultReasoningEffort: null })
  return { bodies, adapter: new MinimaxCodeAdapter(store, { fetchFn }, settings) }
}

// DSH compaction-basic 0.2.0-rc.2 contract; intentionally no runtime dependency
// on that optional plugin. Inputs come from the real LLM service, not a wire cap.
function pressure(window: number, reserved: number) {
  const messageBudget = window - reserved
  const threshold = Math.floor(Math.min(window * 0.8, messageBudget - 65_536))
  const retain = Math.floor(messageBudget * 0.16)
  expect(threshold).toBeGreaterThan(0)
  expect(retain).toBeLessThan(threshold)
  return threshold
}

async function runtime(provider: string, adapter: KimiCodeAdapter | MinimaxCodeAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([provider], adapter)
  return ctx.llm
}

const models = [
  ...KIMI_CODE_MODELS.map(m => ({ provider: 'kimi-code', model: m.id, window: m.contextWindow })),
  ...MINIMAX_CODE_MODELS.map(m => ({ provider: 'minimax-code', model: m.id, window: m.contextWindow })),
]

describe('dynamic output budgets are not fixed compaction reservations', () => {
  it.each(models)('$provider/$model leaves a usable default compaction budget', async ({ provider, model, window }) => {
    const { adapter } = fixture(provider)
    expect(await adapter.resolveModel(provider, model)).not.toHaveProperty('defaultMaxTokens')
    expect((await adapter.prepareCall(provider, model)).model).not.toHaveProperty('defaultMaxTokens')
    const llm = await runtime(provider, adapter)
    const prepared = await llm.prepareCall({ provider, model })
    expect(prepared.config).not.toHaveProperty('maxTokens')
    const info = await llm.resolveModelInfo(provider, model)
    expect(info.context?.contextWindow).toBe(window)
    const reserved = prepared.config.maxTokens ?? info.defaultMaxTokens ?? 0
    expect(reserved).toBe(0)
    expect(pressure(window, reserved)).toBe(Math.floor(Math.min(window * 0.8, window - 65_536)))
  })

  const wires = [
    { provider: 'kimi-code', model: 'k3', anthropic: false, field: 'max_completion_tokens', window: 262_144, cap: 258_048 },
    { provider: 'kimi-code', model: 'k3', anthropic: true, field: 'max_tokens', window: 262_144, cap: 258_048 },
    { provider: 'minimax-code', model: 'MiniMax-M2.7', anthropic: true, field: 'max_tokens', window: 200_000, cap: 128_000 },
  ]
  for (const wire of wires) {
    it.each([undefined, 4096, 65_536])(
      wire.provider + '/' + wire.field + ' preserves default or explicit cap %s through DSH', async maxTokens => {
        const { adapter, bodies } = fixture(wire.provider, wire.anthropic)
        const llm = await runtime(wire.provider, adapter)
        const prepared = await llm.prepareCall({ provider: wire.provider, model: wire.model,
          ...(maxTokens === undefined ? {} : { maxTokens }) })
        expect(prepared.config.maxTokens).toBe(maxTokens)
        const request = { ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } as GenerateOptions
        for await (const _chunk of prepared.stream(request)) { /* consume mocked SSE */ }
        expect(bodies).toHaveLength(1)
        expect(bodies[0]?.[wire.field]).toBe(maxTokens ?? Math.min(wire.cap, wire.window - 4096 - 2))
        expect(request.maxTokens).toBe(maxTokens)
      })

    it(wire.provider + '/' + wire.field + ' clamps against an overridden window and large prompt', async () => {
      const window = 131_072
      const { adapter, bodies } = fixture(wire.provider, wire.anthropic, { [wire.model]: window })
      const llm = await runtime(wire.provider, adapter)
      const prepared = await llm.prepareCall({ provider: wire.provider, model: wire.model })
      const info = await llm.resolveModelInfo(wire.provider, wire.model)
      expect(info.context?.contextWindow).toBe(window)
      expect(pressure(window, prepared.config.maxTokens ?? info.defaultMaxTokens ?? 0)).toBe(65_536)
      for await (const _chunk of prepared.stream({ ...prepared.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(240_000) }] }] } as GenerateOptions)) { /* consume */ }
      expect(bodies[0]?.[wire.field]).toBe(window - 4096 - 60_000)
    })
  }
})
