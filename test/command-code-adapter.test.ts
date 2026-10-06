import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { BlockAssembler, createAssistantMessage, createToolResultMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CommandCodeAdapter, isCommandCodeCredentialInvalid, isCommandCodeModelAccessDenied, resolveZeroDataRetention } from '../src/host/command-code/adapter.ts'
import { CommandCodeAccountPool, parseCommandCodePoolData } from '../src/host/command-code/account-pool.ts'
import { FileCredentialStore, FileModelSettingsStore, type CommandCodeCredentials } from '../src/host/command-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/command-code/client.ts'
import { PROVIDER_URL } from './support/command-code-fixtures.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

const CATALOG = [
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 1_000_000, supportedEndpoints: ['/v1/responses'] },
]

class MemoryPoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

class MemoryCredentialBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function testKey(n: number, overrides: Partial<CommandCodeCredentials> = {}): CommandCodeCredentials {
  return {
    apiKey: `cmd-key-${n}`,
    userId: `user-${n}`,
    userName: `User ${n}`,
    email: `user${n}@example.com`,
    keyName: `laptop-${n}`,
    planLabel: 'GOAT',
    authenticatedAt: Date.now(),
    ...overrides,
  }
}

function createTestPool(initialKeys: CommandCodeCredentials[] = []): CommandCodeAccountPool {
  const mirrorBackend = new MemoryCredentialBackend()
  const mirrorStore = new FileCredentialStore(tmp('cc-mirror'), mirrorBackend as never)
  const poolBackend = new MemoryPoolBackend(parseCommandCodePoolData)
  const pool = new CommandCodeAccountPool({ store: mirrorStore, backend: poolBackend as never })
  for (const k of initialKeys) {
    void pool.addAccount(k)
  }
  return pool
}

function buildAdapter(
  overrides: {
    enabled?: boolean
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: 'low' | 'medium' | 'high' | 'max' | null
    zeroDataRetention?: boolean
  } = {},
  accountPool?: CommandCodeAccountPool,
) {
  const store = new FileCredentialStore(tmp('cc-cred'))
  const modelSettings = new FileModelSettingsStore(tmp('cc-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: overrides.enabled !== false,
    enabledModelIds: overrides.enabledModelIds ?? CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: overrides.contextWindowOverrides ?? {},
    defaultReasoningEffort: overrides.defaultReasoningEffort ?? null,
  })
  const adapter = new CommandCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => CATALOG,
    zeroDataRetention: overrides.zeroDataRetention,
  }, accountPool)
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

/** One model per wire, so a test names the vocabulary it exercises. */
const OPENAI_MODEL = 'deepseek/deepseek-v4.1-flash'
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const RESPONSES_MODEL = 'gpt-6-astra'

/**
 * One turn against a provider that answers 200 and then fails inside the
 * stream, returning the thrown error and the requests it actually issued.
 *
 * The request count is what tells classification from an internal retry: this
 * route never repeats a stream itself, the harness retry policy owns that, so
 * a transient in-band failure must still show exactly one request.
 */
async function failureOf(
  model: string,
  frames: unknown[],
  options: { headers?: Record<string, string>; pool?: CommandCodeAccountPool } = {},
): Promise<{ failure: unknown; calls: string[] }> {
  const { adapter, store } = buildAdapter({}, options.pool)
  vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    const bytes = new TextEncoder().encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    )
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream', ...(options.headers ?? {}) } })
  }) as typeof fetch
  try {
    for await (const _chunk of adapter.stream({
      provider: 'command-code', model, messages: [],
    } as unknown as GenerateOptions)) void _chunk
  } catch (error) {
    return { failure: error, calls }
  } finally {
    globalThis.fetch = originalFetch
  }
  throw new Error('expected the stream to fail')
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

