import { describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildBody } from '../src/host/ollama/client.ts'
import { OllamaAdapter, toOllamaRequest } from '../src/host/ollama/adapter.ts'
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