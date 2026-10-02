import { describe, expect, it } from 'vitest'
import {
  buildMinimaxRequest,
  closeMinimaxStream,
  createStreamState,
  processMinimaxStreamLine,
} from '../src/host/minimax-code/mapper.ts'

describe('minimax thinking replay', () => {
  it('replays the trace and signature the service actually streamed', () => {
    // The trace arrives over deltas and the signature over its own event, which
    // is how the wire really behaves. Storing only the opening block replays an
    // empty trace, because that block is typically empty itself.
    const state = createStreamState()
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first I check' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' the file' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: unknown } | undefined
    expect(finish?.replayState).toEqual({
      response: {
        minimaxThinking: [{ type: 'thinking', thinking: 'first I check the file', signature: 'sig-abc' }],
      },
    })

    const replayed = buildMinimaxRequest({
      provider: 'minimax-code',
      model: 'minimax-M3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'first I check the file' }],
          source: { kind: 'dsh-chatgpt-subscription', replayState: finish?.replayState },
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'done' }] }],
          source: { kind: 'tool', callId: 't1' },
        },
      ],
    } as never)

    const messages = replayed.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(message => message.role === 'assistant')
    expect(assistant?.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'first I check the file',
      signature: 'sig-abc',
    })
  })

  it('keeps two thinking blocks apart', () => {
    const state = createStreamState()
    const send = (event: unknown) => processMinimaxStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'one' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
      ...send({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'two' } }),
      ...send({ type: 'content_block_stop', index: 1 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: unknown } | undefined
    expect(finish?.replayState).toEqual({
      response: {
        minimaxThinking: [
          { type: 'thinking', thinking: 'one' },
          { type: 'thinking', thinking: 'two' },
        ],
      },
    })
  })

  it('sends no thinking block for history this route did not produce', () => {
    const body = buildMinimaxRequest({
      provider: 'minimax-code',
      model: 'minimax-M3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'earlier trace' }] },
      ],
    } as never)

    const messages = body.messages as Array<{ role: string; content: unknown[] }>
    const assistant = messages.find(message => message.role === 'assistant')
    // Without stored native state there is nothing signed to replay, and a
    // hand-built block would be a guess rather than the model's own.
    expect(assistant?.content ?? []).toEqual([])
  })
})