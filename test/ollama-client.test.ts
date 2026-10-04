import { describe, expect, it, vi } from 'vitest'
import { buildBody, chatUrl, fetchCatalog, loadCatalog, startChat, headersFor } from '../src/host/ollama/client.ts'
import { applyEvent, closeStream, createStreamState } from '../src/host/ollama/mapper.ts'
import { CLOUD_BASE_URL, NATIVE_CHAT_PATH, OPENAI_CHAT_PATH, PROVIDER_ID } from '../src/host/ollama/types.ts'
import { parseOllamaCredentials } from '../src/host/ollama/token-store.ts'

const key = { apiKey: 'sk-test' }

function sseResponse(lines: string[]): Response {
  const body = lines.map(line => `data: ${line}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('Ollama request bodies', () => {
  it('sends a Bearer key, as the API requires', () => {
    const headers = headersFor(key, 'application/json')
    expect(headers.authorization).toBe('Bearer sk-test')
  })

  it('pairs a tool result with its call id on the OpenAI surface', () => {
    const body = buildBody('openai', {
      model: 'gpt-oss:120b-cloud',
      messages: [
        { role: 'user', content: 'read a file' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }] },
        { role: 'tool', content: 'contents', toolCallId: 'call_1' },
      ],
    }) as { messages: Record<string, unknown>[] }

    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'contents' })
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
    })
  })

  it('uses each surface own tool-result shape on the native route', () => {
    // The native API takes no tool_call_id, so sending one would be a field it does
    // not document. This is the difference the two builders exist for.
    const body = buildBody('native', {
      model: 'gpt-oss:120b-cloud',
      messages: [{ role: 'tool', content: 'contents', toolCallId: 'call_1' }],
    }) as { messages: Record<string, unknown>[]; options: Record<string, unknown> }

    expect(body.messages[0]).toEqual({ role: 'tool', content: 'contents' })
    expect(body.messages[0]).not.toHaveProperty('tool_call_id')
    expect(body.options).toHaveProperty('num_predict')
  })

  it('formats native function.arguments as parsed object rather than JSON string', () => {
    const body = buildBody('native', {
      model: 'gpt-oss:120b-cloud',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a","line":42}' }] },
      ],
    }) as { messages: Array<{ tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }> }

    expect(body.messages[0]?.tool_calls?.[0]?.function.arguments).toEqual({ path: 'a', line: 42 })
  })

  it('throws on malformed JSON tool arguments instead of silently returning empty object', () => {
    expect(() => buildBody('native', {
      model: 'gpt-oss:120b-cloud',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: '{invalid-json' }] },
      ],
    })).toThrow(/JSON/)
  })

  it('formats images as bare base64 on native and data URLs on OpenAI', () => {
    const rawBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const dataUrl = `data:image/png;base64,${rawBase64}`

    const nativeBody = buildBody('native', {
      model: 'llava',
      messages: [{ role: 'user', content: 'inspect', images: [dataUrl] }],
    }) as { messages: Array<{ images?: string[] }> }
    expect(nativeBody.messages[0]?.images).toEqual([rawBase64])

    const openAIBody = buildBody('openai', {
      model: 'llava',
      messages: [{ role: 'user', content: 'inspect', images: [rawBase64] }],
    }) as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }
    expect(openAIBody.messages[0]?.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: dataUrl },
    })
  })

  it('handles tool result images via trailing user message on OpenAI and native tool images', () => {
    const rawBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const dataUrl = `data:image/png;base64,${rawBase64}`

    const openAIBody = buildBody('openai', {
      model: 'llava',
      messages: [
        { role: 'tool', content: 'output text', toolCallId: 'call_1', images: [dataUrl] },
      ],
    }) as { messages: Array<Record<string, unknown>> }
    // OpenAI tool message must have pure text content
    expect(openAIBody.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'output text',
    })
    // Image rides on trailing user message
    expect(openAIBody.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: dataUrl } }],
    })

    const nativeBody = buildBody('native', {
      model: 'llava',
      messages: [
        { role: 'tool', content: 'output text', toolCallId: 'call_1', images: [dataUrl] },
      ],
    }) as { messages: Array<Record<string, unknown>> }
    expect(nativeBody.messages[0]).toEqual({
      role: 'tool',
      content: 'output text',
      images: [rawBase64],
    })
  })

  it('keeps consecutive tool messages together for parallel calls and flushes synthetic user image after the group', () => {
    const rawBase64Jpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
    const jpegDataUrl = `data:image/jpeg;base64,${rawBase64Jpeg}`

    const openAIBody = buildBody('openai', {
      model: 'llava',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'tool_a', arguments: '{}' },
            { id: 'call_2', name: 'tool_b', arguments: '{}' },
          ],
        },
        { role: 'tool', content: 'result 1', toolCallId: 'call_1', images: [jpegDataUrl] },
        { role: 'tool', content: 'result 2', toolCallId: 'call_2' },
      ],
    }) as { messages: Array<Record<string, unknown>> }

    expect(openAIBody.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(openAIBody.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result 1',
    })
    expect(openAIBody.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_2',
      content: 'result 2',
    })
    // Exact image media type (image/jpeg) is preserved
    expect(openAIBody.messages[3]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: jpegDataUrl } }],
    })
  })

  it('maps think under native and OpenAI surfaces', () => {
    const nativeLevel = buildBody('native', { model: 'gpt-oss:120b', messages: [], think: 'high' }) as Record<string, unknown>
    expect(nativeLevel.think).toBe('high')

    const openaiLevel = buildBody('openai', { model: 'gpt-oss:120b', messages: [], think: 'high' }) as Record<string, unknown>
    expect(openaiLevel.reasoning_effort).toBe('high')

    const nativeBool = buildBody('native', { model: 'deepseek-r1:70b', messages: [], think: true }) as Record<string, unknown>
    expect(nativeBool.think).toBe(true)

    const openaiBool = buildBody('openai', { model: 'deepseek-r1:70b', messages: [], think: true }) as Record<string, unknown>
    expect(openaiBool.reasoning_effort).toBe('auto')

    const openaiNone = buildBody('openai', { model: 'deepseek-r1:70b', messages: [], think: false }) as Record<string, unknown>
    expect(openaiNone.reasoning_effort).toBe('none')

    const nativeOmit = buildBody('native', { model: 'llama3:8b', messages: [] }) as Record<string, unknown>
    expect(nativeOmit).not.toHaveProperty('think')

    const openaiOmit = buildBody('openai', { model: 'llama3:8b', messages: [] }) as Record<string, unknown>
    expect(openaiOmit).not.toHaveProperty('reasoning_effort')
  })

  it('posts to the endpoint each surface actually lives at', () => {
    expect(chatUrl('openai')).toBe(`${CLOUD_BASE_URL}${OPENAI_CHAT_PATH}`)
    expect(chatUrl('native')).toBe(`${CLOUD_BASE_URL}${NATIVE_CHAT_PATH}`)
  })
})

describe('Ollama streaming', () => {
  it('accumulates a tool call split across deltas instead of truncating it', async () => {
    // The regression this pins: a call whose arguments arrive in pieces must not
    // be closed on the first piece, or the agent gets unparseable JSON.
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])) as unknown as typeof fetch

    const call = startChat(fetchFn, key, 'openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const state = createStreamState()
    const chunks = []
    for await (const event of call.events) {
      for (const chunk of applyEvent(state, event)) chunks.push(chunk)
    }
    chunks.push(...closeStream(state))

    const ended = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ended).toBeDefined()
    const block = (ended as { block: { arguments: string; name: string } }).block
    expect(block.name).toBe('read')
    // Both fragments, in order: the whole point of accumulating.
    expect(block.arguments).toBe('{"path":"a"}')
    expect(JSON.parse(block.arguments)).toEqual({ path: 'a' })
  })

  it('streams reasoning_content as thinking events on OpenAI SSE', async () => {
    const fetchFn = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking step 1' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'final answer' } }] }),
      '[DONE]',
    ])) as unknown as typeof fetch

    const call = startChat(fetchFn, key, 'openai', { model: 'deepseek-r1:70b', messages: [{ role: 'user', content: 'solve' }] })
    const events = []
    for await (const event of call.events) events.push(event)

    expect(events).toContainEqual({ type: 'thinking', text: 'thinking step 1' })
    expect(events).toContainEqual({ type: 'text', text: 'final answer' })
  })

  it('closes a text block that the stream left open', () => {
    const state = createStreamState()
    applyEvent(state, { type: 'text', text: 'partial' })
    const chunks = closeStream(state)
    const ended = chunks.find(chunk => chunk.type === 'block-end') as
      | { type: 'block-end'; index: number; block: { type: string; text: string } }
      | undefined
    expect(ended?.block).toEqual({ type: 'text', text: 'partial' })
  })

  it('finishes a tool turn as tool-calls so the agent loop keeps going', () => {
    const state = createStreamState()
    applyEvent(state, { type: 'tool_call', call: { id: 'c1', name: 'read', arguments: '{}' } })
    const chunks = closeStream(state)
    // Reporting 'stop' here would end the turn before the tool ran.
    const finish = chunks.find(chunk => chunk.type === 'finish') as
      | { type: 'finish'; reason: { kind: string } }
      | undefined
    expect(finish?.reason.kind).toBe('tool-calls')
  })

  it('reports a failed status instead of a parsed stream', async () => {
    const fetchFn = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const call = startChat(fetchFn, key, 'openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(await call.status).toBe(429)
    const events = []
    for await (const event of call.events) events.push(event)
    expect(events[0]).toMatchObject({ type: 'error' })
  })
})

describe('Ollama catalog', () => {
  it('reads the native tags list the service documents', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: 'gpt-oss:120b-cloud' }, { name: 'gemma4:31b' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const models = await loadCatalog(fetchFn, key)
    expect(models.map(m => m.id)).toEqual(['gpt-oss:120b-cloud', 'gemma4:31b'])
  })

  it('degrades to an empty list rather than throwing, so a failed sync is survivable', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await loadCatalog(fetchFn, key)).toEqual([])
  })
})

/**
 * The four ways a sync can come back with nothing.
 *
 * Issue #36 was reported as one undifferentiated failure, and the reason a user
 * could not act on it is that these were not told apart: a wrong key, an
 * upstream refusal, a network that never connected and a proxy that answered
 * with an HTML page all produced the same empty list and the same sentence.
 */
describe('Ollama catalog failures', () => {
  it('names a refused key as an auth failure, with its status', async () => {
    for (const status of [401, 403]) {
      const fetchFn = vi.fn(async () => new Response('nope', { status })) as unknown as typeof fetch
      expect(await fetchCatalog(fetchFn, key)).toEqual({ models: [], failure: 'auth', status })
    }
  })

  it('keeps another upstream refusal distinct from an auth failure', async () => {
    const fetchFn = vi.fn(async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch
    expect(await fetchCatalog(fetchFn, key)).toEqual({ models: [], failure: 'upstream', status: 429 })
  })

  it('reports a request that never reached the service as unreachable', async () => {
    // DNS, TLS, a refused proxy connection, or the catalog timeout itself. These
    // reject rather than answer, and used to escape the route as a throw.
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await fetchCatalog(fetchFn, key)).toEqual({ models: [], failure: 'unreachable' })
  })

  it('reports a 200 that is not a /api/tags document as malformed, not as empty', async () => {
    // The shape a captive portal or a rewriting proxy produces. Reading it with
    // response.json() is what threw 'Unexpected end of JSON input' in #36.
    const html = vi.fn(async () => new Response('<html>Sign in</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch
    expect(await fetchCatalog(html, key)).toEqual({ models: [], failure: 'malformed' })

    // ...and JSON that is valid but not the documented document.
    const wrongShape = vi.fn(async () => Response.json({ data: [{ id: 'm' }] })) as unknown as typeof fetch
    expect(await fetchCatalog(wrongShape, key)).toEqual({ models: [], failure: 'malformed' })
  })

  it('treats an account entitled to nothing as a success with an empty list', async () => {
    // Distinct from every failure above: nothing went wrong, there is simply no
    // model to show, and saying 'malformed' would send the user looking for a bug.
    const empty = vi.fn(async () => Response.json({ models: [] })) as unknown as typeof fetch
    expect(await fetchCatalog(empty, key)).toEqual({ models: [] })
  })

  it('asks the cloud endpoint, with the bearer key the service requires', async () => {
    const stub = vi.fn(async () => Response.json({ models: [] }))
    await fetchCatalog(stub as unknown as typeof fetch, key)
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit]
    // The reporter's theory was that the plugin still asked a local Ollama, or
    // an unauthenticated cloud one. Neither was true, but nothing asserted it.
    expect(url).toBe(`${CLOUD_BASE_URL}/api/tags`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })
})

describe('Ollama credential parsing', () => {
  it('requires a key and rejects a payload without one', () => {
    expect(parseOllamaCredentials({ apiKey: 'sk-1' }).apiKey).toBe('sk-1')
    expect(() => parseOllamaCredentials({})).toThrow()
    expect(() => parseOllamaCredentials(null)).toThrow()
  })

  it('names the line by its provider id', () => {
    expect(PROVIDER_ID).toBe('ollama')
  })
});
