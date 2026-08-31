import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CODEX_RESPONSES_URL } from '../src/compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient, parseResponsesStream } from '../src/host/responses-client.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

describe('Responses streaming', () => {
  it('assembles text, reasoning, usage and a JSON-safe tool call', async () => {
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.reasoning_summary_text.delta', delta: 'think' },
      { type: 'response.output_text.delta', delta: 'hello' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"a"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"path":"a"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } } },
    ])))
    expect(chunks).toContainEqual({ type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('reconstructs replay data when the stream omits a completed output item', async () => {
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_partial', call_id: 'call_partial', name: 'shell', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_partial', output_index: 0, delta: '{"command":"pwd"}' },
      { type: 'response.completed', response: {} },
    ])))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: {
        response: {
          outputItems: [{ type: 'function_call', call_id: 'call_partial', name: 'shell', arguments: '{"command":"pwd"}' }],
        },
      },
    })
  })

  it('streams Linux bash tool calls without changing their name or arguments', async () => {
    const argumentsJson = '{"command":"pwd && uname -s","description":"Inspect Linux host"}'
    const chunks = await collect(parseResponsesStream(sse([
      {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', id: 'fc_bash', call_id: 'call_bash', name: 'bash', arguments: argumentsJson },
      },
      { type: 'response.completed', response: {} },
    ])))

    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call_bash', name: 'bash', arguments: argumentsJson },
    })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })
  it('strips speculative sandbox controls that were hidden from the tool schema', async () => {
    const chunks = await collect(parseResponsesStream(sse([
      {
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'function_call', id: 'fc_pwsh', call_id: 'call_pwsh', name: 'pwsh',
          arguments: '{"command":"git status","description":"Show status","sandbox_permissions":"workspace-write","justification":""}',
        },
      },
      { type: 'response.completed', response: {} },
    ]), undefined, new Set(['pwsh'])))
    const argumentsJson = '{"command":"git status","description":"Show status"}'
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call_pwsh', name: 'pwsh', arguments: argumentsJson },
    })
    expect(chunks.at(-1)).toMatchObject({
      replayState: {
        response: {
          outputItems: [{ type: 'function_call', call_id: 'call_pwsh', name: 'pwsh', arguments: argumentsJson }],
        },
      },
    })
  })

  it('never emits a completed tool call for malformed JSON arguments', async () => {
    const emitted: StreamChunk[] = []
    await expect((async () => {
      for await (const chunk of parseResponsesStream(sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_bad', call_id: 'call_bad', name: 'shell', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_bad', output_index: 0, delta: '{bad' },
        { type: 'response.completed', response: {} },
      ]))) emitted.push(chunk)
    })()).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' })
    expect(emitted.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
  })

  it('handles SSE JSON split across byte chunks and ignores unknown events', async () => {
    const body = 'data: {"type":"unknown.event"}\n\ndata: {"type":"response.output_text.delta","delta":"split"}\n\ndata: {"type":"response.completed","response":{}}\n\n'
    const bytes = new TextEncoder().encode(body)
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 57))
        controller.enqueue(bytes.slice(57, 91))
        controller.enqueue(bytes.slice(91))
        controller.close()
      },
    }))
    const chunks = await collect(parseResponsesStream(response))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'split' })
  })

  it('throttles and truncates large reasoning streams before they reach the UI', async () => {
    const events = Array.from({ length: 120 }, () => ({
      type: 'response.reasoning_summary_text.delta',
      delta: 'x'.repeat(200),
    }))
    const chunks = await collect(parseResponsesStream(sse([
      ...events,
      { type: 'response.completed', response: {} },
    ])))
    const deltas = chunks.filter((chunk) => chunk.type === 'reasoning-delta')
    const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')

    expect(deltas.length).toBeLessThan(40)
    expect(end).toBeDefined()
    expect(end?.type === 'block-end' && end.block.type === 'reasoning' ? end.block.text : '').toContain('Reasoning summary truncated')
    expect(end?.type === 'block-end' && end.block.type === 'reasoning' ? end.block.text.length : 0).toBeLessThan(12_100)
  })

  it('rejects provider failures, premature EOF, and cancellation', async () => {
    await expect(collect(parseResponsesStream(sse([{ type: 'response.failed', response: { error: { code: 'bad', message: 'failed upstream' } } }])))).rejects.toThrow('failed upstream')
    await expect(collect(parseResponsesStream(sse([{ type: 'response.output_text.delta', delta: 'partial' }])))).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(collect(parseResponsesStream(sse([]), controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses the fixed backend, refreshes once on 401, and sends required headers', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'old', refreshToken: 'refresh', accountId: 'acct', expiresAt: Date.now() + 3_600_000 })
    const tokenFetch = vi.fn(async () => Response.json({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600 }))
    const oauth = new OAuthService(store, { fetchFn: tokenFetch as typeof fetch })
    const responseFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(sse([{ type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } }]))
    const client = new ResponsesClient(oauth, { readImage: async () => { throw new Error('unused') } }, { fetchFn: responseFetch as typeof fetch })
    await collect(client.stream({ provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [], sessionId: 'session-a' } as unknown as GenerateOptions))
    expect(responseFetch).toHaveBeenCalledTimes(2)
    expect(tokenFetch).toHaveBeenCalledTimes(1)
    expect(responseFetch.mock.calls[0]?.[0]).toBe(CODEX_RESPONSES_URL)
    const second = responseFetch.mock.calls[1]?.[1] as RequestInit
    expect(second.headers).toMatchObject({ authorization: 'Bearer fresh', 'chatgpt-account-id': 'acct', originator: 'opencode' })
    expect((second.headers as Record<string, string>)['session-id']).toMatch(/^dsh-[a-f0-9]{32}$/)
    expect((second.headers as Record<string, string>)['user-agent']).toContain('dsh-chatgpt-subscription/0.1.0-alpha.0')
    oauth.dispose()
  })

  it('does not retry a second 401 and cannot use credentials after logout', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
    const oauth = new OAuthService(store, {
      fetchFn: async () => Response.json({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600 }),
    })
    const responseFetch = vi.fn(async () => new Response('', { status: 401 }))
    const client = new ResponsesClient(oauth, { readImage: async () => { throw new Error('unused') } }, { fetchFn: responseFetch as typeof fetch })
    const options = { provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions
    await expect(collect(client.stream(options))).rejects.toMatchObject({ code: 'AUTH' })
    expect(responseFetch).toHaveBeenCalledTimes(2)
    await oauth.logout()
    responseFetch.mockClear()
    await expect(collect(client.stream(options))).rejects.toMatchObject({ code: 'not-authenticated' })
    expect(responseFetch).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('sends service_tier priority when fastMode option returns true', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'test-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
    const oauth = new OAuthService(store, { fetchFn: vi.fn() as typeof fetch })
    const responseFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.service_tier).toBe('priority')
      return sse([{ type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } }])
    })
    const client = new ResponsesClient(
      oauth,
      { readImage: async () => { throw new Error('unused') } },
      { fetchFn: responseFetch as typeof fetch, fastMode: () => true },
    )
    await collect(client.stream({ provider: 'codex-chatgpt', model: 'gpt-5.6-sol', messages: [] } as unknown as GenerateOptions))
    expect(responseFetch).toHaveBeenCalledTimes(1)
    oauth.dispose()
  })

  it('correctly handles interleaved progress text followed by a tool call in the same turn', async () => {
    const chunks = await collect(parseResponsesStream(sse([
      { type: 'response.output_text.delta', delta: '我会按刚才的优先级执行：先修改文件...' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_edit', call_id: 'call_edit', name: 'edit_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_edit', output_index: 1, delta: '{"path":"src/index.ts"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_edit', output_index: 1, arguments: '{"path":"src/index.ts"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_edit', call_id: 'call_edit', name: 'edit_file', arguments: '{"path":"src/index.ts"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 30 } } },
    ])))

    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '我会按刚才的优先级执行：先修改文件...' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: '我会按刚才的优先级执行：先修改文件...' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'tool-call' })
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_edit', name: 'edit_file', arguments: '{"path":"src/index.ts"}' } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps server overloaded error stream events to SERVER_ERROR code', async () => {
    await expect((async () => {
      for await (const chunk of parseResponsesStream(sse([
        { type: 'response.failed', response: { error: { message: 'Our servers are currently overloaded. Please try again later.' } } },
      ]))) {
        expect(chunk).toBeDefined()
      }
    })()).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      message: expect.stringContaining('overloaded'),
    })
  })
})

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of iterable) result.push(chunk)
  return result
}
