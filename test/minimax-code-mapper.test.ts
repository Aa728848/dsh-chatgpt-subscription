import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  assertRequestBodyFits,
  assertStreamComplete,
  buildMinimaxRequest,
  closeMinimaxStream,
  countMinimaxCacheBreakpoints,
  createStreamState,
  DEFAULT_MAX_MESSAGE_BODY_BYTES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  MAX_CACHE_BREAKPOINTS,
  maxMessageBodyBytes,
  maxRequestImageBytes,
  offloadOldestRequestImages,
  processMinimaxStreamLine,
  streamHasContent,
} from '../src/host/minimax-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'MiniMax-M2.7',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] } as Message,
    ],
    ...overrides,
  } as GenerateOptions
}

/** One SSE line as the adapter feeds it: the `data:` prefix and the JSON payload. */
function line(payload: Record<string, unknown>): string {
  return 'data: ' + JSON.stringify(payload)
}

/** The event sequence this subscription sends for one short text answer. */
const HAPPY_PATH = [
  line({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
  line({ type: 'content_block_stop', index: 0 }),
  line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
  line({ type: 'message_stop' }),
]

describe('buildMinimaxRequest', () => {
  it('asks for the event stream the adapter parses', () => {
    // Measured: without this flag the service answers 200 with a single JSON
    // message body and the adapter, which reads the body as SSE, reports the
    // complete answer as a stream that ended before its terminal event.
    expect(buildMinimaxRequest(options())).toMatchObject({ stream: true })
  })

  it('keeps the rest of the Anthropic Messages body intact', () => {
    const body = buildMinimaxRequest(options({ maxTokens: 256, temperature: 0.2 }))
    expect(body.model).toBe('MiniMax-M2.7')
    expect(body.max_tokens).toBe(256)
    expect(Array.isArray(body.messages)).toBe(true)
  })
})

describe('prompt cache breakpoints', () => {
  // Caching on this wire is request-driven: the service creates a cache only
  // where the request puts a cache_control breakpoint, which is why this route
  // reported no cache hits before the markers went in.
  it('marks the system block, the last user block, and the last tool by default', () => {
    const body = buildMinimaxRequest(options({
      system: 'be brief',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }))

    expect(body.system).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }])
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[messages.length - 1]!.content.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } })
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools[tools.length - 1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  it('stays within the breakpoint budget the wire enforces', () => {
    const body = buildMinimaxRequest(options({
      system: 'be brief',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }))
    expect(countMinimaxCacheBreakpoints(body)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS)
  })

  it('marks only the message tail when the request carries no system text or tools', () => {
    const body = buildMinimaxRequest(options())
    expect(body.system).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(countMinimaxCacheBreakpoints(body)).toBe(1)
  })

  it('sends no marker and keeps the string system form when caching is opted out', () => {
    const body = buildMinimaxRequest(options({
      system: 'be brief',
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    }), undefined, { cacheControl: false })

    expect(body.system).toBe('be brief')
    expect(countMinimaxCacheBreakpoints(body)).toBe(0)
  })

  it('marks no message block when the history ends on an assistant turn', () => {
    const body = buildMinimaxRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] } as Message,
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } as Message,
      ],
    }))
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[messages.length - 1]!.role).toBe('assistant')
    expect(countMinimaxCacheBreakpoints(body)).toBe(0)
  })
})

