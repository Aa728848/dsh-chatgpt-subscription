import { describe, expect, it } from 'vitest'
import { cleanOrphanedToolCalls } from '../src/host/common/orphan-tool-calls.ts'

/**
 * The shared guard every Anthropic Messages line now runs before sending.
 *
 * The wire validates the tool message sequence: every `tool_result` must follow the
 * assistant turn that issued the matching `tool_use`, and every `tool_use` must be
 * answered. One unpaired block is a `400 invalid params` (MiniMax error code 2013)
 * that is not retryable, so the session is poisoned from there on.
 */

type Turn = { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }

/** A plain user turn. */
function user(...content: Array<Record<string, unknown>>): Turn {
  return { role: 'user', content }
}

/** An assistant turn made of the given blocks. */
function assistant(...content: Array<Record<string, unknown>>): Turn {
  return { role: 'assistant', content }
}

/** One `tool_use` block. */
function call(id: string): Record<string, unknown> {
  return { type: 'tool_use', id, name: 'read', input: {} }
}

/** One `tool_result` block. */
function result(id: string): Record<string, unknown> {
  return { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }
}

/** The same fold every mapper passes in: neighbouring same-role turns, empty ones dropped. */
function fold(entries: Turn[]): Turn[] {
  const merged: Turn[] = []
  for (const entry of entries) {
    if (entry.content.length === 0) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === entry.role) {
      last.content = [...last.content, ...entry.content]
      continue
    }
    merged.push({ role: entry.role, content: [...entry.content] })
  }
  return merged
}

/** Run the guard with the fold the lines use. */
function clean(messages: Turn[]): Turn[] {
  return cleanOrphanedToolCalls(messages, fold)
}

/** Every `tool_use` id in one message list. */
function callIds(messages: Turn[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') ids.push(String(block.id))
  }
  return ids
}

/** Every `tool_result` id in one message list. */
function resultIds(messages: Turn[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_result') ids.push(String(block.tool_use_id))
  }
  return ids
}

/** The wire's invariant, checked the way the server checks it. */
function violations(messages: Turn[]): string[] {
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

describe('cleanOrphanedToolCalls', () => {
  it('keeps a tool call that has its result', () => {
    const messages = clean([user({ type: 'text', text: 'hi' }), assistant(call('c1')), user(result('c1'))])
    expect(callIds(messages)).toEqual(['c1'])
    expect(resultIds(messages)).toEqual(['c1'])
    expect(violations(messages)).toEqual([])
  })

  it('drops a call that never got a result, keeping the turn text', () => {
    const messages = clean([
      user({ type: 'text', text: 'hi' }),
      assistant({ type: 'text', text: 'working' }, call('c1')),
      user({ type: 'text', text: 'go on' }),
    ])
    expect(callIds(messages)).toEqual([])
    expect(messages.some((message) => message.role === 'assistant')).toBe(true)
    expect(violations(messages)).toEqual([])
  })

  it('drops an assistant turn whose only block was the orphan call', () => {
    const messages = clean([user({ type: 'text', text: 'hi' }), assistant(call('c1')), user({ type: 'text', text: 'go on' })])
    expect(callIds(messages)).toEqual([])
    expect(messages.some((message) => message.role === 'assistant')).toBe(false)
  })

  it('drops a result that matches no call, and the call it orphaned', () => {
    const messages = clean([user({ type: 'text', text: 'hi' }), assistant(call('c1')), user(result('other'))])
    expect(callIds(messages)).toEqual([])
    expect(resultIds(messages)).toEqual([])
    expect(violations(messages)).toEqual([])
  })

  it('leaves a history that would empty out untouched', () => {
    // Cleaning must never turn a conversation into zero messages: that is a
    // different failure, and the server would reject it for a new reason.
    const messages = clean([assistant(call('c1'))])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toHaveLength(1)
  })

  it('keeps the later turns of a session whose middle turn was orphaned', () => {
    const messages = clean([
      user({ type: 'text', text: 'first' }),
      assistant(call('c1')),
      user({ type: 'text', text: 'second' }),
      assistant(call('c2')),
      user(result('c2')),
    ])
    expect(callIds(messages)).toEqual(['c2'])
    expect(resultIds(messages)).toEqual(['c2'])
  })

  it('keeps exactly the answered pair of a parallel batch', () => {
    const messages = clean([user({ type: 'text', text: 'hi' }), assistant(call('c1'), call('c2')), user(result('c1'))])
    expect(callIds(messages)).toEqual(['c1'])
    expect(resultIds(messages)).toEqual(['c1'])
  })

  it('never mutates the caller history', () => {
    const history = [user({ type: 'text', text: 'hi' }), assistant({ type: 'text', text: 't' }, call('c1')), user({ type: 'text', text: 'go on' })]
    const before = JSON.stringify(history)
    clean(history)
    expect(JSON.stringify(history)).toBe(before)
  })

  it('refolds through the caller own merge, so roles still alternate', () => {
    // Dropping the middle user turn makes two assistant turns adjacent; only the
    // caller's fold can know whether that is legal for its wire.
    const messages = clean([
      user({ type: 'text', text: 'a' }),
      assistant(call('c1')),
      user(result('c1')),
      assistant(call('c2')),
      user({ type: 'text', text: 'b' }),
    ])
    for (let index = 1; index < messages.length; index += 1) {
      expect(messages[index]!.role).not.toBe(messages[index - 1]!.role)
    }
  })

  it('asks the caller to refold rather than assuming its own merge', () => {
    let called = 0
    const guard = (entries: Turn[]): Turn[] => {
      called += 1
      return entries
    }
    cleanOrphanedToolCalls([user({ type: 'text', text: 'hi' }), assistant(call('c1')), user(result('c1'))], guard)
    expect(called).toBe(1)
  })
})
