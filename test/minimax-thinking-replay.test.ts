import { describe, expect, it } from 'vitest'
import {
  buildMinimaxRequest,
  closeMinimaxStream,
  createStreamState,
  processMinimaxStreamLine,
} from '../src/host/minimax-code/mapper.ts'

describe('minimax thinking replay', () => {
  it('keeps the service thinking block and replays it verbatim next turn', () => {
    const state = createStreamState()
    const send = (event: unknown) =>
      processMinimaxStreamLine('data: ' + JSON.stringify(event), state)

    const signed = { type: 'thinking', thinking: 'first I check', signature: 'sig-abc' }
    const out = [
      ...send({ type: 'content_block_start', index: 0, content_block: signed }),
      ...send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' first I check' } }),
      ...send({ type: 'content_block_stop', index: 0 }),
      ...send({ type: 'message_stop' }),
      ...closeMinimaxStream(state),
    ]

    const finish = out.find(chunk => chunk.type === 'finish') as { replayState?: unknown } | undefined
    // The trace the model produced is kept as the model issued it, signature
    // included: that block is what the next turn has to send back.
    expect(finish?.replayState).toEqual({ response: { minimaxThinking: [signed] } })

    const replayed = buildMinimaxRequest({
      provider: 'minimax-code',
      model: 'minimax-M3',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'first I check' }],
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
    expect(assistant?.content?.[0]).toEqual(signed)
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