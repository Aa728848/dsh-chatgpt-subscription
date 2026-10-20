import { describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { AccountPoolStore } from '../src/host/antigravity/account-pool.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'
import { BlockAssembler, createAssistantMessage, createToolResultMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

import os from 'node:os'
import path from 'node:path'

/** A pool backend that keeps the pool document in memory; nothing touches disk. */
class MemoryCredentialStore {
  private data: unknown = null
  async load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/**
 * A pool holding exactly the legacy account, so a test never reads (or writes)
 * the real pool document on the machine that runs it.
 */
function poolWithLegacyAccount(store: FileCredentialStore): AccountPoolStore {
  return new AccountPoolStore(
    path.join(os.tmpdir(), `test-antigravity-pool-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    new MemoryCredentialStore() as any,
    store,
  )
}

describe('AntigravityAdapter', () => {
  it.each(['gemini-3.7-flash', 'gemini-3.8-flash'])('preserves %s IDs, thinking and usage through a complete tool execution round trip', async (modelId) => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'test-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.7-flash'], catalogModels: [], defaultReasoningEffort: 'low' })
    const preferences = {
      status: () => ({ enabledModelIds: ['gemini-3.7-flash'], catalogModels: [], defaultReasoningEffort: 'high' as const }),
      update: vi.fn(),
    }
    const adapter = new AntigravityAdapter(store, modelSettings, preferences)
    const captured: any[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)))
      const first = captured.length === 1
      const frames = [
        { response: { candidates: [{ content: { parts: [{ thought: true, text: first ? '先检查代码' : '根据执行结果继续思考' }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'thinking-state' }] } }] } },
        { response: { candidates: [{ content: { parts: first ? [
          { functionCall: { id: 'run-1', name: 'run_code', args: { code: 'print(1)' } }, thoughtSignature: 'call-state' },
        ] : [{ text: '执行结果是 1。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 } } },
        { response: { usageMetadata: { cachedContentTokenCount: 80, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 120 } } },
      ]
      const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''))
      return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
        controller.close()
      } }))
    }) as typeof fetch
    try {
      const options = {
        provider: 'antigravity', model: modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the code' }] }],
        tools: [{ name: 'run_code', parameters: { type: 'object', properties: { code: { type: 'string' } } } }],
      } as unknown as GenerateOptions
      const first = new BlockAssembler()
      const firstChunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(options)) { first.push(chunk); firstChunks.push(chunk) }
      expect(first.finish).toEqual({ kind: 'tool-calls' })
      expect(firstChunks.filter((chunk) => chunk.type === 'usage')).toHaveLength(1)
      expect(firstChunks[firstChunks.length - 1].type).toBe('finish')
      expect(first.usage).toEqual({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 20, reasoningTokens: 8 })
      const call = first.blocks().find((block) => block.type === 'tool-call')!
      const assistant = createAssistantMessage({ content: first.blocks(), source: {
        provider: 'antigravity', model: options.model, replayState: first.replayState,
      } })
      const nextOptions = { ...options, messages: [...options.messages, assistant, {
        role: 'user', content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: '1' }] }],
      }] } as unknown as GenerateOptions
      const second = new BlockAssembler()
      for await (const chunk of adapter.stream(nextOptions)) second.push(chunk)
      expect(second.blocks()).toContainEqual({ type: 'reasoning', text: '根据执行结果继续思考' })
      expect(second.blocks()).toContainEqual({ type: 'text', text: '执行结果是 1。' })
      expect(second.usage).toEqual(first.usage)
      expect(captured[1].request.contents[1].parts).toEqual([
        { thought: true, text: '先检查代码' },
        { text: '', thoughtSignature: 'thinking-state' },
        { functionCall: { id: 'run-1', name: 'run_code', args: { code: 'print(1)' } }, thoughtSignature: 'call-state' },
      ])
      expect(captured[1].request.contents[2].parts[0].functionResponse).toEqual({ id: 'run-1', name: 'run_code', response: { output: '1' } })
      // 3.8 is served through its tiered runtime, which takes the level in the
      // request; 3.7 has no tiered runtime in the catalog and encodes the level
      // in its runtime id instead.
      const expected = modelId === 'gemini-3.8-flash'
        ? { model: 'gemini-3.8-flash-tiered', thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } }
        : { model: 'gemini-3.7-flash-high', thinkingConfig: { includeThoughts: true } }
      for (const body of captured) {
        expect(body.model).toBe(expected.model)
        expect(body.request.generationConfig.thinkingConfig).toEqual(expected.thinkingConfig)
      }

      // The same history as harness 0.1.7 delivers it: the result is its own
      // `role: 'tool'` message, which the adapter normalizes before any mapper
      // reads it. Both generations must build the same request.
      const currentOptions = {
        ...options,
        messages: [...options.messages, assistant, createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: '1' }],
          isError: false,
        })],
      }
      const third = new BlockAssembler()
      for await (const chunk of adapter.stream(currentOptions)) third.push(chunk)
      expect(third.blocks()).toEqual(second.blocks())
      expect(captured[2].request.contents).toEqual(captured[1].request.contents)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports provider info and lists enabled models including gemini-3.8-flash', async () => {
    const store = new FileCredentialStore(path.join(os.tmpdir(), `test-cred-${Date.now()}.json`))
    const modelSettings = new FileModelSettingsStore(path.join(os.tmpdir(), `test-models-${Date.now()}.json`))
    const adapter = new AntigravityAdapter(store, modelSettings)

    const info = adapter.providerInfo('antigravity')
    expect(info.id).toBe('antigravity')
    expect(info.name).toBe('Antigravity')

    const models = await adapter.listModels('antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'gemini-3.8-flash')).toBe(true)
    expect(models.some((m) => m.id === 'gemini-3.7-flash')).toBe(true)
    expect(models.some((m) => m.id === 'claude-opus-5-5')).toBe(true)
    expect(models.some((m) => m.id === 'gemini-3.5-flash-lite')).toBe(true)
    expect(models.some((m) => m.id === 'gemini-3.1-flash-lite')).toBe(true)
    // Gone from the service catalog, or unusable through a text-only chat route.
    for (const removed of ['claude-opus-4-6', 'claude-sonnet-4-6', 'gemini-3.1-flash-image']) {
      expect(models.some((m) => m.id === removed)).toBe(false)
    }

    const g38 = models.find((m) => m.id === 'gemini-3.8-flash')!
    expect(g38.name).toBe('Gemini 3.8 Flash')
    expect((g38 as unknown as { reasoningEfforts?: string[] }).reasoningEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('resolves model correctly with reasoning efforts and context window overrides', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    // 预设上下文覆盖
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.8-flash'],
      catalogModels: [],
      contextWindowOverrides: {
        'gemini-3.8-flash': 524288, // 自定义 512K
      },
    })

    const adapter = new AntigravityAdapter(store, modelSettings)
    const resolved = await adapter.resolveModel('antigravity', 'gemini-3.8-flash')
    expect(resolved.id).toBe('gemini-3.8-flash')
    expect(resolved.name).toBe('Gemini 3.8 Flash')
    expect(resolved.context?.contextWindow).toBe(524288) // 覆盖生效
    expect(resolved.reasoning?.efforts.map((e) => e.name)).toEqual(['low', 'medium', 'high'])
    expect(resolved.reasoning?.defaultEffort).toBe('medium')

    const list = await adapter.listModels('antigravity')
    expect((list[0] as unknown as { context?: { contextWindow?: number } }).context?.contextWindow).toBe(524288)
  })

  it('sanitizes defaultEffort for models like gemini-3.1-pro whose efforts do not include medium', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.1-pro'],
      catalogModels: [],
      // defaultReasoningEffort 未指定，按以往逻辑会 fallback 到 medium
    })

    const adapter = new AntigravityAdapter(store, modelSettings)
    const resolved = await adapter.resolveModel('antigravity', 'gemini-3.1-pro')
    expect(resolved.id).toBe('gemini-3.1-pro')
    const efforts = resolved.reasoning?.efforts.map((e) => e.name) ?? []
    expect(efforts).toEqual(['low', 'high'])
    // defaultEffort 必须包含在 efforts 中，绝不能是 'medium'
    expect(efforts).toContain(resolved.reasoning?.defaultEffort)
    expect(resolved.reasoning?.defaultEffort).toBe('low')
  })

  it('honors configured defaultReasoningEffort when supported by model, and falls back safely when not supported', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    // 1. 用户配置 high，gemini-3.1-pro 支持 high
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.1-pro'],
      catalogModels: [],
      defaultReasoningEffort: 'high',
    })
    const adapter1 = new AntigravityAdapter(store, modelSettings)
    const resolved1 = await adapter1.resolveModel('antigravity', 'gemini-3.1-pro')
    expect(resolved1.reasoning?.defaultEffort).toBe('high')

    // 2. 用户配置 medium，gemini-3.1-pro 不支持 medium，安全兜底到 low
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.1-pro'],
      catalogModels: [],
      defaultReasoningEffort: 'medium',
    })
    const adapter2 = new AntigravityAdapter(store, modelSettings)
    const resolved2 = await adapter2.resolveModel('antigravity', 'gemini-3.1-pro')
    expect(resolved2.reasoning?.defaultEffort).toBe('low')
  })

  it('verifies that all MODELS pass official dsh-llm reasoning metadata validation', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()
    const adapter = new AntigravityAdapter(store, modelSettings)

    const list = await adapter.listModels('antigravity')
    for (const item of list) {
      const resolved = await adapter.resolveModel('antigravity', item.id)
      if (resolved.reasoning) {
        expect(resolved.reasoning.efforts.length).toBeGreaterThan(0)
        const seen = new Set(resolved.reasoning.efforts.map((e) => e.id))
        if (resolved.reasoning.defaultEffort !== undefined) {
          expect(seen.has(resolved.reasoning.defaultEffort)).toBe(true)
        }
      }
    }
  })

  it('uses defaultReasoningEffort when options.reasoningEffort is not specified', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      expires: Date.now() + 3_600_000,
    })

    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['gemini-3.8-flash'],
      catalogModels: [],
      defaultReasoningEffort: 'high',
    })

    let capturedBody: any
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      const sseContent = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"finishReason":"STOP"}\n'
      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(store, modelSettings)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        // 未传 reasoningEffort，应自动应用默认 high
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) {
        chunks.push(chunk)
      }

      expect(capturedBody.model).toBe('gemini-3.8-flash-tiered')
      expect(capturedBody.request.generationConfig.thinkingConfig.thinkingLevel).toBe('HIGH')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([
    JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Unknown name "propertyNames" at parameters.properties[3].value' } }),
    'Invalid JSON payload received: unsupported thinkingLevel',
  ])('preserves a 400 diagnostic without trying a different endpoint or model: %s', async (errorBody) => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(errorBody, { status: 400 }))
      .mockImplementation(async () => new Response('fallback model not found', { status: 404 }))
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn })
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash', messages: [],
      } as GenerateOptions)) { /* Drain the request. */ }
    }
    await expect(run()).rejects.toMatchObject({
      code: 'PROVIDER_ERROR', failure: { status: 400 }, message: `Antigravity API error (400): ${errorBody}`,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports a 404 for the selected runtime instead of retrying on a lower tier', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      refresh: 'mock-refresh-token',
      expires: Date.now() + 3_600_000,
      projectId: 'mock-proj',
    })

    const fetchCalls: Array<{ url: string; model: string }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const reqModel = body.model
      fetchCalls.push({ url: String(url), model: reqModel })

      if (reqModel === 'gemini-3.6-flash-high') {
        return new Response('runtime model not found', { status: 404 })
      }

      const sseContent = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello from fallback"}]}}],"finishReason":"STOP"}',
        '',
      ].join('\n')

      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(store, modelSettings)
      const run = async () => {
        for await (const _chunk of adapter.stream({
          provider: 'antigravity',
          model: 'gemini-3.6-flash',
          reasoningEffort: 'high',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        } as unknown as GenerateOptions)) { /* drain */ }
      }

      await expect(run()).rejects.toMatchObject({ code: 'PROVIDER_ERROR', failure: { status: 404 } })
      // The user picked High: a rejected High is reported, never quietly served as Low.
      expect(fetchCalls.map((call) => call.model)).toEqual(['gemini-3.6-flash-high'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports a 429 on the selected model without switching models, cooling only that quota family', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    vi.spyOn(store, 'read').mockResolvedValue({
      access: 'mock-access-token',
      expires: Date.now() + 3_600_000,
    })

    const fetchCalls: Array<{ model: string }> = []
    const originalFetch = globalThis.fetch
    const errorBody = JSON.stringify({ error: {
      code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', metadata: { quotaResetDelay: '2h30m' } }],
    } })

    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      fetchCalls.push({ model: body.model })
      return new Response(errorBody, { status: 429 })
    }) as typeof fetch

    try {
      const pool = new AccountPoolStore(undefined, undefined, store)
      const adapter = new AntigravityAdapter(store, modelSettings, undefined, {}, pool)
      const run = async () => {
        for await (const _chunk of adapter.stream({
          provider: 'antigravity',
          model: 'gemini-3.8-flash',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'test 429' }] }],
        } as unknown as GenerateOptions)) { /* drain */ }
      }

      await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
      // The selected model was asked for, and no other model.
      expect(new Set(fetchCalls.map((call) => call.model))).toEqual(new Set(['gemini-3.8-flash-tiered']))
      const accountId = (await pool.read()).accounts[0]!.id
      expect(pool.familyCoolingAccountIds('gemini').has(accountId)).toBe(true)
      expect(pool.familyCoolingAccountIds('claude-gpt').has(accountId)).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('asks the primary endpoint once for a 429 and never falls through to the fallback endpoint', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-access-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    // A quota verdict: the body states when the allowance resets.
    const errorBody = JSON.stringify({ error: {
      code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', metadata: { quotaResetDelay: '2h30m' } }],
    } })
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(errorBody, { status: 429 }))
    const pool = poolWithLegacyAccount(store)
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn }, pool)
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test 429' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    }

    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    // One request only: the prod endpoint answers every Antigravity request
    // with a permanent bare 429, so asking it after a real verdict could only
    // replace that verdict with a meaningless one.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports the first endpoint outcome when a later endpoint answers 429', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-access-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: {
        code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED',
      } }), { status: 429 }))
    const pool = poolWithLegacyAccount(store)
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn }, pool)
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test 5xx then 429' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    }

    // The prod endpoint's permanent 429 must not be reported over the first
    // endpoint's failure. The first endpoint's 5xx is a transient server-side
    // failure, so it surfaces under the code the harness retries.
    await expect(run()).rejects.toMatchObject({ code: 'SERVER', failure: { status: 503 } })
    expect(pool.familyCoolingAccountIds('gemini').size).toBe(0)
  })

  it('reports a connection-level failure as a retryable TRANSPORT, not a fabricated 500', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-access-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    const cause = new TypeError('fetch failed')
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(cause)
    const pool = poolWithLegacyAccount(store)
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn }, pool)
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test transport' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    }

    // Every endpoint rejected, so no status was ever received: a 500 here would
    // be a number this adapter made up.
    await expect(run()).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('treats a 429 without a stated reset time as a transient rate limit, not a spent quota', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-access-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    // What the prod endpoint answers with: no details, no Retry-After.
    const bareBody = JSON.stringify({ error: {
      code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED',
    } })
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(bareBody, { status: 429 }))
    const pool = poolWithLegacyAccount(store)
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn }, pool)
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test bare 429' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    }

    // Retryable, and not a claim about the account's allowance.
    await expect(run()).rejects.toMatchObject({
      code: 'SERVER',
      failure: { status: 429 },
      message: expect.stringContaining('RESOURCE_EXHAUSTED'),
    })
    // Nothing is cooled: a bare 429 carries no information about the account's
    // Gemini allowance, and a quota verdict needs evidence.
    expect(pool.familyCoolingAccountIds('gemini').size).toBe(0)
    // The account is still selectable by the next request.
    const accountId = (await pool.read()).accounts[0]!.id
    expect((await pool.getEffectiveAccountFor('gemini', undefined, fetchFn)).account.id).toBe(accountId)
  })

  it('carries the upstream body into the next attempt, where the pool guard reports it', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'mock-access-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] })
    const errorBody = JSON.stringify({ error: {
      code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', metadata: { quotaResetDelay: '1h2m3s' } }],
    } })
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(errorBody, { status: 429 }))
    const pool = poolWithLegacyAccount(store)
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { fetchFn }, pool)
    const run = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'antigravity', model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test 429' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    }

    // The first attempt cools the family and reports the upstream body itself.
    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // The second attempt is answered by the pool guard, and its message now
    // quotes what the upstream actually said - the body that travelled with
    // the cooldown - instead of a sentence about the pool.
    const failure = await run().then(() => null, (error: unknown) => error)
    const message = (failure as { message: string }).message
    expect(message).toContain(`上游返回：${errorBody}`)
    expect(message).not.toContain('上游返回：全部 1 个 Antigravity 账号')
    // The guard answers before any request goes out.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each(['gemini-3.8-flash', 'claude-opus-5-5'])('carries a pasted image on the %s route as inlineData instead of dropping it', async (modelId) => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'test-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const attachment = {
      attachmentId: 'sha256:0123456789abcdef',
      mediaType: 'image/png',
      bytes: png.length,
      width: 1,
      height: 1,
      name: 'shot.png',
    } as unknown as Parameters<AttachmentStore['readImage']>[0]
    const readImage = vi.fn(async () => ({ ref: attachment, data: png }))
    // The seam declares readImageRequest; this image is inside the edge ceiling.
    const readImageRequest = vi.fn(async (_ref: Parameters<AttachmentStore['readImageRequest']>[0],
      _target: Parameters<AttachmentStore['readImageRequest']>[1]) => ({ attachment, variantId: 'variant' as never, data: png,
      mediaType: 'image/png' as const, bytes: png.length, width: 1, height: 1,
      depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false }))
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage, readImageRequest } })

    const captured: any[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)))
      const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } }
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))
    }) as typeof fetch

    try {
      const options = {
        provider: 'antigravity',
        model: modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment }] }],
      } as unknown as GenerateOptions
      for await (const chunk of adapter.stream(options)) { void chunk }

      expect(readImage).toHaveBeenCalledTimes(1)
      expect(captured).toHaveLength(1)
      expect(captured[0].request.contents[0].parts).toEqual([
        { text: 'look' },
        { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('omits the oldest image once one request exceeds the inline image budget', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'test-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })

    // Two 6 MiB images are 16 MiB of base64 against a 12 MiB budget.
    const raw = 6 * 1024 * 1024
    const sized = (id: string) => ({
      attachmentId: id, mediaType: 'image/png', bytes: raw, width: 1, height: 1,
    } as unknown as Parameters<AttachmentStore['readImage']>[0])
    const oldest = sized('sha256:oldest')
    const newest = sized('sha256:newest')
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const readImage = vi.fn(async (value: Parameters<AttachmentStore['readImage']>[0]) => ({ ref: value, data: png }))
    const readImageRequest = vi.fn(async (ref: Parameters<AttachmentStore['readImageRequest']>[0]) => ({
      attachment: ref, variantId: 'variant' as never, data: png, mediaType: 'image/png' as const,
      bytes: png.length, width: 1, height: 1, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
    }))
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage, readImageRequest } })

    const captured: any[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)))
      const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } }
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))
    }) as typeof fetch

    try {
      const options = {
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: [
          { role: 'user', content: [{ type: 'image', attachment: oldest }] },
          { role: 'user', content: [{ type: 'image', attachment: newest }] },
        ],
      } as unknown as GenerateOptions
      for await (const chunk of adapter.stream(options)) { void chunk }

      // Only the surviving image is read...
      expect(readImage).toHaveBeenCalledTimes(1)
      expect(readImage.mock.calls[0]?.[0]).toBe(newest)
      // ...the omitted one still tells the model an image existed...
      expect(captured[0].request.contents[0].parts[0].text).toContain('image omitted')
      // ...and the newest one still travels as inline bytes.
      expect(captured[0].request.contents[1].parts).toEqual([
        { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reuses one image resolution across every runtime-model candidate', async () => {
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'test-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const attachment = {
      attachmentId: 'sha256:0123456789abcdef',
      mediaType: 'image/png',
      bytes: png.length,
      width: 1,
      height: 1,
      name: 'shot.png',
    } as unknown as Parameters<AttachmentStore['readImage']>[0]
    const readImage = vi.fn(async () => ({ ref: attachment, data: png }))
    // The seam declares readImageRequest; this image is inside the edge ceiling.
    const readImageRequest = vi.fn(async (_ref: Parameters<AttachmentStore['readImageRequest']>[0],
      _target: Parameters<AttachmentStore['readImageRequest']>[1]) => ({ attachment, variantId: 'variant' as never, data: png,
      mediaType: 'image/png' as const, bytes: png.length, width: 1, height: 1,
      depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false }))
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage, readImageRequest } })

    const captured: any[] = []
    const originalFetch = globalThis.fetch
    let attempt = 0
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)))
      attempt += 1
      // Fail the first endpoint so the adapter walks its candidate chain. A
      // 429 no longer walks it: the chain ends at a rate limit, because a
      // verdict from one endpoint is not improved by asking another one.
      if (attempt === 1) return new Response('{"error":{"code":503,"message":"unavailable"}}', { status: 503 })
      const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } } }
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))
    }) as typeof fetch

    try {
      const options = {
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
      } as unknown as GenerateOptions
      for await (const chunk of adapter.stream(options)) { void chunk }

      expect(captured.length).toBeGreaterThan(1)
      expect(readImage).toHaveBeenCalledTimes(1)
      for (const body of captured) {
        expect(body.request.contents[0].parts).toEqual([
          { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } },
        ])
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns empty model list when disabled or enabledModelIds is empty', async () => {
    const store = new FileCredentialStore()
    const modelSettings = new FileModelSettingsStore()

    const disabledPrefs = {
      status: () => ({ enabled: false, enabledModelIds: ['gemini-3.8-flash'], catalogModels: [] }),
      update: vi.fn(),
    }
    const disabledAdapter = new AntigravityAdapter(store, modelSettings, disabledPrefs as never)
    expect(await disabledAdapter.listModels()).toEqual([])

    const emptyPrefs = {
      status: () => ({ enabled: true, enabledModelIds: [], catalogModels: [] }),
      update: vi.fn(),
    }
    const emptyAdapter = new AntigravityAdapter(store, modelSettings, emptyPrefs as never)
    expect(await emptyAdapter.listModels()).toEqual([])
  })
})
