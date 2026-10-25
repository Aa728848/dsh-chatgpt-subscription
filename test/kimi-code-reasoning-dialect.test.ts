import { beforeEach, describe, expect, it } from 'vitest'
import { BlockAssembler, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '../src/host/common/llm-compat.ts'
import {
  buildOpenAIRequest,
  createStreamState,
  outboundReasoningKey,
  processOpenAIStreamLine,
  reasoningFragmentsOf,
  resetReasoningDialect,
} from '../src/host/kimi-code/mapper.ts'

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`

function options(messages: Message[]): GenerateOptions {
  return { model: 'k3', messages } as GenerateOptions
}

/** Feed deltas through the OpenAI stream and close it, returning every chunk. */
function stream(deltas: unknown[]): StreamChunk[] {
  const state = createStreamState('openai')
  const out: StreamChunk[] = []
  for (const delta of deltas) out.push(...processOpenAIStreamLine(frame({ choices: [{ delta }] }), state))
  out.push(...processOpenAIStreamLine('data: [DONE]', state))
  return out
}

/**
 * The same chunks through the REAL harness assembler, which is what decides
 * whether a replay envelope survives at all.
 */
function assemble(chunks: StreamChunk[]): {
  replay: unknown
  blocks: Array<{ type: string; text?: string }>
  message: Message
} {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const replay = assembler.replayState
  const message = createAssistantMessage({
    content: assembler.blocks(),
    source: {
      provider: 'kimi-code',
      model: 'k3',
      ...(replay === undefined ? {} : { replayState: replay }),
    },
  }) as unknown as Message
  return { replay, blocks: assembler.blocks() as Array<{ type: string; text?: string }>, message }
}

function reasoningText(chunks: StreamChunk[]): string {
  return chunks
    .flatMap((chunk) => (chunk.type === 'reasoning-delta' ? [chunk.text] : []))
    .join('')
}

function reasoningBlock(chunks: StreamChunk[]): unknown {
  return chunks
    .flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
    .find((block) => block.type === 'reasoning')
}

function replayStateOf(chunks: StreamChunk[]): unknown {
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  return finish !== undefined && finish.type === 'finish' ? finish.replayState : undefined
}

/** One assistant message carrying `text` as its reasoning, with `source`. */
function assistant(text: string, replayState?: unknown): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', text },
      { type: 'text', text: 'answer' },
    ],
    ...(replayState === undefined ? {} : { source: { kind: 'model', replayState } }),
  } as Message
}

function assistantEntry(body: Record<string, unknown>): Record<string, unknown> {
  return (body['messages'] as Array<Record<string, unknown>>)[0]!
}

beforeEach(() => {
  resetReasoningDialect()
})

describe('coexisting reasoning fields in one delta', () => {
  it('keeps every field of one delta, in wire order', () => {
    const chunks = stream([{ reasoning_content: 'A', reasoning: 'B' }])
    // An implementation that stops at the first match emits only 'A' here.
    expect(reasoningText(chunks)).toBe('AB')
    expect(reasoningBlock(chunks)).toMatchObject({ type: 'reasoning', text: 'AB' })
  })

  it('reports the source key and the form of each fragment', () => {
    expect(reasoningFragmentsOf({
      reasoning_content: 'A',
      reasoning_details: [{ type: 'summary', summary: 'S', index: 3 }],
      reasoning: 'B',
    })).toEqual([
      { key: 'reasoning_content', text: 'A' },
      { key: 'reasoning_details', form: 'summary', wireType: 'summary', index: 3, text: 'S' },
      { key: 'reasoning', text: 'B' },
    ])
  })

  it('keeps the learned dialect on the leading field of a multi-field delta', () => {
    stream([{ reasoning: 'B', reasoning_content: 'A' }])
    // The dialect still names the field the endpoint leads with: becoming
    // "chattier" must not change which key this route echoes back.
    expect(outboundReasoningKey()).toBe('reasoning_content')
  })

  it('still learns a bare-string reasoning_details, the older gateway spelling', () => {
    stream([{ reasoning_details: 'thought' }])
    expect(outboundReasoningKey()).toBe('reasoning_details')
  })
})

describe('official reasoning_details shapes', () => {
  it('renders a typed summary and replays its type and index', () => {
    const chunks = stream([{ reasoning_details: [{ type: 'summary', summary: 'S', index: 3 }] }])
    expect(reasoningText(chunks)).toBe('S')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('S', replayStateOf(chunks))])))
    expect(entry['reasoning_details']).toEqual([{ type: 'summary', summary: 'S', index: 3 }])
  })

  it('renders a summary with no type and defaults its index to the element position', () => {
    const chunks = stream([{ reasoning_details: [{ summary: 'S' }, { summary: 'T', index: 2 }] }])
    expect(reasoningText(chunks)).toBe('ST')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('ST', replayStateOf(chunks))])))
    // No `type` was on the wire for either element, so none is invented; the
    // index falls back to the element's position, as the official element
    // builder does with `record.index ?? position`.
    expect(entry['reasoning_details']).toEqual([{ summary: 'S', index: 0 }, { summary: 'T', index: 2 }])
  })

  it('keeps the wire array order and treats index as metadata only', () => {
    const chunks = stream([{ reasoning_details: [{ summary: 'B', index: 1 }, { summary: 'A', index: 0 }] }])
    // extractReasoningDetails pushes in array order and never sorts, so B comes
    // first even though its index is larger.
    expect(reasoningText(chunks)).toBe('BA')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('BA', replayStateOf(chunks))])))
    expect(entry['reasoning_details']).toEqual([{ summary: 'B', index: 1 }, { summary: 'A', index: 0 }])
  })

  it('keeps encrypted provider state through assembly and hands it back field by field', () => {
    const chunks = stream([{ reasoning_details: [{ type: 'encrypted', encrypted: 'opaque-blob', index: 4 }] }])
    // Opaque state is never text: nothing visible is emitted for it.
    expect(reasoningText(chunks)).toBe('')
    const { replay, blocks, message } = assemble(chunks)
    // The envelope survives assembly even though the only block has empty text,
    // and its block list still lines up with the emitted blocks.
    expect(replay).toBeDefined()
    expect((replay as { blocks: unknown[] }).blocks).toHaveLength(blocks.length)
    expect(blocks).toEqual([{ type: 'reasoning', text: '' }])
    const entry = assistantEntry(buildOpenAIRequest(options([message])))
    expect(entry['reasoning_details']).toEqual([{ type: 'encrypted', encrypted: 'opaque-blob', index: 4 }])
    // The payload rides in opaque state only, never in a visible text field.
    expect(entry['reasoning_content']).toBe('')
    expect(entry['content']).toBe('')
  })

  it('keeps the empty-text encrypted run from breaking text slicing', () => {
    const chunks = stream([{ reasoning_details: [
      { summary: 'A' },
      { type: 'encrypted', encrypted: 'blob', index: 1 },
      { summary: 'B', index: 2 },
    ] }])
    expect(reasoningText(chunks)).toBe('AB')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('AB', replayStateOf(chunks))])))
    expect(entry['reasoning_details']).toEqual([
      { summary: 'A', index: 0 },
      { type: 'encrypted', encrypted: 'blob', index: 1 },
      { summary: 'B', index: 2 },
    ])
  })

  it('keeps both payloads of a type-less element, and still never shows the blob', () => {
    const chunks = stream([{ reasoning_details: [{ summary: 'S', encrypted: 'secret-blob', index: 5 }] }])
    // The official two-step read yields the visible summary AND the opaque state
    // from one type-less record.
    expect(reasoningText(chunks)).toBe('S')
    expect(reasoningText(chunks)).not.toContain('secret-blob')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('S', replayStateOf(chunks))])))
    expect(entry['reasoning_details']).toEqual([
      { summary: 'S', index: 5 },
      { encrypted: 'secret-blob', index: 5 },
    ])
  })

  it('keeps an explicit type authoritative over a stray sibling payload', () => {
    const typedSummary = stream([{ reasoning_details: [{ type: 'summary', summary: 'S', encrypted: 'x' }] }])
    expect(reasoningText(typedSummary)).toBe('S')
    expect(assistantEntry(buildOpenAIRequest(options([assistant('S', replayStateOf(typedSummary))])))['reasoning_details'])
      .toEqual([{ type: 'summary', summary: 'S', index: 0 }])

    const typedEncrypted = stream([{ reasoning_details: [{ type: 'encrypted', summary: 'not-visible', encrypted: 'y' }] }])
    expect(reasoningText(typedEncrypted)).toBe('')
    expect(assistantEntry(buildOpenAIRequest(options([assistant('', replayStateOf(typedEncrypted))])))['reasoning_details'])
      .toEqual([{ type: 'encrypted', encrypted: 'y', index: 0 }])
  })

  it('keeps the reasoning.text and reasoning.summary compatibility shapes', () => {
    const textChunks = stream([{ reasoning_details: [{ type: 'reasoning.text', text: 'T' }] }])
    expect(reasoningText(textChunks)).toBe('T')
    expect(assistantEntry(buildOpenAIRequest(options([assistant('T', replayStateOf(textChunks))])))['reasoning_details'])
      .toEqual([{ type: 'reasoning.text', text: 'T', index: 0 }])

    const summaryChunks = stream([{ reasoning_details: [{ type: 'reasoning.summary', summary: 'S' }] }])
    expect(reasoningText(summaryChunks)).toBe('S')
    expect(assistantEntry(buildOpenAIRequest(options([assistant('S', replayStateOf(summaryChunks))])))['reasoning_details'])
      .toEqual([{ type: 'reasoning.summary', summary: 'S', index: 0 }])
  })

  it('ignores an unknown or payload-less element instead of treating it as text', () => {
    const chunks = stream([{ reasoning_details: [
      { type: 'vendor.extra', summary: 'not-body-text' },
      { type: 'encrypted' },
      { summary: 'S' },
    ] }])
    expect(reasoningText(chunks)).toBe('S')
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('S', replayStateOf(chunks))])))
    // The ignored elements contribute nothing; the surviving one keeps its
    // position (2) as its index.
    expect(entry['reasoning_details']).toEqual([{ summary: 'S', index: 2 }])
  })
})

describe('replaying history in the shape each fragment arrived in', () => {
  it('splits a block that mixed two string fields back onto both keys', () => {
    const chunks = stream([{ reasoning_content: 'A', reasoning: 'B' }])
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('AB', replayStateOf(chunks))])))
    expect(entry['reasoning_content']).toBe('A')
    expect(entry['reasoning']).toBe('B')
  })

  it('reassembles repeated fragments of the same key without crossing them', () => {
    const chunks = stream([
      { reasoning_content: 'A' },
      { reasoning: 'B' },
      { reasoning_content: 'C' },
      { reasoning: 'D' },
    ])
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('ABCD', replayStateOf(chunks))])))
    expect(entry['reasoning_content']).toBe('AC')
    expect(entry['reasoning']).toBe('BD')
  })

  it('replays a bare-string reasoning_details as a string and elements as an array', () => {
    const stringChunks = stream([{ reasoning_details: 'legacy-thought' }])
    const stringEntry = assistantEntry(buildOpenAIRequest(options([assistant('legacy-thought', replayStateOf(stringChunks))])))
    expect(stringEntry['reasoning_details']).toBe('legacy-thought')

    const arrayChunks = stream([{ reasoning_details: [{ summary: 'S1' }, { summary: 'S2' }] }])
    const arrayEntry = assistantEntry(buildOpenAIRequest(options([assistant('S1S2', replayStateOf(arrayChunks))])))
    expect(arrayEntry['reasoning_details']).toEqual([{ summary: 'S1', index: 0 }, { summary: 'S2', index: 1 }])
  })

  it('survives a JSON round trip of the replay envelope', () => {
    const chunks = stream([{ reasoning_details: [
      { summary: 'A' },
      { type: 'encrypted', encrypted: 'blob', index: 1 },
      { summary: 'B', index: 2 },
    ] }])
    const roundTripped = JSON.parse(JSON.stringify(replayStateOf(chunks))) as unknown
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('AB', roundTripped)])))
    expect(entry['reasoning_details']).toEqual([
      { summary: 'A', index: 0 },
      { type: 'encrypted', encrypted: 'blob', index: 1 },
      { summary: 'B', index: 2 },
    ])
  })

  it('falls back to the learned key instead of splitting on an unverifiable run', () => {
    const tampered = { response: null, blocks: [{ reasoning: [{ key: 'reasoning', length: 99 }] }] }
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('AB', tampered)])))
    // One conservative key: the mismatched run is abandoned whole rather than
    // split at a guessed boundary, and no other field is invented.
    expect(entry['reasoning_content']).toBe('AB')
    expect(entry['reasoning']).toBeUndefined()
  })

  it('sends one key for a message that carries no provenance at all', () => {
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('thinking')])))
    expect(entry['reasoning_content']).toBe('thinking')
    expect(entry['reasoning']).toBeUndefined()
  })

  it('keeps the reasoning field on a turn that carried none (Preserved Thinking)', () => {
    const chunks = stream([{ content: 'answer only' }])
    const entry = assistantEntry(buildOpenAIRequest(options([assistant('', replayStateOf(chunks))])))
    // Preserved Thinking requires the field even when there is no reasoning.
    expect(entry['reasoning_content']).toBe('')
  })
})
