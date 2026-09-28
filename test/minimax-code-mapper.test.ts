import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  assertStreamComplete,
  buildMinimaxRequest,
  closeMinimaxStream,
  createStreamState,
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
})
