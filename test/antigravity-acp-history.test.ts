/**
 * History projection and the prefix fingerprint that decides whether an ACP
 * session may be reused.
 *
 * The fingerprint is the load-bearing part: a false positive means the agent's
 * transcript and the harness's history disagree, which is a conversation the
 * user cannot audit. So every test that expects "continue" is paired with the
 * nearest thing that must force a cold replay.
 */
import { describe, expect, it } from 'vitest'
import { buildPrompt, canContinue, fingerprintMessages } from '../src/host/antigravity-acp/history.ts'
import type { Message } from '../src/host/common/llm-compat.ts'
import { NO_RESOLVED_IMAGES } from '../src/host/common/request-images.ts'

function optionsOf(messages: Message[]): never {
  return { provider: 'antigravity-acp', model: 'gemini-4-carbon', messages } as never
}

const USER: Message = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
const ANSWER: Message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }

describe('buildPrompt', () => {
  it('renders the whole history when no session exists yet', () => {
    const prompt = buildPrompt(optionsOf([USER, ANSWER]), NO_RESOLVED_IMAGES, 0)
    expect(prompt.blocks).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '[assistant]\nhi' },
    ])
    expect(prompt.coveredMessages).toBe(2)
  })

  it('renders only the messages a live session has not seen', () => {
    const prompt = buildPrompt(optionsOf([USER, ANSWER, { role: 'user', content: [{ type: 'text', text: 'again' }] }]), NO_RESOLVED_IMAGES, 2)
    expect(prompt.blocks).toEqual([{ type: 'text', text: 'again' }])
    expect(prompt.coveredMessages).toBe(3)
  })

  it('keeps reasoning out of the prompt and states a tool result as text', () => {
    const prompt = buildPrompt(optionsOf([
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'private trace' },
        { type: 'tool-call', id: 'c1' as never, name: 'read_file', arguments: '{"path":"a"}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'bytes' }] }] },
    ]), NO_RESOLVED_IMAGES, 0)
    const text = prompt.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(text).not.toContain('private trace')
    expect(text).toContain('[tool call] read_file')
    expect(text).toContain('[tool result] bytes')
  })
})

describe('fingerprintMessages', () => {
  it('ignores ids and sources, which the harness re-stamps every turn', () => {
    const a: Message = { id: 'one', role: 'user', content: [{ type: 'text', text: 'hello' }] }
    const b: Message = { id: 'two', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'tool' } }
    expect(fingerprintMessages([a], 0, 1)).toBe(fingerprintMessages([b], 0, 1))
  })

  it('changes when the text changes', () => {
    const a: Message = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    const b: Message = { role: 'user', content: [{ type: 'text', text: 'hello!' }] }
    expect(fingerprintMessages([a], 0, 1)).not.toBe(fingerprintMessages([b], 0, 1))
  })
})

describe('canContinue', () => {
  it('continues when the covered prefix is unchanged and new messages follow', () => {
    const messages = [USER, ANSWER, { role: 'user', content: [{ type: 'text', text: 'again' }] } as Message]
    const fingerprint = fingerprintMessages([USER, ANSWER], 0, 2)
    expect(canContinue(messages, 2, fingerprint)).toBe(true)
  })

  it('refuses when an earlier message was rewritten (a compaction)', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'summary' }] } as Message, ANSWER, USER]
    const fingerprint = fingerprintMessages([USER, ANSWER], 0, 2)
    expect(canContinue(messages, 2, fingerprint)).toBe(false)
  })

  it('refuses when nothing new was appended', () => {
    expect(canContinue([USER, ANSWER], 2, fingerprintMessages([USER, ANSWER], 0, 2))).toBe(false)
  })
})
