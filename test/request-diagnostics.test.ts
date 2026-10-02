import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createDiagnosticFetch,
  clearDiagnosticSessionState,
  getDiagnosticSessionCacheSize,
  parseUsageObject,
  type RequestDiagnosticRecord,
  type FetchLike,
} from '../src/host/common/request-diagnostics.ts'

describe('request-diagnostics', () => {
  it('keeps valid terminal usage after a huge line and ignores nested fake usage', async () => {
    const records: RequestDiagnosticRecord[] = []
    const text = 'data: ' + JSON.stringify({ text: 'x'.repeat(70000) }) + '\n\n' + 'data: ' + JSON.stringify({ delta: { usage: { input_tokens: 9999 } } }) + '\n\n' + 'data: ' + JSON.stringify({ response: { usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n\n'
    const wrapped = createDiagnosticFetch(async () => new Response(text), { enabled: true, provider: 'codex-chatgpt', onRecord: r => records.push(r) })
    await (await wrapped('https://example.test/v1/responses', { method: 'POST' })).text()
    expect(records[0].usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
  })
  it('detects tools removed from a scoped request', async () => {
    const records: RequestDiagnosticRecord[] = []
    const wrapped = createDiagnosticFetch(async () => new Response('ok'), { enabled: true, provider: 'codex-chatgpt', correlation: { sessionId: 'scope' }, onRecord: r => records.push(r) })
    for (const tools of [[{ name: 'read', parameters: {} }], []]) await (await wrapped('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify({ tools }) })).text()
    expect(records[1].fingerprints?.toolChanged).toBe(true)
  })

  beforeEach(() => {
    clearDiagnosticSessionState()
    delete process.env.DSH_PROVIDER_DIAGNOSTICS
  })

  it('preserves clean JSON serialization without circular references or leaking functions', async () => {
    const records: RequestDiagnosticRecord[] = []
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      return new Response(
        'data: {"id":"1","usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'codex-chatgpt',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
      correlation: { sessionId: 'test-session', retryCount: 2 },
    })

    const res = await diagFetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token-12345',
        'x-session-id': 'test-session',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: 'Secret instructions' }],
        tools: [{ name: 'calculator', description: 'calculate math', parameters: { type: 'object' } }],
      }),
    })

    await res.text()

    expect(records).toHaveLength(1)
    const rec = records[0]

    // Verify JSON serialization
    const jsonStr = JSON.stringify(rec)
    const parsed = JSON.parse(jsonStr)
    expect(parsed).toEqual(rec)

    // Verify privacy: no raw secrets or prompts in JSON output
    expect(jsonStr).not.toContain('secret-token-12345')
    expect(jsonStr).not.toContain('Secret instructions')
    expect(jsonStr).not.toContain('test-session')
    expect(jsonStr).not.toContain('https://chatgpt.com')
    expect(jsonStr).not.toContain('gpt-4o')

    // Safe schema checks
    expect(rec.provider).toBe('codex-chatgpt')
    expect(rec.endpoint).toBe('chat_completions')
    expect(rec.statusCode).toBe(200)
    expect(rec.statusClass).toBe('2xx')
    expect(rec.outcome).toBe('completed')
    expect(rec.retries).toBe(2)
    expect(rec.requestBytes).toBeGreaterThan(0)
    expect(rec.firstByteMs).not.toBeNull()
    expect(rec.ttftMs).toBeNull() // strictly null
    expect(rec.fingerprints?.authFingerprint).toBeDefined()
    expect(rec.fingerprints?.modelFingerprint).toBeDefined()
    expect(rec.fingerprints?.toolFingerprint).toBeDefined()
    expect(rec.fingerprints?.prefixFingerprint).toBeDefined()
  })

  it('differentiates usage missing vs zero, rejects nonfinite/negative, and respects Anthropic messages endpoint', () => {
    // 1. With explicit zero cached tokens
    const withZero = parseUsageObject({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    })
    expect(withZero).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })

    // 2. With omitted/missing cache details
    const withoutCache = parseUsageObject({
      prompt_tokens: 100,
      completion_tokens: 50,
    })
    expect(withoutCache).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(withoutCache?.cacheReadTokens).toBeUndefined()
    expect(withoutCache?.cacheWriteTokens).toBeUndefined()
    expect(withoutCache?.totalTokens).toBeUndefined()

    // 3. Disjoint subtraction on default/responses endpoint: inputTokens = totalInput - cacheRead - cacheWrite
    const disjoint = parseUsageObject(
      {
        prompt_tokens: 120,
        completion_tokens: 40,
        prompt_tokens_details: {
          cached_tokens: 50,
          cache_write_tokens: 30,
        },
        completion_tokens_details: {
          reasoning_tokens: 15,
        },
      },
      'responses',
    )
    expect(disjoint?.inputTokens).toBe(40) // 120 - 50 - 30
    expect(disjoint?.cacheReadTokens).toBe(50)
    expect(disjoint?.cacheWriteTokens).toBe(30)
    expect(disjoint?.reasoningTokens).toBe(15)

    // 4. Anthropic /v1/messages endpoint: input_tokens is ALREADY disjoint (no cache subtraction!)
    const anthropicMessages = parseUsageObject(
      {
        input_tokens: 200,
        output_tokens: 80,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 30,
      },
      'messages',
    )
    expect(anthropicMessages?.inputTokens).toBe(200) // Preserved directly!
    expect(anthropicMessages?.cacheReadTokens).toBe(120)
    expect(anthropicMessages?.cacheWriteTokens).toBe(30)

    // 5. Rejection of nonfinite or negative token numbers
    const invalidNumbers = parseUsageObject({
      prompt_tokens: -10,
      completion_tokens: Infinity,
      total_tokens: NaN,
      prompt_tokens_details: {
        cached_tokens: 'invalid',
      },
    })
    expect(invalidNumbers).toBeUndefined()
  })

  it('merges Anthropic message_start input usage and message_delta output usage in SSE stream', async () => {
    const records: RequestDiagnosticRecord[] = []

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(0)) // empty chunk, should not trigger firstByteMs
        await new Promise((r) => setTimeout(r, 15))
        controller.enqueue(
          new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":75,"cache_read_input_tokens":25}}}\n\n',
          ),
        )
        await new Promise((r) => setTimeout(r, 15))
        controller.enqueue(
          new TextEncoder().encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n'),
        )
        await new Promise((r) => setTimeout(r, 15))
        controller.enqueue(
          new TextEncoder().encode(
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n',
          ),
        )
        controller.close()
      },
    })

    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'claude-subscription',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    const res = await diagFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })

    const text = await res.text()
    expect(text).toContain('content_block_delta')
    expect(records).toHaveLength(1)

    const rec = records[0]
    expect(rec.outcome).toBe('completed')
    expect(rec.firstByteMs).toBeGreaterThanOrEqual(10)
    expect(rec.ttftMs).toBeNull()
    expect(rec.durationMs).toBeGreaterThanOrEqual(rec.firstByteMs!)
    // Verified merged usage from message_start AND message_delta
    expect(rec.usage).toEqual({
      inputTokens: 75,
      outputTokens: 30,
      cacheReadTokens: 25,
    })
  })

  it('errors stream with original abort reason and releases reader lock on abort', async () => {
    const records: RequestDiagnosticRecord[] = []
    let readerReleased = false

    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        readerReleased = true
      },
    })

    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      return new Response(stream, { status: 200 })
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'antigravity',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    const abortController = new AbortController()
    const customReason = new Error('Custom abort message')

    const res = await diagFetch('https://cloudcode-pa.googleapis.com/v1:streamGenerateContent', {
      method: 'POST',
      signal: abortController.signal,
    })

    const reader = res.body!.getReader()
    const readPromise = reader.read()

    abortController.abort(customReason)

    await expect(readPromise).rejects.toThrow('Custom abort message')
    expect(readerReleased).toBe(true)
    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('canceled')
  })

  it('performs post-response abort check when signal is aborted during or immediately after fetch', async () => {
    const records: RequestDiagnosticRecord[] = []
    const abortController = new AbortController()
    const customReason = new Error('Aborted mid-flight')

    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      // Signal aborts right before response returns
      abortController.abort(customReason)
      return new Response('stream-never-read', { status: 200 })
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'kimi-code',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    await expect(
      diagFetch('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        signal: abortController.signal,
      }),
    ).rejects.toThrow('Aborted mid-flight')

    expect(records).toHaveLength(1)
    expect(records[0].outcome).toBe('canceled')
  })

  it('ignores non-POST requests and validates provider and endpoint enums', async () => {
    const records: RequestDiagnosticRecord[] = []
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'codex-chatgpt',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    // 1. GET requests must NOT be processed
    const getRes = await diagFetch('https://chatgpt.com/backend-api/conversation', {
      method: 'GET',
    })
    await getRes.text()
    expect(records).toHaveLength(0)

    // 2. Non-model paths must NOT be processed
    const modelsRes = await diagFetch('https://chatgpt.com/backend-api/models', {
      method: 'POST',
    })
    await modelsRes.text()
    expect(records).toHaveLength(0)
  })

  it('measures requestBytes as null for unknown streams, not 0', async () => {
    const records: RequestDiagnosticRecord[] = []
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'command-code',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    const unknownStream = new ReadableStream({
      start(c) {
        c.close()
      },
    })

    const res = await diagFetch('https://api.command.com/v1/responses', {
      method: 'POST',
      body: unknownStream as any,
    })
    await res.text()

    expect(records).toHaveLength(1)
    expect(records[0].requestBytes).toBeNull() // unknown stream is null, not 0
  })

  it('fingerprints tool order schemas and explicit empty arrays', async () => {
    const records: RequestDiagnosticRecord[] = []
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'ollama',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    // Request with empty tools []
    await (
      await diagFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: JSON.stringify({ tools: [] }),
      })
    ).text()
    expect(records[0].fingerprints?.toolFingerprint).toBeDefined()

    // Tool order changes the wire prefix and must change its fingerprint
    await (
      await diagFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          tools: [
            { name: 'b_tool', parameters: { type: 'string' } },
            { name: 'a_tool', parameters: { type: 'number' } },
          ],
        }),
      })
    ).text()

    await (
      await diagFetch('http://localhost:11434/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          tools: [
            { name: 'a_tool', parameters: { type: 'number' } },
            { name: 'b_tool', parameters: { type: 'string' } },
          ],
        }),
      })
    ).text()

    expect(records[1].fingerprints?.toolFingerprint).toBeDefined()
    expect(records[1].fingerprints?.toolFingerprint).not.toBe(records[2].fingerprints?.toolFingerprint)
  })

  it('scopes session key per provider and endpoint', async () => {
    const records: RequestDiagnosticRecord[] = []
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'workbuddy-subscription',
      enabled: true,
      onRecord: (rec) => {
        records.push(rec)
      },
    })

    // Session 1 on workbuddy chat
    await (
      await diagFetch('https://api.workbuddy.ai/chat/completions', {
        method: 'POST',
        headers: { 'x-session-id': 'session-100' },
        body: JSON.stringify({ model: 'wb-model-1' }),
      })
    ).text()
    expect(records[0].fingerprints?.modelChanged).toBeUndefined()

    // Same session on workbuddy chat, model unchanged
    await (
      await diagFetch('https://api.workbuddy.ai/chat/completions', {
        method: 'POST',
        headers: { 'x-session-id': 'session-100' },
        body: JSON.stringify({ model: 'wb-model-1' }),
      })
    ).text()
    expect(records[1].fingerprints?.modelChanged).toBe(false)
  })

  it('preserves response url, redirected, and type properties', async () => {
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      const resp = new Response('ok', {
        status: 200,
        headers: { 'x-custom': 'header-1' },
      })
      Object.defineProperty(resp, 'url', { value: 'https://api.anthropic.com/v1/messages' })
      Object.defineProperty(resp, 'redirected', { value: true })
      Object.defineProperty(resp, 'type', { value: 'basic' })
      return resp
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'claude-subscription',
      enabled: true,
    })

    const res = await diagFetch('https://api.anthropic.com/v1/messages', { method: 'POST' })
    expect(res.url).toBe('https://api.anthropic.com/v1/messages')
    expect(res.redirected).toBe(true)
    expect(res.type).toBe('basic')
    expect(res.headers.get('x-custom')).toBe('header-1')
    await res.text()
  })

  it('pure diagnostics sink failures never break generation', async () => {
    const mockFetch: FetchLike = vi.fn().mockImplementation(async () => {
      return new Response('stream-content-success', { status: 200 })
    })

    const diagFetch = createDiagnosticFetch(mockFetch, {
      provider: 'workbuddy-subscription',
      enabled: true,
      onRecord: () => {
        throw new Error('Sink storage crashed')
      },
    })

    const res = await diagFetch('https://api.workbuddy.ai/chat/completions', {
      method: 'POST',
    })

    const content = await res.text()
    expect(content).toBe('stream-content-success')
  })
})
