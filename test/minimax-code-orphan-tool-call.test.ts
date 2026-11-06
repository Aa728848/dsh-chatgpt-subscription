import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'

/**
 * An orphaned tool call is fatal on this wire.
 *
 * The Anthropic-compatible endpoint MiniMax serves validates the tool message
 * sequence: every `tool_result` must follow the assistant turn that issued the
 * matching `tool_use`, and every `tool_use` must be answered. One unpaired call
 * makes the whole request a `400 invalid params` (error code 2013), and the
 * request is not retryable - the same body fails the same way forever.
 *
 * The shape that produced it in the field: the model was told to call a tool
 * its tool list did not contain, so the call never ran and the history kept a
 * `tool_use` with no result. Every later request in that session then failed.
 */

const MODEL = 'MiniMax-M2.7'

/** A user turn. */
function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] } as Message
}

/** An assistant turn that asked for one tool. */
function assistantCall(id: string, name = 'progress_update'): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working on it' },
      { type: 'tool-call', id, name, arguments: '{}' },
    ],
  } as unknown as Message
}

/** An assistant turn whose only content is the tool call. */
function assistantCallOnly(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', id, name: 'progress_update', arguments: '{}' }],
  } as unknown as Message
}

/** The result of one tool call. */
function toolResult(id: string): Message {
  return {
    role: 'tool',
    source: { kind: 'tool', callId: id },
    content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'done' }] }],
  } as unknown as Message
}

type WireMessage = { role: string; content: Array<Record<string, unknown>> }

/** The request body this mapper would send for one history. */
function bodyOf(messages: Message[]): WireMessage[] {
  const body = buildMinimaxRequest({ model: MODEL, messages } as GenerateOptions)
  return body.messages as WireMessage[]
}

/** Every tool_use id in one wire body. */
function toolUseIds(messages: WireMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') ids.push(String(block.id))
    }
  }
  return ids
}

/** Every tool_result id in one wire body. */
function toolResultIds(messages: WireMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') ids.push(String(block.tool_use_id))
    }
  }
  return ids
}

describe('minimax mapper: orphaned tool calls', () => {
  it('keeps a tool call that has its result', () => {
    const messages = bodyOf([user('hi'), assistantCall('call_1'), toolResult('call_1')])
    expect(toolUseIds(messages)).toEqual(['call_1'])
    expect(toolResultIds(messages)).toEqual(['call_1'])
  })

  it('drops a tool call that never got a result', () => {
    // The field shape: the model named a tool it could not reach, so nothing
    // ran and the history kept the call without an answer.
    const messages = bodyOf([user('hi'), assistantCall('call_1'), user('go on')])
    expect(toolUseIds(messages)).toEqual([])
    // The assistant turn itself survives - it still has its text.
    expect(messages.some((message) => message.role === 'assistant')).toBe(true)
  })

  it('drops an assistant turn whose only block was the orphan call', () => {
    const messages = bodyOf([user('hi'), assistantCallOnly('call_1'), user('go on')])
    expect(toolUseIds(messages)).toEqual([])
    expect(messages.some((message) => message.role === 'assistant')).toBe(false)
  })

  it('drops a tool result that matches no call', () => {
    const messages = bodyOf([user('hi'), assistantCall('call_1'), toolResult('call_other')])
    expect(toolResultIds(messages)).toEqual([])
    // The call that had no matching result goes with it.
    expect(toolUseIds(messages)).toEqual([])
  })

  it('leaves a request that would empty out untouched', () => {
    // Cleaning must never turn a conversation into zero messages: that is a
    // different failure, and the server would reject it for a new reason.
    const messages = bodyOf([assistantCallOnly('call_1')])
    expect(messages.length).toBe(1)
  })

  it('keeps the later turns of a session whose middle turn was orphaned', () => {
    const messages = bodyOf([
      user('first'),
      assistantCall('call_1'),
      user('second'),
      assistantCall('call_2'),
      toolResult('call_2'),
    ])
    // The answered call survives; the orphan does not.
    expect(toolUseIds(messages)).toEqual(['call_2'])
    expect(toolResultIds(messages)).toEqual(['call_2'])
  })
})
