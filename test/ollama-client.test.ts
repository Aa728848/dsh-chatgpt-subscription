import { describe, expect, it, vi } from 'vitest'
import { buildBody, chatUrl, loadCatalog, startChat, headersFor } from '../src/host/ollama/client.ts'
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