describe('CommandCodeAdapter catalog', () => {
  it('recovers an overflowing Responses output budget without dropping its input', async () => {
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const originalFetch = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      bodies.push(body)
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message:
        "This model's maximum context length is 1048576 tokens. However, you requested 1120000 tokens (992000 in the messages, 128000 in the completion). Please reduce the length of the messages or completion.",
      } }), { status: 400 })
      return sseResponse([{ type: 'response.completed', response: { output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checkpoint' }] },
      ] } }])
    })
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code', model: 'gpt-6-astra', maxTokens: 128000, purpose: 'compaction',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize history' }] }],
      } as GenerateOptions)) assembler.push(chunk)
      expect(assembler.finish).toEqual({ kind: 'stop' })
      expect(bodies).toHaveLength(2)
      expect(bodies[1]!.max_output_tokens).toBe(55552)
      expect({ ...bodies[1], max_output_tokens: 128000 }).toEqual(bodies[0])
    } finally { globalThis.fetch = originalFetch }
  })

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
    // The registry declares `off`, which DSH spells `none`.
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low', 'high', 'max'])
  })

  it('keeps a genuinely text-only model on the text modality', async () => {
    const { adapter } = buildAdapter()
    const resolved = await adapter.resolveModel('command-code', 'deepseek/deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'high', 'max'])
  })

  it('offers a reasoning ladder for a fast variant the older table omitted', async () => {
    // Regression: deepseek/deepseek-v4.1-flash-fast served by the live catalog
    // was missing from the transcribed table, so it fell through to the
    // text-only/no-ladder default and the composer hid its effort selector.
    const { adapter } = buildAdapter()
    const resolved = await adapter.resolveModel('command-code', 'deepseek/deepseek-v4.1-flash-fast')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low', 'high', 'max'])
  })

  it('offers a reasoning ladder for the GPT-6 siblings the older table omitted', async () => {
    const { adapter } = buildAdapter()
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']) {
      const resolved = await adapter.resolveModel('command-code', model)
      expect(resolved.inputModalities).toEqual(['text', 'image'])
      expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }
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

      // The same history as harness 0.1.7 delivers it: the result is its own
      // `role: 'tool'` message, which the adapter normalizes before any mapper
      // reads it. Both generations must build the same body.
      const third = new BlockAssembler()
      for await (const chunk of adapter.stream({
        ...options,
        messages: [...options.messages, assistant, createToolResultMessage({
          callId: toolCall.id,
          content: [{ type: 'text', text: '1' }],
          isError: false,
        })],
      })) third.push(chunk)

      expect(third.blocks()).toEqual(second.blocks())
      expect(bodies[2]!.messages).toEqual(bodies[1]!.messages)
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

  it('returns empty model list when disabled or enabledModelIds is empty', async () => {
    const { adapter: disabledAdapter } = buildAdapter({ enabled: false, enabledModelIds: ['deepseek/deepseek-v4.1-flash'] })
    expect(await disabledAdapter.listModels()).toEqual([])

    const { adapter: emptyAdapter } = buildAdapter({ enabled: true, enabledModelIds: [] })
    expect(await emptyAdapter.listModels()).toEqual([])
  })
})

