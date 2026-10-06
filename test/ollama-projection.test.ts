import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildBody } from '../src/host/ollama/client.ts'
import { OllamaAdapter, toOllamaRequest } from '../src/host/ollama/adapter.ts'
import { FORCED_THINKING_FLOOR_TOKENS } from '../src/host/ollama/types.ts'
import { applyEvent, closeStream, createStreamState } from '../src/host/ollama/mapper.ts'

function options(overrides: Record<string, unknown> = {}): never {
  return {
    provider: 'ollama',
    model: 'gpt-oss:120b',
    messages: [],
    ...overrides,
  } as never
}

/** A real one-pixel PNG, the way DSH stores an attachment. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const ATTACHMENT = {
  attachmentId: 'sha256:shot',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
} as unknown as ImageAttachmentRef

/** The shape DSH actually builds for a user turn carrying a screenshot. */
function imageTurn(): never {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', attachment: ATTACHMENT },
    ],
  } as never
}

const store = { readImage: async () => ({ ref: ATTACHMENT, data: PNG }) }

describe('ollama request projection', () => {
  it('sends a one-shot system prompt that lives outside the history', async () => {
    const request = await toOllamaRequest(options({ system: 'be terse' }))

    expect(request.messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('deduplicates a system prompt that the history also carries', async () => {
    const request = await toOllamaRequest(options({
      system: 'be terse',
      messages: [{ role: 'system', content: 'be terse' }],
    }))

    expect(request.messages.filter(message => message.role === 'system')).toHaveLength(1)
  })

  it('keeps distinct system prompts that the history also carries', async () => {
    const request = await toOllamaRequest(options({
      system: 'be terse',
      messages: [{ role: 'system', content: 'format as markdown' }],
    }))

    expect(request.messages.filter(message => message.role === 'system')).toHaveLength(2)
  })

  it('reads a durable attachment instead of dropping the image on vision models', async () => {
    // The shape under test is the one DSH produces: a reference, not bytes.
    const request = await toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }), store)

    expect(request.messages[0]!.images).toEqual([`data:image/png;base64,${PNG_BASE64}`])

    const native = buildBody('native', { model: 'llama3.2-vision', messages: request.messages }) as {
      messages: Array<{ images?: string[] }>
    }
    // Native wire receives bare base64
    expect(native.messages[0]!.images).toEqual([PNG_BASE64])

    const openai = buildBody('openai', { model: 'llama3.2-vision', messages: request.messages }) as {
      messages: Array<{ content: unknown }>
    }
    // OpenAI wire receives data URL
    expect(openai.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })

  it('preserves text with explicit unavailable marker when attachment cannot be read', async () => {
    // Without a store the bytes are unavailable, but the text must survive with an explicit marker
    const request = await toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }))

    expect(request.messages[0]!.content).toContain('what is this')
    expect(request.messages[0]!.content).toContain('[image unavailable: sha256:shot could not be read; ask the user to attach it again if the image is needed]')
    expect(request.messages[0]!.images).toBeUndefined()
  })

  it('preserves text with explicit unavailable marker when readImage throws non-abort error', async () => {
    const failingStore = {
      readImage: async () => {
        throw new Error('attachment file missing on disk')
      },
    }
    const request = await toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }), failingStore)

    expect(request.messages[0]!.content).toContain('what is this')
    expect(request.messages[0]!.content).toContain('[image unavailable: sha256:shot could not be read; ask the user to attach it again if the image is needed]')
    expect(request.messages[0]!.images).toBeUndefined()
  })

  it('propagates abort error during attachment read', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('aborted by caller', 'AbortError'))

    await expect(toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }), store, controller.signal))
      .rejects.toThrow(/abort/i)
  })

  it('propagates custom abort reason when aborted during awaited read', async () => {
    const controller = new AbortController()
    const customReason = new Error('custom user cancellation during read')
    const delayedStore = {
      readImage: async () => {
        controller.abort(customReason)
        return { ref: ATTACHMENT, data: PNG }
      },
    }
    await expect(toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }), delayedStore, controller.signal))
      .rejects.toThrow('custom user cancellation during read')
  })

  it('marks malformed image carrying neither ref nor data with unavailable marker', async () => {
    const malformedTurn = {
      role: 'user',
      content: [
        { type: 'text', text: 'broken image' },
        { type: 'image' },
      ],
    }
    const request = await toOllamaRequest(options({ model: 'llama3.2-vision', messages: [malformedTurn] }), store)
    expect(request.messages[0]!.content).toContain('broken image')
    expect(request.messages[0]!.content).toContain('[image unavailable: the image could not be read; ask the user to attach it again if the image is needed]')
    expect(request.messages[0]!.images).toBeUndefined()
  })

  it('marks image as unsupported with explicit marker on non-image models', async () => {
    const request = await toOllamaRequest(options({ model: 'llama3:8b', messages: [imageTurn()] }), store)

    expect(request.messages[0]!.content).toContain('what is this')
    expect(request.messages[0]!.content).toContain('[image unsupported: sha256:shot: model llama3:8b is not known to declare image support; remove the attachment or switch to a vision model]')
    expect(request.messages[0]!.images).toBeUndefined()
  })

  it('projects tool result with image in canonical vocabulary (Shape A)', async () => {
    const canonicalToolMessage = {
      role: 'user',
      source: { kind: 'tool', callId: 'call_1' },
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'result text' },
            { type: 'image', attachment: ATTACHMENT },
          ],
        },
      ],
    }

    const request = await toOllamaRequest(options({ model: 'llama3.2-vision', messages: [canonicalToolMessage] }), store)

    expect(request.messages[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'result text',
      images: [`data:image/png;base64,${PNG_BASE64}`],
    })
  })

  it('normalizes 0.1.7 tool result through normalizeGenerateOptions boundary', async () => {
    const unnormalizedOptions = {
      provider: 'ollama',
      model: 'llama3.2-vision',
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'tool completed' },
            { type: 'image', attachment: ATTACHMENT },
          ],
        },
      ],
    }

    const normalized = normalizeGenerateOptions(unnormalizedOptions as never)
    const request = await toOllamaRequest(normalized, store)

    expect(request.messages[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'tool completed',
      images: [`data:image/png;base64,${PNG_BASE64}`],
    })
  })

  it('maps thinking model-specifically per Ollama docs (gpt-oss levels, boolean models, unsupported omit)', async () => {
    // gpt-oss levels: only low, medium, high are valid; none and xhigh are omitted
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b' }))).think).toBeUndefined()
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', reasoningEffort: 'high' }))).think).toBe('high')
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', reasoningEffort: 'low' }))).think).toBe('low')
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', reasoningEffort: 'none' }))).think).toBeUndefined()
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', reasoningEffort: 'xhigh' }))).think).toBeUndefined()

    // boolean-only models: deepseek-r1, qwq, qwen3
    expect((await toOllamaRequest(options({ model: 'deepseek-r1:70b', reasoningEffort: 'high' }))).think).toBe(true)
    expect((await toOllamaRequest(options({ model: 'deepseek-r1:70b', reasoningEffort: 'none' }))).think).toBe(false)
    expect((await toOllamaRequest(options({ model: 'qwq:32b', reasoningEffort: 'low' }))).think).toBe(true)
    expect((await toOllamaRequest(options({ model: 'qwen3:8b', reasoningEffort: 'medium' }))).think).toBe(true)

    // unsupported models: llama3, gemma, etc.
    expect((await toOllamaRequest(options({ model: 'llama3:8b', reasoningEffort: 'high' }))).think).toBeUndefined()
    expect((await toOllamaRequest(options({ model: 'gemma4:31b', reasoningEffort: 'high' }))).think).toBeUndefined()
  })

  it('floors a cap too small for a forced-thinking model (gpt-oss)', async () => {
    // The session-title call asks for one short line with maxTokens: 64. A model
    // whose thinking cannot be turned off spends that cap on reasoning and
    // answers with no text at all, which Harness reports as a truncated stream.
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', maxTokens: 64 }))).maxOutputTokens)
      .toBe(FORCED_THINKING_FLOOR_TOKENS)
    // An absent cap is DEFAULT_MAX_OUTPUT_TOKENS, which nothing is short of.
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b' }))).maxOutputTokens).toBeUndefined()
    // A cap the caller stated above the floor is the caller's number.
    expect((await toOllamaRequest(options({ model: 'gpt-oss:120b', maxTokens: 8192 }))).maxOutputTokens).toBe(8192)
    // A model whose thinking CAN be turned off keeps every cap exactly: raising
    // one would not enable thinking, and the number read back would be a lie.
    expect((await toOllamaRequest(options({ model: 'deepseek-r1:70b', maxTokens: 64 }))).maxOutputTokens).toBe(64)
    expect((await toOllamaRequest(options({ model: 'llama3:8b', maxTokens: 64 }))).maxOutputTokens).toBe(64)
  })
})

