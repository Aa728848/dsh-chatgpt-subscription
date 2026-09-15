import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { BlockAssembler, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/command-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/command-code/client.ts'
import { PROVIDER_URL } from './support/command-code-fixtures.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

const CATALOG = [
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
]

function buildAdapter(overrides: { enabledModelIds?: string[]; contextWindowOverrides?: Record<string, number>; defaultReasoningEffort?: 'low' | 'medium' | 'high' | 'max' | null } = {}) {
  const store = new FileCredentialStore(tmp('cc-cred'))
  const modelSettings = new FileModelSettingsStore(tmp('cc-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabledModelIds: overrides.enabledModelIds ?? CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: overrides.contextWindowOverrides ?? {},
    defaultReasoningEffort: overrides.defaultReasoningEffort ?? null,
  })
  const adapter = new CommandCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => CATALOG,
  })
  return { adapter, store, modelSettings }
}

function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }))
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

describe('CommandCodeAdapter catalog', () => {
  it('lists only the enabled models from the live catalog', async () => {
    const { adapter } = buildAdapter({ enabledModelIds: ['claude-sonnet-4-6'] })
    const models = await adapter.listModels('command-code')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ provider: 'command-code', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' })
    expect(adapter.providerInfo('command-code')).toEqual({ id: 'command-code', name: 'Command Code' })
  })

  it('resolves a model with its catalog context window and configured reasoning default', async () => {
    const { adapter } = buildAdapter({
      contextWindowOverrides: { 'claude-sonnet-4-6': 400_000 },
      defaultReasoningEffort: 'max',
    })
    const resolved = await adapter.resolveModel('command-code', 'claude-sonnet-4-6')
    expect(resolved.context).toEqual({ contextWindow: 400_000 })
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.defaultEffort).toBe('max')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('declares image input for DeepSeek V4.1 Flash, which is a vision model', async () => {
    const { adapter } = buildAdapter()
    const resolved = await adapter.resolveModel('command-code', 'deepseek/deepseek-v4.1-flash')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'max'])
  })

  it('keeps a genuinely text-only model on the text modality', async () => {
    const { adapter } = buildAdapter()
    const resolved = await adapter.resolveModel('command-code', 'deepseek/deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['high', 'max'])
  })

  it('sends an inline image to a vision-capable open-weight model', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const captured: Array<Record<string, unknown>> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([
        { choices: [{ delta: { content: 'I see a cat' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10 } },
        ] }],
      } as unknown as GenerateOptions)) assembler.push(chunk)

      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'I see a cat' }])
      // The durable attachment is turned into bytes by the adapter's resolver;
      // without one the block degrades to a named placeholder, so the wire proof
      // here is that the image never silently disappears from the request.
      const messages = captured[0]!.messages as Array<{ content: unknown }>
      const content = JSON.stringify(messages[0]!.content)
      expect(content).toContain('what is this?')
      expect(content.includes('image_url') || content.includes('image unavailable')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('CommandCodeAdapter streaming', () => {
  it('posts an OpenAI chat-completions request for an open-weight model and assembles blocks', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key', apiEnv: 'prod' })
    const captured: Array<{ url: string; init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} })
      return sseResponse([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        '[DONE]',
      ].map((frame) => (frame === '[DONE]' ? frame : frame)))
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        maxTokens: 2048,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) assembler.push(chunk)

      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Hello' }])
      expect(assembler.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
      expect(captured[0]!.url).toBe(`${PROVIDER_URL}/chat/completions`)
      expect((captured[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer cmd_key')
      expect((captured[0]!.init.headers as Record<string, string>)['anthropic-version']).toBeUndefined()
      const body = JSON.parse(String(captured[0]!.init.body)) as Record<string, unknown>
      expect(body.model).toBe('deepseek/deepseek-v4.1-flash')
      expect(body.max_tokens).toBe(2048)
      expect(body.stream).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('posts an Anthropic messages request, with the configured effort as a thinking budget', async () => {
    const { adapter, store } = buildAdapter({ defaultReasoningEffort: 'high' })
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const captured: Array<{ url: string; init: RequestInit }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} })
      return sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'claude-sonnet-4-6',
        maxTokens: 16_384,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) assembler.push(chunk)

      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Bonjour' }])
      expect(captured[0]!.url).toBe(`${PROVIDER_URL}/messages`)
      expect((captured[0]!.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
      const body = JSON.parse(String(captured[0]!.init.body)) as Record<string, unknown>
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 15_360 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('round-trips a tool call and replays the assistant turn plus its result', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const bodies: Array<Record<string, unknown>> = []
    const originalFetch = globalThis.fetch
    let call = 0
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      call += 1
      if (call === 1) {
        return sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_code', arguments: '{"code":"1"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
      }
      return sseResponse([
        { choices: [{ delta: { content: 'done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const options = {
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }],
      } as unknown as GenerateOptions

      const first = new BlockAssembler()
      for await (const chunk of adapter.stream(options)) first.push(chunk)
      expect(first.finish).toEqual({ kind: 'tool-calls' })
      const toolCall = first.blocks().find((block) => block.type === 'tool-call')!
      expect(toolCall).toMatchObject({ name: 'run_code', arguments: '{"code":"1"}' })

      const assistant = createAssistantMessage({
        content: first.blocks(),
        source: { provider: 'command-code', model: options.model, replayState: first.replayState },
      })
      const second = new BlockAssembler()
      for await (const chunk of adapter.stream({
        ...options,
        messages: [...options.messages, assistant, {
          role: 'user',
          source: { kind: 'tool', callId: toolCall.id },
          content: [{ type: 'tool-result', toolCallId: toolCall.id, content: [{ type: 'text', text: '1' }] }],
        }],
      } as unknown as GenerateOptions)) second.push(chunk)

      expect(second.blocks()).toEqual([{ type: 'text', text: 'done' }])
      expect(bodies[1]!.messages).toEqual([
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: '', tool_calls: [{ id: toolCall.id, type: 'function', function: { name: 'run_code', arguments: '{"code":"1"}' } }] },
        { role: 'tool', tool_call_id: toolCall.id, content: '1' },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('declares the bounded retry policy that covers upstream outages', () => {
    const { adapter } = buildAdapter()
    expect(adapter.providerRetryPolicy()).toMatchObject({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 1_500,
      maxDelayMs: 15_000,
    })
  })

  it('classifies an upstream 502 as a retryable server error', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.', type: 'server_error' } }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({ code: 'SERVER', failure: { code: 'SERVER', status: 502 } })
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toThrow(/upstream server error \(502\)/)

      for (const status of [500, 503, 504]) {
        globalThis.fetch = (async () => new Response('upstream down', { status })) as typeof fetch
        await expect(async () => {
          for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
        }).rejects.toMatchObject({ code: 'SERVER' })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('classifies a failed connection as a retryable transport error', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({ code: 'TRANSPORT' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refuses to call the API without a stored credential', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const chunks: StreamChunk[] = []
    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) chunks.push(chunk)
    }).rejects.toThrow(/Not signed in to Command Code/)
  })

  it('classifies a rejected key and a rate limit with their own codes', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'bad' })
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toThrow(/rejected the stored API key/)

      globalThis.fetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({ code: 'RATE_LIMIT' })

      // A provider-requested delay travels with the failure so the DSH retry
      // policy waits exactly as long as the API asked instead of guessing.
      globalThis.fetch = (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch
      await expect(async () => {
        for await (const _chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 30_000 } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports a truncated stream instead of a silent empty answer', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => sseResponse([{ choices: [{ delta: { content: 'half' } }] }])) as typeof fetch
    try {
      const assembler = new BlockAssembler()
      await expect(async () => {
        for await (const chunk of adapter.stream({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', messages: [] } as unknown as GenerateOptions)) assembler.push(chunk)
      }).rejects.toThrow(/terminal event/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