describe('CommandCodeAdapter ZDR routing and header enforcement', () => {
  it('attaches x-cmd-zdr: 1 on all wires when zeroDataRetention: true is configured', async () => {
    const { adapter, store } = buildAdapter({ zeroDataRetention: true })
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const captured: Array<{ url: string; headers: Record<string, string> }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url)
      captured.push({ url: urlStr, headers: (init?.headers ?? {}) as Record<string, string> })
      if (urlStr.includes('/messages')) {
        return sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ])
      }
      if (urlStr.includes('/responses')) {
        return sseResponse([
          { type: 'response.output_text.delta', delta: 'hi' },
          { type: 'response.completed', response: {} },
        ])
      }
      return sseResponse([
        { choices: [{ delta: { content: 'zdr ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      // 1. OpenAI wire (deepseek/deepseek-v4.1-flash)
      const resOpenAI = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) resOpenAI.push(chunk)
      expect(captured[0]!.url).toContain('/chat/completions')
      expect(captured[0]!.headers['x-cmd-zdr']).toBe('1')

      // 2. Anthropic wire (claude-sonnet-4-6)
      const resAnthropic = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) resAnthropic.push(chunk)
      expect(captured[1]!.url).toContain('/messages')
      expect(captured[1]!.headers['x-cmd-zdr']).toBe('1')

      // 3. Responses wire (gpt-6-astra)
      const resResponses = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) resResponses.push(chunk)
      expect(captured[2]!.url).toContain('/responses')
      expect(captured[2]!.headers['x-cmd-zdr']).toBe('1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('attaches x-cmd-zdr: 1 when DSH_COMMAND_CODE_ZDR=1 is set in host env', async () => {
    const prevEnv = process.env.DSH_COMMAND_CODE_ZDR
    process.env.DSH_COMMAND_CODE_ZDR = '1'
    const { adapter, store } = buildAdapter()
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const captured: Array<{ headers: Record<string, string> }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push({ headers: (init?.headers ?? {}) as Record<string, string> })
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) assembler.push(chunk)
      expect(captured[0]!.headers['x-cmd-zdr']).toBe('1')
    } finally {
      globalThis.fetch = originalFetch
      if (prevEnv === undefined) delete process.env.DSH_COMMAND_CODE_ZDR
      else process.env.DSH_COMMAND_CODE_ZDR = prevEnv
    }
  })

  it('overrides host env when zeroDataRetention: false is explicitly configured', async () => {
    const prevEnv = process.env.DSH_COMMAND_CODE_ZDR
    process.env.DSH_COMMAND_CODE_ZDR = '1'
    const { adapter, store } = buildAdapter({ zeroDataRetention: false })
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    const captured: Array<{ headers: Record<string, string> }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      captured.push({ headers: (init?.headers ?? {}) as Record<string, string> })
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) assembler.push(chunk)
      expect(captured[0]!.headers['x-cmd-zdr']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
      if (prevEnv === undefined) delete process.env.DSH_COMMAND_CODE_ZDR
      else process.env.DSH_COMMAND_CODE_ZDR = prevEnv
    }
  })

  it('fails closed immediately on 422 cmd_zdr_no_providers without retries or privacy downgrade', async () => {
    const { adapter, store } = buildAdapter({ zeroDataRetention: true })
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
    let attempts = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      attempts += 1
      return new Response(JSON.stringify({ error: 'cmd_zdr_no_providers', message: 'No ZDR-capable upstreams available' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({
          provider: 'command-code',
          model: 'deepseek/deepseek-v4.1-flash',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
        } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        failure: { status: 422 },
      })
      // Failed closed on the first attempt without retrying or falling back to non-ZDR
      expect(attempts).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('CommandCodeAdapter error classification and account rotation', () => {
  it('distinguishes model entitlement / permission denied and avoids whole-account rotation', async () => {
    const pool = createTestPool([testKey(1), testKey(2)])
    const { adapter } = buildAdapter({}, pool)
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ error: 'upgrade_required', message: 'Model requires higher plan' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({
          provider: 'command-code',
          model: 'claude-sonnet-4-6',
          messages: [],
        } as unknown as GenerateOptions)) void _chunk
      }).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        failure: { status: 403 },
      })
      // Only 1 attempt made: did NOT rotate to second account
      expect(fetchCalls).toBe(1)

      // The first account was NOT marked invalid
      const accounts = await pool.listAccounts()
      expect(accounts[0]!.authStatus).toBeUndefined()
      expect(accounts[1]!.authStatus).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks account invalid on actual credential rejection (401) and rotates to next account in pool', async () => {
    const pool = createTestPool([testKey(1), testKey(2)])
    const { adapter } = buildAdapter({}, pool)
    const capturedHeaders: Array<Record<string, string>> = []
    let call = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      call += 1
      capturedHeaders.push((init?.headers ?? {}) as Record<string, string>)
      if (call === 1) {
        return new Response(JSON.stringify({ error: 'invalid_api_key' }), { status: 401 })
      }
      return sseResponse([
        { choices: [{ delta: { content: 'recovered' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [],
      } as unknown as GenerateOptions)) assembler.push(chunk)

      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'recovered' }])
      expect(call).toBe(2)
      expect(capturedHeaders[0]!.authorization).toBe('Bearer cmd-key-1')
      expect(capturedHeaders[1]!.authorization).toBe('Bearer cmd-key-2')

      const accounts = await pool.listAccounts()
      expect(accounts[0]!.authStatus).toBe('invalid')
      expect(accounts[1]!.authStatus).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks cooldown on 429 and rotates to next account in pool', async () => {
    const pool = createTestPool([testKey(1), testKey(2)])
    const { adapter } = buildAdapter({}, pool)
    let call = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      call += 1
      if (call === 1) {
        return new Response('rate limit', { status: 429, headers: { 'retry-after': '60' } })
      }
      return sseResponse([
        { choices: [{ delta: { content: 'from-account-2' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch

    try {
      const assembler = new BlockAssembler()
      for await (const chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [],
      } as unknown as GenerateOptions)) assembler.push(chunk)

      expect(assembler.blocks()).toEqual([{ type: 'text', text: 'from-account-2' }])
      expect(call).toBe(2)

      const accounts = await pool.listAccounts()
      expect(accounts[0]!.cooldownUntil).toBeGreaterThan(Date.now())
      expect(accounts[1]!.cooldownUntil).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// In-band stream errors
// ---------------------------------------------------------------------------

describe('CommandCodeAdapter in-band stream errors', () => {
  const MESSAGE_START = { type: 'message_start', message: { usage: { input_tokens: 1 } } }


  it('reclassifies a transient in-band failure while nothing has reached the caller', async () => {
    // The shape that ended a real turn: HTTP 200, an open stream, then the
    // failure inside it. The same overload sent as a 529 is SERVER, so the
    // in-band copy must not be the one that ends the turn on the first try.
    const policy = buildAdapter().adapter.providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    for (const [model, frames, code, message] of [
      [
        ANTHROPIC_MODEL,
        [MESSAGE_START, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
        'SERVER',
        'Overloaded',
      ],
      [
        ANTHROPIC_MODEL,
        [MESSAGE_START, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } }],
        'SERVER',
        'Internal server error',
      ],
      [
        ANTHROPIC_MODEL,
        [MESSAGE_START, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }],
        'RATE_LIMIT',
        'Too many requests',
      ],
      [
        RESPONSES_MODEL,
        [{ type: 'response.failed', error: { code: 'server_error', message: 'Upstream unavailable' } }],
        'SERVER',
        'Upstream unavailable',
      ],
      [
        RESPONSES_MODEL,
        [{ type: 'response.failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } }],
        'RATE_LIMIT',
        'Rate limit reached',
      ],
      // A bare string error carries no code at all, so on this vocabulary the
      // message text is the only evidence that the failure was transient.
      [
        RESPONSES_MODEL,
        [{ type: 'error', error: 'Overloaded, try again later' }],
        'SERVER',
        'Overloaded, try again later',
      ],
    ] as const) {
      const { failure, calls } = await failureOf(model, [...frames])
      expect(failure).toMatchObject({ code })
      // Only the code changed: the provider's own diagnostic stays in the
      // message, and no status is invented for a response that really was a 200.
      expect((failure as Error).message).toContain(message)
      expect((failure as { failure?: { status?: number } }).failure?.status).toBeUndefined()
      // The mapper's verdict is kept as the cause, so nothing about the original
      // failure is lost.
      expect((failure as { cause?: { code?: string } }).cause?.code).toBe('PROVIDER_ERROR')
      expect(retryable).toContain(code)
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the mapper verdict once output has reached the caller', async () => {
    // A retry would repeat 'partial' for the user and could re-issue a tool call
    // the agent has already run.
    const messages = await failureOf(ANTHROPIC_MODEL, [
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ])
    expect(messages.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(messages.calls).toHaveLength(1)

    const responses = await failureOf(RESPONSES_MODEL, [
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', error: { code: 'server_error', message: 'Upstream unavailable' } },
    ])
    expect(responses.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(responses.calls).toHaveLength(1)
  })

  it('leaves a non-transient or unrecognized in-band type with the mapper verdict', async () => {
    // A type this vocabulary does not name, and one it names as final: neither
    // may be filed as a retryable server error, which is worse than not retrying.
    for (const type of ['invalid_request_error', 'authentication_error', 'request_too_large', 'some_future_error']) {
      const { failure, calls } = await failureOf(ANTHROPIC_MODEL, [
        MESSAGE_START,
        { type: 'error', error: { type, message: 'nope' } },
      ])
      expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
      expect(calls).toHaveLength(1)
    }

    const responses = await failureOf(RESPONSES_MODEL, [
      { type: 'response.failed', error: { code: 'invalid_prompt', message: 'bad prompt' } },
    ])
    expect(responses.failure).toMatchObject({ code: 'PROVIDER_ERROR' })

    // A context overflow is the mapper's own verdict on both wires and no
    // reclassification is owed to it: the request itself was refused.
    const overflow = await failureOf(ANTHROPIC_MODEL, [
      MESSAGE_START,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 300000 tokens > 200000 maximum',
        },
      },
    ])
    expect(overflow.failure).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('takes the account serving a spent window out of rotation', async () => {
    // The same reaction the non-2xx 429 branch reaches, through the same call
    // and the same fallback: a provider-stated delay wins, and the harness retry
    // that follows lands on an account this one did not spend.
    const pool = createTestPool([testKey(1), testKey(2)])
    const limited = await failureOf(
      ANTHROPIC_MODEL,
      [MESSAGE_START, { type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }],
      { pool, headers: { 'retry-after': '60' } },
    )
    expect(limited.failure).toMatchObject({ code: 'RATE_LIMIT' })
    // The rotation itself cannot happen from inside an open body, so the account
    // leaves the pool instead and the harness retry does the moving on.
    expect(limited.calls).toHaveLength(1)
    const limitedAccounts = await pool.listAccounts()
    expect(limitedAccounts[0]!.cooldownUntil).toBeGreaterThan(Date.now() + 30_000)
    expect(limitedAccounts[1]!.cooldownUntil).toBeUndefined()

    // An overload is shared by every account behind the gateway, so this route
    // has no rule that spreads it across the pool and none is invented here.
    const overloadedPool = createTestPool([testKey(1), testKey(2)])
    const overloaded = await failureOf(
      ANTHROPIC_MODEL,
      [MESSAGE_START, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
      { pool: overloadedPool },
    )
    expect(overloaded.failure).toMatchObject({ code: 'SERVER' })
    const untouched = await overloadedPool.listAccounts()
    expect(untouched[0]!.cooldownUntil).toBeUndefined()
    expect(untouched[1]!.cooldownUntil).toBeUndefined()
  })
})

describe('CommandCodeAdapter in-band stream errors on the other two wires', () => {
  /** The body this route's own upstream documents for a 502, delivered in band. */
  const UPSTREAM_UNAVAILABLE = {
    error: {
      message: 'Upstream model provider is temporarily unavailable. Please try again in a moment.',
      type: 'server_error',
    },
  }
  /** A `failed` response is an in-band failure inside a success-shaped event. */
  const completedButFailed = (error: unknown): unknown[] => [
    { type: 'response.completed', response: { status: 'failed', error } },
  ]

  it('reclassifies a chat-completions in-band failure before any output', async () => {
    // The 502 body this route already classifies, arriving inside a 200 instead.
    // Nothing in its message reads transient - it says 'temporarily', not 'server
    // error' - so only the `type` the envelope uses instead of a code recognizes it.
    const policy = buildAdapter().adapter.providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    for (const [frames, code] of [
      [[UPSTREAM_UNAVAILABLE], 'SERVER'],
      [[{ error: { message: 'Rate limit reached for requests', code: 'rate_limit' } }], 'RATE_LIMIT'],
      // No structured evidence at all: on this vocabulary the prose is the signal.
      [[{ error: { message: 'The model is overloaded, try again shortly' } }], 'SERVER'],
    ] as const) {
      const { failure, calls } = await failureOf(OPENAI_MODEL, [...frames])
      expect(failure).toMatchObject({ code })
      expect(retryable).toContain(code)
      expect((failure as { failure?: { status?: number } }).failure?.status).toBeUndefined()
      expect((failure as { cause?: { code?: string } }).cause?.code).toBe('PROVIDER_ERROR')
      expect(calls).toHaveLength(1)
    }
  })

  it('reclassifies a failed response.completed before any output', async () => {
    const policy = buildAdapter().adapter.providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    for (const [error, code] of [
      [{ code: 'server_error', message: 'Upstream unavailable' }, 'SERVER'],
      [{ code: 'rate_limit_exceeded', message: 'Rate limit reached' }, 'RATE_LIMIT'],
    ] as const) {
      const { failure, calls } = await failureOf(RESPONSES_MODEL, completedButFailed(error))
      expect(failure).toMatchObject({ code })
      expect(retryable).toContain(code)
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps both mapper verdicts once output has reached the caller', async () => {
    const openAI = await failureOf(OPENAI_MODEL, [
      { choices: [{ delta: { content: 'partial' } }] },
      UPSTREAM_UNAVAILABLE,
    ])
    expect(openAI.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(openAI.calls).toHaveLength(1)

    const responses = await failureOf(RESPONSES_MODEL, [
      { type: 'response.output_text.delta', delta: 'partial' },
      ...completedButFailed({ code: 'server_error', message: 'Upstream unavailable' }),
    ])
    expect(responses.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(responses.calls).toHaveLength(1)
  })

  it('leaves an unrecognized in-band failure with the mapper verdict', async () => {
    const openAI = await failureOf(OPENAI_MODEL, [{ error: { message: 'nope', type: 'invalid_request' } }])
    expect(openAI.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(openAI.calls).toHaveLength(1)

    const responses = await failureOf(RESPONSES_MODEL, completedButFailed({ code: 'invalid_prompt', message: 'bad prompt' }))
    expect(responses.failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(responses.calls).toHaveLength(1)
  })

  it('keeps a context overflow an overflow even when the body reads transiently', async () => {
    // The mapper types an overflow CONTEXT_WINDOW_EXCEEDED, which is a verdict
    // about the request rather than about the server, and no retry fixes it. A
    // body carrying BOTH a transient `type` and an overflow message must not be
    // reclassified into a retryable server error, or the bounded policy would
    // spend three attempts on a request that cannot succeed.
    const openAI = await failureOf(OPENAI_MODEL, [{
      error: {
        type: 'server_error',
        message: 'prompt is too long: 300000 tokens > 200000 maximum',
      },
    }])
    expect(openAI.failure).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })

    // The same body on the messages wire, where the transient `type` IS a status.
    const messages = await failureOf(ANTHROPIC_MODEL, [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      {
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'prompt is too long: 300000 tokens > 200000 maximum',
        },
      },
    ])
    expect(messages.failure).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  })

  it('cools down the account an in-band rate limit spends on either wire', async () => {
    // Both new sites reach the same cooldown arm, so the pool reaction is proven
    // once per vocabulary rather than assumed from the messages wire.
    for (const [model, frames] of [
      [OPENAI_MODEL, [{ error: { message: 'Rate limit reached for requests', code: 'rate_limit' } }]],
      [RESPONSES_MODEL, completedButFailed({ code: 'rate_limit_exceeded', message: 'Rate limit reached' })],
    ] as const) {
      const pool = createTestPool([testKey(1), testKey(2)])
      const { failure, calls } = await failureOf(model, [...frames], { pool, headers: { 'retry-after': '60' } })
      expect(failure).toMatchObject({ code: 'RATE_LIMIT' })
      expect(calls).toHaveLength(1)
      const accounts = await pool.listAccounts()
      expect(accounts[0]!.cooldownUntil).toBeGreaterThan(Date.now() + 30_000)
      expect(accounts[1]!.cooldownUntil).toBeUndefined()
    }
  })
})