describe('ollama thinking stream', () => {
  it('keeps the trace and the answer in separate blocks', () => {
    const state = createStreamState()
    const out = [
      ...applyEvent(state, { type: 'thinking', text: 'first I look' }),
      ...applyEvent(state, { type: 'thinking', text: ' then answer' }),
      ...applyEvent(state, { type: 'text', text: 'done' }),
      ...closeStream(state),
    ]

    const kinds = out.filter(chunk => chunk.type === 'block-start').map(chunk => (chunk as { blockType: string }).blockType)
    expect(kinds).toEqual(['reasoning', 'text'])
    const ends = out.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { text: string } }).block.text)
    expect(ends).toEqual(['first I look then answer', 'done'])
  })
})

describe('OllamaAdapter adapter-level capabilities and streaming', () => {
  function makeAdapter(fetchFn?: typeof fetch, catalog = ['llama3.2-vision:11b', 'gpt-oss:120b', 'deepseek-r1:70b']) {
    const settings = {
      enabled: true,
      enabledModelIds: [],
      catalogModels: catalog.map(id => ({ id })),
      defaultReasoningEffort: null,
    }
    const store = {
      read: vi.fn(async () => ({ apiKey: 'sk-test' })),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const modelSettings = {
      read: vi.fn(async () => settings),
      status: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      storeCatalog: vi.fn(async () => settings),
    }
    return new OllamaAdapter(store as never, modelSettings as never, {
      fetchFn: fetchFn ?? fetch,
      loadCatalog: async () => catalog.map(id => ({ id })),
      attachments: store as never,
    })
  }

  it('resolves image modalities true for vision models and false for non-vision models', async () => {
    const adapter = makeAdapter()

    const vision = await adapter.resolveModel('ollama', 'llama3.2-vision:11b')
    expect(vision.inputModalities).toEqual(['text', 'image'])

    const nonVision = await adapter.resolveModel('ollama', 'gpt-oss:120b')
    expect(nonVision.inputModalities).toEqual(['text'])

    const unknown = await adapter.resolveModel('ollama', 'unknown-model:8b')
    expect(unknown.inputModalities).toEqual(['text'])
  })

  it('normalizes role tool across both generations in adapter.stream', async () => {
    interface BodyShape {
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
    }
    const capturedBodies: BodyShape[] = []
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string) as BodyShape)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n'))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    const adapter = makeAdapter(mockFetch)

    // Generation 1: 0.1.7 unnormalized Shape B (role: 'tool')
    const shapeBOptions = {
      provider: 'ollama',
      model: 'gpt-oss:120b',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call_1', content: 'tool text' },
      ],
    }
    const chunksB = []
    for await (const chunk of adapter.stream(shapeBOptions as never)) {
      chunksB.push(chunk)
    }
    expect(capturedBodies[0]?.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true)

    // Generation 2: Pre-0.1.7 canonical Shape A (user message holding tool-result block)
    const shapeAOptions = {
      provider: 'ollama',
      model: 'gpt-oss:120b',
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'read', arguments: '{}' }] },
        {
          role: 'user',
          source: { kind: 'tool', callId: 'call_2' },
          content: [{ type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'result text' }] }],
        },
      ],
    }
    const chunksA = []
    for await (const chunk of adapter.stream(shapeAOptions as never)) {
      chunksA.push(chunk)
    }
    expect(capturedBodies[1]?.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_2')).toBe(true)
  })

  it('propagates custom abort reason through attachment read and stream', async () => {
    const customReason = new Error('custom user cancellation')
    const controller = new AbortController()
    controller.abort(customReason)

    await expect(toOllamaRequest(options({ model: 'llama3.2-vision', messages: [imageTurn()] }), store, controller.signal))
      .rejects.toThrow('custom user cancellation')

    const adapter = makeAdapter()
    const iter = adapter.stream({ provider: 'ollama', model: 'gpt-oss:120b', messages: [], signal: controller.signal } as never)
    await expect(async () => {
      for await (const _ of iter) {}
    }).rejects.toThrow()
  })
})
// ---------------------------------------------------------------------------
// In-band stream errors
// ---------------------------------------------------------------------------

