import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { buildClaudeRequestBody, claudeBodyHasToolChanges } from '../src/host/claude/mapper.ts'
import { claudeBetas } from '../src/host/claude/client.ts'
import { INLINE_TOOLS_BETA } from '../src/host/claude/types.ts'
import { toolUpdateMode } from '../src/host/claude/adapter.ts'

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  ...extra,
})

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

const bodyFor = (options: Record<string, unknown>) => buildClaudeRequestBody(
  { provider: 'claude-subscription', model: 'claude-opus-5-5', messages: [], ...options } as unknown as GenerateOptions,
)

const blocksOf = (body: Record<string, unknown>, role: string): Record<string, unknown>[] => {
  const messages = (body['messages'] ?? []) as Record<string, unknown>[]
  return messages.filter((message) => message['role'] === role)
    .flatMap((message) => (message['content'] ?? []) as Record<string, unknown>[])
}

const wireTools = (body: Record<string, unknown>) => (body['tools'] ?? []) as Record<string, unknown>[]

/**
 * A tool change on this wire rides a `role: "system"` message, and the
 * declaration list at the head never changes. Both halves are load-bearing: the
 * head is the cached prefix, and the block is what the vendor reads as the
 * change.
 */
describe('claude tool changes ride the history, not the head', () => {
  afterEach(() => {
    delete process.env.DSH_CLAUDE_TOOL_UPDATE
  })

  it('declares the capability by default and honours the escape hatch', () => {
    // An id the shipped table does not know inherits the current-generation
    // template, which is the same rule the mid-conversation gate follows.
    expect(toolUpdateMode('claude-future-9')).toBe('in-history')

    process.env.DSH_CLAUDE_TOOL_UPDATE = '0'
    expect(toolUpdateMode('claude-future-9')).toBeUndefined()
  })

  it('adds the beta that licenses the blocks, and only when they are present', () => {
    expect(claudeBetas({ toolChanges: true })).toContain(INLINE_TOOLS_BETA)
    expect(claudeBetas({})).not.toContain(INLINE_TOOLS_BETA)
  })

  it('states an addition as a tool_addition block after a user turn', () => {
    const body = bodyFor({
      messages: [
        user('first'),
        { role: 'developer', content: [{ type: 'tool-addition', toolName: 'added' }] },
      ],
      tools: [tool('base'), tool('added', { deferLoading: true })],
    })

    const additions = blocksOf(body, 'system').filter((block) => block['type'] === 'tool_addition')
    expect(additions).toHaveLength(1)
    expect(additions[0]?.['tool']).toEqual({ type: 'tool_reference', name: 'added' })
    expect(claudeBodyHasToolChanges(body)).toBe(true)

    // The declaration itself stays in the request and stays out of the prefix.
    const added = wireTools(body).find((entry) => entry['name'] === 'added')
    expect(added?.['defer_loading']).toBe(true)
  })

  it('keeps a withdrawn tool declared and states the removal', () => {
    const body = bodyFor({
      messages: [
        user('first'),
        { role: 'developer', content: [{ type: 'tool-removal', toolName: 'withdrawn' }] },
      ],
      tools: [tool('base'), tool('withdrawn')],
    })

    const removals = blocksOf(body, 'system').filter((block) => block['type'] === 'tool_removal')
    expect(removals).toHaveLength(1)
    // Dropping the declaration would shorten the head and invalidate the prefix.
    expect(wireTools(body).map((entry) => entry['name'])).toContain('withdrawn')
  })

  it('falls back to a note when the vendor would refuse the position', () => {
    // The vendor accepts the system turn only right after a user turn and only
    // when it ends the list or an assistant turn follows. A user turn after it
    // is a 400, so the change travels as text instead.
    const body = bodyFor({
      messages: [
        user('first'),
        { role: 'developer', content: [{ type: 'tool-addition', toolName: 'added' }] },
        user('next'),
      ],
      tools: [tool('added', { deferLoading: true })],
    })

    expect(claudeBodyHasToolChanges(body)).toBe(false)
    const texts = blocksOf(body, 'user')
      .map((block) => String(block['text'] ?? ''))
      .join('\n')
    expect(texts).toContain('now available')
  })

  it('prepends the placeholder when every declaration is deferred', () => {
    const body = bodyFor({
      messages: [
        user('first'),
        { role: 'developer', content: [{ type: 'tool-addition', toolName: 'added' }] },
      ],
      tools: [tool('added', { deferLoading: true })],
    })

    // The vendor refuses a tool change on a request with no active declaration.
    expect(wireTools(body)[0]?.['name']).toBe('tool_update_placeholder')
    expect(wireTools(body)).toHaveLength(2)
  })
})
