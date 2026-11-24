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
import {
  ACTIVE_REQUEST_HEADING,
  CURRENT_REQUEST_HEADING,
  REPLAY_ANCHOR_INSTRUCTION,
  REPLAY_ARCHIVE_HEADING,
  buildPrompt,
  canContinue,
  fingerprintMessages,
  fingerprintTools,
} from '../../../src/host/providers/antigravity-acp/history.ts'
import type { Message } from '../../../src/host/common/llm-compat.ts'
import { NO_RESOLVED_IMAGES } from '../../../src/host/common/request-images.ts'

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
      // A replay is a transcript, not a task list: it ends with the boundary
      // sentence so the newest request is not read as one more item in a queue...
      { type: 'text', text: REPLAY_ANCHOR_INSTRUCTION },
      // ...and with the request quoted verbatim, because "the LAST user message"
      // is not the request once the harness appends synthetic context after it.
      { type: 'text', text: `${CURRENT_REQUEST_HEADING}\nhello` },
    ])
    expect(prompt.coveredMessages).toBe(2)
  })

  it('does not put the boundary marker on a first prompt that already ends with its request', () => {
    const prompt = buildPrompt(optionsOf([USER]), NO_RESOLVED_IMAGES, 0)
    expect(prompt.blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('renders only the messages a live session has not seen', () => {
    const prompt = buildPrompt(optionsOf([USER, ANSWER, { role: 'user', content: [{ type: 'text', text: 'again' }] }]), NO_RESOLVED_IMAGES, 2)
    // An increment is not a replay: no boundary marker, because the agent is not
    // being handed a transcript it has to pick a request out of.
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

/**
 * A replay is a whole conversation handed to an agent that has never seen it. The
 * two defects reproduced on a real long session are covered here: the request
 * anchor pointing at synthetic context, and the transcript burying the request.
 */
describe('replay framing', () => {
  const HUMAN: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'A。记得把改进建议也写进 README。' }],
    source: { kind: 'user' },
  }
  const RECALL: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'recall: earlier you discussed option A' }],
    source: { kind: 'dsh-chatgpt-subscription' },
  }
  const TIME: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 2: 12:00' }],
    source: { kind: 'time-context' },
  }
  const SYSTEM = (text: string): Message => ({ role: 'system', content: [{ type: 'text', text }] })

  function textsOf(prompt: { blocks: Array<{ type: string; text?: string }> }): string[] {
    return prompt.blocks.flatMap((entry) => (entry.type === 'text' && entry.text !== undefined ? [entry.text] : []))
  }

  /** A history large enough that its tool traffic dwarfs the request it ends with. */
  function bulkyHistory(): Message[] {
    const messages: Message[] = [SYSTEM('replay instructions')]
    for (let turn = 0; turn < 4; turn += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `task ${turn} ${'u'.repeat(60_000)}` }], source: { kind: 'user' } })
      messages.push({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: `c${turn}` as never, name: 'read_file', arguments: `{"path":"${'a'.repeat(50_000)}"}` },
          { type: 'text', text: `answer ${turn}` },
        ],
      })
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: `c${turn}`, content: [{ type: 'text', text: 'r'.repeat(80_000) }] }],
        source: { kind: 'tool' },
      })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'A。' }], source: { kind: 'user' } })
    return messages
  }

  it('quotes the human request rather than the synthetic message that trails it', () => {
    const prompt = buildPrompt(optionsOf([USER, ANSWER, HUMAN, RECALL, TIME]), NO_RESOLVED_IMAGES, 0)
    // The synthetic tail is still part of the transcript, but it is not the
    // request: the agent that answers "Time sampled..." answers the wrong thing.
    expect(textsOf(prompt)).toContain(TIME.content[0]!.type === 'text' ? TIME.content[0]!.text : '')
    expect(prompt.blocks.at(-1)).toEqual({ type: 'text', text: `${CURRENT_REQUEST_HEADING}\n${'A。记得把改进建议也写进 README。'}` })
  })

  it('treats a message with no source kind as human', () => {
    const prompt = buildPrompt(optionsOf([USER, ANSWER, { role: 'user', content: [{ type: 'text', text: 'again' }] }]), NO_RESOLVED_IMAGES, 0)
    expect(prompt.blocks.at(-1)).toEqual({ type: 'text', text: `${CURRENT_REQUEST_HEADING}\nagain` })
  })

  it('replays one copy of the instructions instead of every earlier snapshot', () => {
    const prompt = buildPrompt(optionsOf([SYSTEM('first instructions'), SYSTEM('second instructions'), USER, ANSWER]), NO_RESOLVED_IMAGES, 0)
    const systems = textsOf(prompt).filter((text) => text.startsWith('[system]'))
    expect(systems).toEqual(['[system]\nsecond instructions'])
  })

  it('archives a replay too large to send verbatim', () => {
    const messages = bulkyHistory()
    const prompt = buildPrompt(optionsOf(messages), NO_RESOLVED_IMAGES, 0)
    const texts = textsOf(prompt)
    const joined = texts.join('\n')
    // The request survives, the finished tool traffic does not, and the archive
    // is bounded: that is what makes the request readable at all.
    expect(joined.length).toBeLessThan(100_000)
    expect(joined).not.toContain('r'.repeat(20))
    expect(joined).not.toContain('a'.repeat(20))
    expect(texts[0]).toBe('[system]\nreplay instructions')
    expect(texts[1]).toBe(`${ACTIVE_REQUEST_HEADING}\nA。`)
    expect(joined).toContain(REPLAY_ARCHIVE_HEADING)
    expect(joined).toContain(REPLAY_ANCHOR_INSTRUCTION)
    expect(texts.at(-1)).toBe(`${CURRENT_REQUEST_HEADING}\nA。`)
    // Newest first until the budget is spent, so the turn the request refers to
    // ("go with A" needs the assistant message just before it) is always kept.
    expect(joined).toContain('answer 3')
    expect(joined.indexOf(ACTIVE_REQUEST_HEADING)).toBeLessThan(joined.indexOf(REPLAY_ARCHIVE_HEADING))
    expect(prompt.coveredMessages).toBe(messages.length)
    expect(prompt.fingerprint).toBe(fingerprintMessages(messages, 0, messages.length))
  })

  it('carries the attachment of the replay request into the archive tail', () => {
    const messages = bulkyHistory()
    messages.push({
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'QUJD', attachment: { attachmentId: 'a1' } } as never,
        { type: 'text', text: 'look at this' },
      ],
      source: { kind: 'user' },
    })
    const prompt = buildPrompt(optionsOf(messages), NO_RESOLVED_IMAGES, 0)
    // The archive drops every older image; the one the turn is about has to
    // arrive with the request or the agent cannot answer about it.
    expect(prompt.blocks.at(-1)).toEqual({ type: 'image', mimeType: 'image/png', data: 'QUJD' })
    expect(textsOf(prompt).at(-1)).toBe(`${CURRENT_REQUEST_HEADING}\nlook at this`)
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

describe('fingerprintTools', () => {
  it('is stable for one catalogue and changes when a schema changes', () => {
    const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    expect(fingerprintTools(tools as never)).toBe(fingerprintTools(tools as never))
    const renamed = [{ ...tools[0]!, name: 'write_file' }]
    expect(fingerprintTools(renamed as never)).not.toBe(fingerprintTools(tools as never))
    const widened = [{ ...tools[0]!, parameters: { type: 'object', properties: {} } }]
    expect(fingerprintTools(widened as never)).not.toBe(fingerprintTools(tools as never))
  })

  it('does not depend on the order the harness lists tools in', () => {
    const a = { name: 'alpha', description: '', parameters: {} }
    const b = { name: 'beta', description: '', parameters: {} }
    expect(fingerprintTools([a, b] as never)).toBe(fingerprintTools([b, a] as never))
    expect(fingerprintTools(undefined)).toBe(fingerprintTools([]))
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
