/**
 * The version bridge the mappers read through.
 *
 * Harness 0.1.7 made a tool result a first-class `role: 'tool'` message and
 * removed the `tool-result` content block from its `ContentBlockMap`. This
 * package still supports 0.1.5/0.1.6, where that block inside a user message is
 * the only spelling, so every adapter normalizes the harness request once at its
 * boundary. These cases pin the contract that makes both generations reach the
 * mappers as one conversation.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import {
  PLUGIN_MESSAGE_SOURCE_KIND,
  normalizeGenerateOptions,
  normalizeMessages,
} from '../src/host/common/llm-compat.ts'
import type { Message } from '../src/host/common/llm-compat.ts'

/**
 * The 0.1.7 tool result as the harness delivers it: a first-class tool message.
 *
 * Written out rather than built by the installed harness's own factory, whose
 * spelling differs per generation (before 0.1.7 that factory returned a user
 * message holding the result block), so this case pins the bridge — not
 * whichever harness happens to be installed.
 */
function createToolResultMessage(input: { callId: string; content: readonly unknown[]; isError?: boolean }): unknown {
  return {
    id: 'm3',
    role: 'tool',
    source: { kind: 'tool', callId: input.callId },
    toolCallId: input.callId,
    content: input.content,
    ...(input.isError === true ? { isError: true } : {}),
  }
}

/** The spelling every harness generation before 0.1.7 delivered for one tool result. */
function legacyToolResultMessage(content: readonly unknown[], isError = false): Message {
  return {
    id: 'm3',
    role: 'user',
    source: { kind: 'tool', callId: 'call_1' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call_1',
      content,
      ...(isError ? { isError: true } : {}),
    }],
  } as unknown as Message
}

describe('normalizeMessages', () => {
  it('rewraps a tool-role message as the user-role tool result the mappers read', () => {
    const [normalized] = normalizeMessages([createToolResultMessage({
      callId: ToolCallId('call_1'),
      content: [{ type: 'text', text: 'exit code 0' }],
      isError: false,
    })])

    expect(normalized).toEqual({
      id: expect.anything(),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'exit code 0' }] }],
      source: { kind: 'tool', callId: 'call_1' },
    })
  })

  it('carries a failed tool call as an error result', () => {
    const [normalized] = normalizeMessages([createToolResultMessage({
      callId: ToolCallId('call_1'),
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    })])

    expect(normalized?.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    }])
    expect(normalized?.source).toEqual({ kind: 'tool', callId: 'call_1' })
  })

  it('maps the 0.1.7 conversation and the legacy one onto the same messages', () => {
    const content = [{ type: 'text', text: 'screenshot taken' }] as const
    const current = normalizeMessages([
      createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'get_window_state', arguments: '{}' }],
        source: { provider: 'p', model: 'm' },
      }),
      createToolResultMessage({ callId: ToolCallId('call_1'), content, isError: false }),
      createUserMessage({
        content: [{ type: 'text', text: 'attached video demo.mp4 for the next request.' }],
        source: { kind: PLUGIN_MESSAGE_SOURCE_KIND, form: 'notice', summary: 'attached video' },
      }),
    ])
    const legacy = normalizeMessages([
      { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] },
      {
        id: 'm2',
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', id: 'call_1', name: 'get_window_state', arguments: '{}' }],
      },
      legacyToolResultMessage(content),
      {
        id: 'm4',
        role: 'user',
        source: { kind: PLUGIN_MESSAGE_SOURCE_KIND, form: 'notice', summary: 'attached video' },
        content: [{ type: 'text', text: 'attached video demo.mp4 for the next request.' }],
      },
    ])

    // Identity is the harness's own; everything the mappers read is identical.
    const withoutIds = (messages: readonly Message[]) => messages.map(({ id: _id, ...rest }) => rest)
    expect(withoutIds(current)).toEqual(withoutIds(legacy))
  })

  it('keeps every non-message field of the request options', () => {
    const tools = [{ name: 'run_code', description: 'run', parameters: { type: 'object' } }]
    const options = normalizeGenerateOptions({
      provider: 'command-code',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
      system: 'Be precise.',
      maxTokens: 4096,
      tools,
    })

    expect(options).toMatchObject({ provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash', system: 'Be precise.', maxTokens: 4096, tools })
    expect(options.messages).toHaveLength(1)
  })

  it('tolerates a message body no block vocabulary recognises', () => {
    expect(normalizeMessages([
      { role: 'user', content: undefined } as unknown as Message,
      { role: 'user', content: ['not a block', null, { text: 'no tag' }] } as unknown as Message,
      null as unknown as Message,
    ])).toEqual([
      { id: undefined, role: 'user', content: [] },
      { id: undefined, role: 'user', content: [] },
    ])
  })
})