describe('minimax stream completeness', () => {
  it('accepts the terminal sequence and yields the answer', () => {
    const state = createStreamState()
    const chunks = HAPPY_PATH.flatMap((entry) => processMinimaxStreamLine(entry, state))

    expect(() => assertStreamComplete(state)).not.toThrow()
    expect(streamHasContent(state)).toBe(true)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hi' }))
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    )
  })

  it('treats a stop_reason without message_stop as complete', () => {
    const state = createStreamState()
    for (const entry of HAPPY_PATH.slice(0, 5)) processMinimaxStreamLine(entry, state)

    expect(state.done).toBe(false)
    expect(() => assertStreamComplete(state)).not.toThrow()
    expect(closeMinimaxStream(state)).toContainEqual(expect.objectContaining({ type: 'finish' }))
  })

  it('rejects a body that never carried an event stream', () => {
    const state = createStreamState()
    // Exactly what the service returns when the request did not ask to stream:
    // one JSON message, with no `data:` line anywhere in the body.
    const body = JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
    })
    for (const entry of body.split('\n')) processMinimaxStreamLine(entry, state)

    expect(() => assertStreamComplete(state)).toThrow(/stream ended before its terminal event/)
  })

  it('rejects a stream that stopped mid-answer', () => {
    const state = createStreamState()
    for (const entry of HAPPY_PATH.slice(0, 3)) processMinimaxStreamLine(entry, state)

    expect(streamHasContent(state)).toBe(true)
    expect(() => assertStreamComplete(state)).toThrow(/stream ended before its terminal event/)
  })

  it('reads the real usage counters from the terminal message_delta', () => {
    // Measured on the live endpoint: message_start carries a zero-filled usage
    // stub; the actual input and cache counters arrive only in message_delta,
    // with input_tokens already net of the cached portion.
    const state = createStreamState()
    const events = [
      line({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 75, output_tokens: 33, cache_read_input_tokens: 6656 },
      }),
      line({ type: 'message_stop' }),
    ]
    const chunks = events.flatMap((entry) => processMinimaxStreamLine(entry, state))

    expect(() => assertStreamComplete(state)).not.toThrow()
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 75, outputTokens: 33, cacheReadTokens: 6656 },
    })
  })

  it('keeps the message_start counters when a delta omits them', () => {
    const state = createStreamState()
    const events = [
      line({
        type: 'message_start',
        message: { usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 4 } },
      }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      line({ type: 'message_stop' }),
    ]
    const chunks = events.flatMap((entry) => processMinimaxStreamLine(entry, state))

    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 },
    })
  })
})

describe('the request body ceiling belongs to this route, not to Kimi Code', () => {
  // The reported failure: a real session on this line hit "the serialized body is
  // 2098045 bytes, above the 2097152-byte ceiling this route enforces" and the
  // turn died before a request was ever sent. 2,098,045 is only 893 bytes over
  // 2,097,152 — and 2,097,152 is Kimi Code's documented limit, imported here
  // because both lines speak an Anthropic dialect. It is Kimi's gateway that
  // enforces that number, not MiniMax's.
  const REPORTED_BYTES = 2_098_045
  const KIMI_CEILING = 2_097_152

  it('does not refuse a body that only the borrowed Kimi ceiling rejected', () => {
    // Built the way the adapter builds it, so this is the real request shape and
    // not a hand-made padding field: a conversation that overshot 2 MB.
    const body = buildMinimaxRequest(options({
      messages: Array.from({ length: 40 }, () => ({
        role: 'user',
        content: [{ type: 'text', text: 'x'.repeat(60_000) }],
      })) as Message[],
    }))
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
    expect(bytes).toBeGreaterThan(KIMI_CEILING)

    // The regression: this exact size used to throw.
    expect(bytes).toBeGreaterThanOrEqual(REPORTED_BYTES - 100_000)
    expect(() => assertRequestBodyFits(body)).not.toThrow()
  })

  it('keeps the ceiling far above every conversation a real session produces', () => {
    // A whole 1M-token context window is roughly 4 MB of text; a session that
    // reached the old 2 MB limit was long, not broken.
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBeGreaterThan(64 * 1024 * 1024 - 1)
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBeGreaterThan(16 * KIMI_CEILING)
  })

  it('still stops a runaway request before the connection is spent', () => {
    // Raising the ceiling must not remove the bound: a loop that appends a
    // multi-megabyte tool result every iteration is still refused, and the
    // message still names a remedy instead of reporting a bare number.
    const runaway = { model: 'MiniMax-M3', messages: [{ role: 'user', content: 'x'.repeat(70 * 1024 * 1024) }] }
    expect(() => assertRequestBodyFits(runaway)).toThrow(/compact/i)
    try {
      assertRequestBodyFits(runaway)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PROVIDER_ERROR')
    }
  })

  it('measures against the ceiling the deployment pinned', () => {
    // A proxy or gateway in front of the route can have its own, smaller limit.
    const body = { model: 'MiniMax-M3', padding: 'x'.repeat(KIMI_CEILING + 1) }
    expect(() => assertRequestBodyFits(body, KIMI_CEILING)).toThrow(/2097152-byte ceiling/)
    expect(() => assertRequestBodyFits(body, DEFAULT_MAX_MESSAGE_BODY_BYTES)).not.toThrow()
  })
})

