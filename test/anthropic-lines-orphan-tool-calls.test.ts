import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { buildClaudeRequestBody } from '../src/host/claude/mapper.ts'
import { buildGlmAnthropicRequest } from '../src/host/glm-coding-plan/mapper-anthropic.ts'
import { GLM_CODING_EFFORTS } from '../src/host/glm-coding-plan/types.ts'
import { buildAnthropicRequest as buildCommandCodeRequest } from '../src/host/command-code/mapper.ts'
import { buildAnthropicRequest as buildKimiRequest } from '../src/host/kimi-code/mapper.ts'
import { buildMessagesRequest as buildWorkbuddyRequest } from '../src/host/workbuddy/mapper.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'

/**
 * Every line that speaks Anthropic Messages repairs the tool pairing before sending.
 *
 * The guard itself is unit-tested beside its module (`orphan-tool-calls.test.ts`);
 * what these tests lock out is a line that BUILDS the body some other way and
 * never calls it. That is the failure mode a refactor produces: the function
 * still exists and its tests still pass, while one line quietly stopped using it.
 */

type Wire = { role: string; content: Array<Record<string, unknown>> }

/** A plain user turn. */
function user(text: string): Message {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } as unknown as Message
}

/** An assistant turn that asked for one tool. */
function assistantCall(id: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working on it' },
      { type: 'tool-call', id, name: 'read', arguments: '{}' },
    ],
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

/** One line's request builder, and the model id its builder expects. */
interface LineUnderTest {
  name: string
  model: string
  build: (messages: Message[]) => Record<string, unknown>
}

const LINES: LineUnderTest[] = [
  {
    name: 'minimax-code',
    model: 'MiniMax-M2.7',
    build: (messages) => buildMinimaxRequest({ provider: 'minimax-code', model: 'MiniMax-M2.7', messages } as GenerateOptions),
  },
  {
    name: 'claude',
    model: 'claude-sonnet-4-6',
    build: (messages) => buildClaudeRequestBody({ provider: 'claude-subscription', model: 'claude-sonnet-4-6', messages } as GenerateOptions),
  },
  {
    name: 'glm-coding-plan',
    model: 'glm-5.3',
    build: (messages) => buildGlmAnthropicRequest(
      { provider: 'glm-coding-plan', model: 'glm-5.3', messages } as GenerateOptions,
      { ladder: [...GLM_CODING_EFFORTS] },
    ),
  },
  {
    name: 'command-code',
    model: 'claude-sonnet-4-6',
    build: (messages) => buildCommandCodeRequest({ provider: 'command-code', model: 'claude-sonnet-4-6', messages } as GenerateOptions),
  },
  {
    name: 'kimi-code',
    model: 'kimi-for-coding',
    build: (messages) => buildKimiRequest({ provider: 'kimi-code', model: 'kimi-for-coding', messages } as GenerateOptions),
  },
  {
    name: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    build: (messages) => buildWorkbuddyRequest({ provider: 'workbuddy-subscription', model: 'deepseek-v4.1-flash', messages } as GenerateOptions),
  },
]

/** The messages array one built body carries. */
function wire(body: Record<string, unknown>): Wire[] {
  return (body.messages ?? []) as Wire[]
}

/** Every `tool_use` id in one built body. */
function callIds(messages: Wire[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') ids.push(String(block.id))
  }
  return ids
}

/** The wire's own pairing invariant. */
function violations(messages: Wire[]): string[] {
  const problems: string[] = []
  const open = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') open.add(String(block.id))
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        if (!open.has(id)) problems.push('result without an open call: ' + id)
        open.delete(id)
      }
    }
  }
  for (const id of open) problems.push('call left unanswered: ' + id)
  return problems
}

describe.each(LINES)('$name: unpaired tool calls never reach the wire', ({ build }) => {
  it('drops a tool call that was never answered', () => {
    const body = build([user('hi'), assistantCall('call_1'), user('go on')])
    expect(callIds(wire(body))).toEqual([])
    expect(violations(wire(body))).toEqual([])
    expect(wire(body).length).toBeGreaterThan(0)
  })

  it('keeps a call that has its result', () => {
    const body = build([user('hi'), assistantCall('call_1'), toolResult('call_1')])
    expect(callIds(wire(body))).toEqual(['call_1'])
    expect(violations(wire(body))).toEqual([])
  })

  it('drops a result whose call is gone', () => {
    const body = build([user('hi'), assistantCall('call_1'), toolResult('call_other')])
    expect(callIds(wire(body))).toEqual([])
    expect(violations(wire(body))).toEqual([])
  })
})
