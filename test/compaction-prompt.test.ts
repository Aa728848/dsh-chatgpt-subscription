import { describe, expect, it } from 'vitest'
import {
  COMPACTION_INSTRUCTION,
  PRIOR_CHECKPOINT_OPEN_TAG,
  SHIPPED_INSTRUCTION_OPENING,
  carriesShippedInstruction,
  installCompactionPrompt,
  replaceCompactionInstruction,
  type PromptChunk,
  type PromptMessage,
  type PromptStreamListener,
  type PromptStreamOptions,
} from '../src/host/compaction-prompt.ts'

/** The first line of the directive DSH's summarizer actually ships. */
const SHIPPED = [
  SHIPPED_INSTRUCTION_OPENING + ' Condense the conversation ABOVE into a structured checkpoint.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals]',
  '',
  'Rules:',
  '- Write concise English engineering prose.',
].join('\n')

function userMessage(text: string): PromptMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function compactionMessages(): PromptMessage[] {
  return [
    { role: 'system', content: [{ type: 'text', text: 'You are an AI assistant.' }] },
    userMessage('fix the failing test'),
    { role: 'assistant', content: [{ type: 'text', text: 'Looking into it.' }] },
    userMessage(SHIPPED),
  ]
}

const OK: PromptChunk = { type: 'finish' }

async function* once(): AsyncIterable<PromptChunk> {
  yield OK
}

interface Harness {
  readonly listener: () => PromptStreamListener
  readonly warnings: string[]
}

function harness(): Harness {
  let listener: PromptStreamListener | undefined
  const warnings: string[] = []
  installCompactionPrompt({
    on: (_event, registered) => {
      listener = registered
      return () => { listener = undefined }
    },
    logger: { warn: (message) => warnings.push(message) },
  })
  return {
    warnings,
    listener: () => {
      if (listener === undefined) throw new Error('no llm/stream listener was registered')
      return listener
    },
  }
}

describe('the replacement directive', () => {
  it('keeps the prior-checkpoint fold rule', () => {
    // Without this the next compaction restates the previous checkpoint and the
    // history grows a summary of a summary.
    expect(COMPACTION_INSTRUCTION).toContain(PRIOR_CHECKPOINT_OPEN_TAG)
    expect(COMPACTION_INSTRUCTION).toContain('PRIOR checkpoint')
  })

  it('asks for the conversation language instead of English prose', () => {
    expect(COMPACTION_INSTRUCTION).toContain('same language the conversation has been using')
    expect(COMPACTION_INSTRUCTION).not.toContain('concise English engineering prose')
  })

  it('does not impose fixed section headings', () => {
    expect(COMPACTION_INSTRUCTION).toContain('Do not impose rigid section headings')
    expect(COMPACTION_INSTRUCTION).not.toContain('## Primary Request and Intent')
  })

  it('asks for returned values, not just the commands', () => {
    expect(COMPACTION_INSTRUCTION).toContain('the RESULTS themselves, not just the commands')
    expect(COMPACTION_INSTRUCTION).toContain('the concrete values returned')
  })
})

describe('splicing it into a request', () => {
  it('recognizes the shipped directive by its opening line', () => {
    expect(carriesShippedInstruction(userMessage(SHIPPED))).toBe(true)
    expect(carriesShippedInstruction(userMessage('just a question'))).toBe(false)
    expect(carriesShippedInstruction({ role: 'assistant', content: [{ type: 'text', text: SHIPPED }] })).toBe(false)
  })

  it('replaces the directive and leaves every earlier message untouched', () => {
    const messages = compactionMessages()
    const next = replaceCompactionInstruction(messages)
    expect(next).toHaveLength(messages.length)
    // Identity, not deep equality: the cache argument for splicing the LAST
    // message only works if every earlier message is the same object.
    expect(next[0]).toBe(messages[0])
    expect(next[1]).toBe(messages[1])
    expect(next[2]).toBe(messages[2])
    expect(next[3]).not.toBe(messages[3])
    expect((next[3]!.content![0] as { text: string }).text).toBe(COMPACTION_INSTRUCTION)
  })

  it('returns the input array when no shipped directive is present', () => {
    const messages = [userMessage('hello'), userMessage('world')]
    expect(replaceCompactionInstruction(messages)).toBe(messages)
  })

  it('leaves a harness that reworded its opening line alone', () => {
    const messages = [userMessage('Condense the conversation above.')]
    expect(replaceCompactionInstruction(messages)).toBe(messages)
  })
})

describe('the llm/stream listener', () => {
  it('rewrites a compaction request in place and forwards', async () => {
    const { listener } = harness()
    const options: PromptStreamOptions = { purpose: 'compaction', messages: compactionMessages() }
    const seen: PromptChunk[] = []
    for await (const chunk of listener()(options, once)) seen.push(chunk)
    expect(seen).toEqual([OK])
    expect((options.messages![3]!.content![0] as { text: string }).text).toBe(COMPACTION_INSTRUCTION)
  })

  it('ignores a conversation turn', async () => {
    const { listener } = harness()
    const messages = compactionMessages()
    const options: PromptStreamOptions = { messages }
    for await (const _chunk of listener()(options, once)) { /* drain */ }
    expect(options.messages).toBe(messages)
    expect((options.messages![3]!.content![0] as { text: string }).text).toBe(SHIPPED)
  })

  it('keeps the shipped directive when the request options are frozen', async () => {
    const { listener, warnings } = harness()
    const messages = compactionMessages()
    const options: PromptStreamOptions = Object.freeze({ purpose: 'compaction', messages })
    for await (const _chunk of listener()(options, once)) { /* drain */ }
    expect((messages[3]!.content![0] as { text: string }).text).toBe(SHIPPED)
    expect(warnings.join('\n')).toContain('frozen')
  })

  it('does not splice the same request twice', async () => {
    const { listener } = harness()
    const options: PromptStreamOptions = { purpose: 'compaction', messages: compactionMessages() }
    const registered = listener()
    for await (const _chunk of registered(options, once)) { /* drain */ }
    const afterFirst = (options.messages![3]!.content![0] as { text: string }).text
    for await (const _chunk of registered(options, once)) { /* drain */ }
    expect((options.messages![3]!.content![0] as { text: string }).text).toBe(afterFirst)
  })
})