describe('maxMessageBodyBytes', () => {
  it('defaults to this route\'s own ceiling', () => {
    expect(maxMessageBodyBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_MESSAGE_BODY_BYTES)
  })

  it('honours a measured override', () => {
    expect(maxMessageBodyBytes({ DSH_MINIMAX_CODE_MAX_BODY_BYTES: '  1048576 ' } as NodeJS.ProcessEnv))
      .toBe(1_048_576)
  })

  it('ignores a value that is not a positive integer rather than disabling the guard', () => {
    // A typo must not silently turn the ceiling off.
    for (const raw of ['0', '-1', 'lots', '', '   ', 'NaN']) {
      expect(maxMessageBodyBytes({ DSH_MINIMAX_CODE_MAX_BODY_BYTES: raw } as NodeJS.ProcessEnv))
        .toBe(DEFAULT_MAX_MESSAGE_BODY_BYTES)
    }
  })
})

describe('the image budget belongs to this route, not to Kimi Code', () => {
  // The same borrowed-constant mistake, one layer down and worse: Kimi's image
  // budget is 1,500,000 because it has to fit inside Kimi's own 2 MB request
  // limit. MiniMax's model table allows a 10 MB RAW image (~13.3 MB base64), so
  // a single ordinary screenshot was ~9x over budget and got replaced by a
  // placeholder — silently, with no error and nothing saying the model never
  // saw the picture.
  const TEN_MB_RAW = 10 * 1024 * 1024
  const TEN_MB_BASE64 = Math.ceil(TEN_MB_RAW / 3) * 4
  const KIMI_IMAGE_BUDGET = 1_500_000

  function withImage(bytes: number, id = 'a1'): GenerateOptions {
    return options({
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: id, bytes, name: 'shot.png' } }],
      }] as unknown as Message[],
    })
  }

  it("keeps one image at this route's own 10 MB per-image ceiling", () => {
    const bounded = offloadOldestRequestImages(withImage(TEN_MB_RAW), DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    const blocks = bounded.messages.flatMap((message) => message.content as unknown[])
    expect(blocks.some((block) => (block as { type?: string }).type === 'image')).toBe(true)
  })

  it('would have dropped that same image under the borrowed Kimi budget', () => {
    // Proves the previous behaviour was the bug, not the guard.
    const bounded = offloadOldestRequestImages(withImage(TEN_MB_RAW), KIMI_IMAGE_BUDGET)
    const blocks = bounded.messages.flatMap((message) => message.content as unknown[])
    expect(blocks.some((block) => (block as { type?: string }).type === 'image')).toBe(false)
    expect(blocks.some((block) => (block as { type?: string }).type === 'text')).toBe(true)
  })

  it('still trims a runaway multi-image request', () => {
    // Raising the budget must not remove the bound.
    const many = options({
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'a' + index, bytes: TEN_MB_RAW, name: 's.png' } }],
      })) as unknown as Message[],
    })
    const bounded = offloadOldestRequestImages(many, DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    const blocks = bounded.messages.flatMap((message) => message.content as unknown[])
    expect(blocks.some((block) => (block as { type?: string }).type === 'image')).toBe(true)
    expect(blocks.some((block) => (block as { type?: string }).type === 'text')).toBe(true)
  })

  it('leaves a small request untouched (same object, no work)', () => {
    const small = withImage(1_024)
    expect(offloadOldestRequestImages(small, DEFAULT_MAX_REQUEST_IMAGE_BYTES)).toBe(small)
  })

  it("fits the model's own per-image ceiling with headroom", () => {
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBeGreaterThan(TEN_MB_BASE64)
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBeLessThan(DEFAULT_MAX_MESSAGE_BODY_BYTES)
  })

  it('honours a measured override and ignores an invalid one', () => {
    expect(maxRequestImageBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    expect(maxRequestImageBytes({ DSH_MINIMAX_CODE_MAX_IMAGE_BYTES: '2000000' } as NodeJS.ProcessEnv))
      .toBe(2_000_000)
    for (const raw of ['0', '-5', 'huge', '']) {
      expect(maxRequestImageBytes({ DSH_MINIMAX_CODE_MAX_IMAGE_BYTES: raw } as NodeJS.ProcessEnv))
        .toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    }
  })
})
