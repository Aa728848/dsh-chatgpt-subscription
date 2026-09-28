import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  assertStreamComplete,
  buildMinimaxRequest,
  closeMinimaxStream,
  countMinimaxCacheBreakpoints,
  createStreamState,
  MAX_CACHE_BREAKPOINTS,
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