describe('ollama in-band stream errors', () => {
  interface ChunkLike {
    type: string
    text?: string
  }

  /** A pool double whose eligibility is a pure function of the tried set. */
  class FakePool {
    readonly cooldowns: Array<{ id: string; ms: number; reason: string }> = []
    readonly authFailures: Array<{ id: string; reason: string }> = []
    picks = 0

    private readonly accounts = [{ id: 'acc_primary' }, { id: 'acc_second' }]

    async getEffectiveCredential(excludeIds?: ReadonlySet<string>) {
      const account = this.accounts.find((candidate) => !excludeIds?.has(candidate.id))
      if (account === undefined) throw new Error('no eligible account')
      this.picks += 1
      return { account, credentials: { apiKey: 'sk-' + account.id } }
    }

    async hasAnotherAvailableAccount(tried: ReadonlySet<string>): Promise<boolean> {
      return this.accounts.some((account) => !tried.has(account.id))
    }

    async markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
      this.cooldowns.push({ id: accountId, ms: durationMs, reason })
    }

    async markAuthFailed(accountId: string, reason: string): Promise<void> {
      this.authFailures.push({ id: accountId, reason })
    }

    async recordUsage(): Promise<void> {}
  }

  const settings = {
    enabled: true,
    enabledModelIds: [],
    catalogModels: [{ id: 'gpt-oss:120b' }],
    defaultReasoningEffort: null,
  }

  /**
   * An adapter whose every request answers 200 and then says what it wanted to
   * say, the way Ollama reports a failure inside a successful stream.
   */
  function adapterFor(frames: unknown[], calls: string[], pool?: FakePool): OllamaAdapter {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(
        frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    const store = {
      read: vi.fn(async () => ({ apiKey: 'sk-test' })),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const modelSettings = {
      read: vi.fn(async () => settings),
      status: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      storeCatalog: vi.fn(async () => settings),
    }
    return new OllamaAdapter(store as never, modelSettings as never, {
      fetchFn,
      loadCatalog: async () => [{ id: 'gpt-oss:120b' }],
    }, pool as never)
  }

  /** Drain one turn, keeping both what the caller saw and what ended it. */
  async function run(adapter: OllamaAdapter): Promise<{ chunks: ChunkLike[]; failure: unknown }> {
    const chunks: ChunkLike[] = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'ollama',
        model: 'gpt-oss:120b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      } as never)) {
        chunks.push(chunk as ChunkLike)
      }
    } catch (error) {
      return { chunks, failure: error }
    }
    throw new Error('expected the stream to fail')
  }

  it('retypes a transient in-band failure while nothing has reached the caller', async () => {
    // The shape that ends a real turn: HTTP 200, then an {"error": "..."} frame.
    // Each of these arrives as a 5xx or a 429 when it is reported any other way,
    // and that copy is already retried - so the in-band copy must not be the one
    // that ends the turn on the first try.
    const policy = new OllamaAdapter().providerRetryPolicy()
    const retryable = policy.mode === 'normal' ? policy.retryableCodes : []
    for (const [message, code] of [
      ['loading model llama3.2-vision:11b', 'SERVER'],
      ['server busy', 'SERVER'],
      ['model is overloaded, please retry', 'SERVER'],
      ['unable to load the runner', 'SERVER'],
      ['rate limit exceeded', 'RATE_LIMIT'],
      ['too many requests', 'RATE_LIMIT'],
    ] as const) {
      const calls: string[] = []
      const { failure } = await run(adapterFor([{ error: message }], calls))
      expect(failure).toMatchObject({ code })
      // Ollama's own diagnostic stays in the message, so the notice still says
      // what happened rather than becoming a bare code.
      expect((failure as Error).message).toContain(message)
      expect(retryable).toContain(code)
      // Classified, not re-requested inside the stream: the harness retry policy
      // owns the repeat.
      expect(calls).toHaveLength(1)
    }
  })

  it('keeps the non-retryable verdict once output has reached the caller', async () => {
    // A retry would repeat 'partial' for the user and could re-run a tool call,
    // so the verdict the adapter reaches on its own still stands here.
    const calls: string[] = []
    const { chunks, failure } = await run(adapterFor([
      { choices: [{ delta: { content: 'partial' } }] },
      { error: 'server busy' },
    ], calls))
    expect(failure).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text)).toEqual(['partial'])
    expect(calls).toHaveLength(1)
  })

  it('leaves a refusal the wording does not name with the adapter verdict', async () => {
    // The caller's message is what the service objected to in every one of these;
    // retrying repeats it verbatim, so guessing here would cost backoff and
    // report the wrong fault.
    for (const message of [
      'invalid request: temperature must be <= 2',
      'registry.ollama.ai/library/llama3:8b not found',
      'the input length (200000 tokens) exceeds the context length (131072 tokens)',
    ]) {
      const calls: string[] = []
      const { failure } = await run(adapterFor([{ error: message }], calls))
      expect(failure).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(calls).toHaveLength(1)
    }
  })

  it('leaves the pool alone for an in-band failure, because none was reported', async () => {
    // Rotation and cooldown here are statements about an ACCOUNT, and an in-band
    // event carries no status to make one with. Cooling the key down or rotating
    // off it would be a guess dressed as a verdict - and the second key would
    // fail the same way - so the harness retry policy owns the repeat instead.
    const pool = new FakePool()
    const calls: string[] = []
    const { failure } = await run(adapterFor([{ error: 'rate limit exceeded' }], calls, pool))
    expect(failure).toMatchObject({ code: 'RATE_LIMIT' })
    expect(pool.picks).toBe(1)
    expect(pool.cooldowns).toEqual([])
    expect(pool.authFailures).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('keeps the verdict a non-2xx status already gave it', async () => {
    // The same wording inside a body that arrived with a 500 is not in-band
    // evidence: the status already answered, and the verdict it produced is the
    // one this line has always returned here.
    const fetchFn = vi.fn(async () => new Response('{"error":"rate limit exceeded"}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const store = {
      read: vi.fn(async () => ({ apiKey: 'sk-test' })),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    }
    const modelSettings = {
      read: vi.fn(async () => settings),
      status: vi.fn(() => settings),
      update: vi.fn(async () => settings),
      storeCatalog: vi.fn(async () => settings),
    }
    const adapter = new OllamaAdapter(store as never, modelSettings as never, { fetchFn })

    const { failure } = await run(adapter)
    expect(failure).toMatchObject({ code: 'SERVER', failure: { status: 500 } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
