import { describe, expect, it } from 'vitest'
import { BlockAssembler, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { buildRequest, closeStream, createStreamState, processStreamLine } from '../src/host/antigravity/mapper.ts'
import { normalizeGenerateOptions } from '../src/host/common/llm-compat.ts'
import { MODELS } from '../src/host/antigravity/types.ts'

const ids = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6']
function replay(id: string, wireParts: Record<string, unknown>[], sourceModel = id) {
  const state = createStreamState()
  const assembler = new BlockAssembler()
  for (const part of wireParts) {
    for (const chunk of processStreamLine('data: ' + JSON.stringify({ candidates: [{ content: { parts: [part] } }] }), state)) assembler.push(chunk)
  }
  for (const chunk of processStreamLine('data: ' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }), state)) assembler.push(chunk)
  for (const chunk of closeStream(state)) assembler.push(chunk)
  const message = createAssistantMessage({ content: assembler.blocks(), source: {
    provider: 'antigravity', model: sourceModel, replayState: assembler.replayState,
  } })
  const request = buildRequest(normalizeGenerateOptions({ provider: 'antigravity', model: id, messages: [message] }),
    MODELS.find(m => m.id === id)!, 'project', id)
  return (request.request as any).contents[0]?.parts ?? []
}

describe('Claude thinking signatures through Antigravity', () => {
  it.each(ids)('coalesces unsigned SSE text fragments before replay to %s', id => {
    const pieces = Array.from({ length: 385 }, (_, i) => ({ text: 'chunk ' + i + ' ' }))
    const text = pieces.map(p => p.text).join('')
    expect(replay(id, pieces)).toEqual([{ text }])
    expect(replay(id, [{ text }])).toEqual(replay(id, pieces))
  })

  it('does not merge text across signed parts or tool calls', () => {
    const call = { functionCall: { id: 'call-1', name: 'read', args: {} } }
    expect(replay(ids[0], [
      { text: 'a' }, { text: 'b' }, { text: 'signed', thoughtSignature: 'sig' },
      { text: 'c' }, { text: 'd' }, call, { text: 'e' }, { text: 'f' },
    ])).toEqual([{ text: 'ab' }, { text: 'signed', thoughtSignature: 'sig' }, { text: 'cd' }, call, { text: 'ef' }])
  })

  it('preserves opaque text metadata and does not mutate replay history', () => {
    const id = ids[0]
    const parts = [{ text: 'a' }, { text: 'b' }, { text: 'opaque', custom: 1 }, { text: 'c' }, { text: 'd' }]
    const message = createAssistantMessage({ content: [{ type: 'text', text: 'abopaquecd' }],
      source: { provider: 'antigravity', model: id, replayState: { blocks: [{ parts }] } } })
    const before = JSON.stringify(message)
    const request = buildRequest(normalizeGenerateOptions({ provider: 'antigravity', model: id, messages: [message] }),
      MODELS.find(m => m.id === id)!, 'project', id)
    expect((request.request as any).contents[0].parts).toEqual([{ text: 'ab' }, { text: 'opaque', custom: 1 }, { text: 'cd' }])
    expect(JSON.stringify(message)).toBe(before)
  })

  it('keeps Gemini replay part boundaries unchanged around a signature', () => {
    // PRESERVED INTENT: Gemini must not get Claude's thinking/signature pairing,
    // so a signature-only part still stands alone on the wire and is never
    // absorbed into a neighbouring text part. Only the adjacent pure-text pair
    // merges; the signed boundary is untouched.
    const parts = [{ text: 'a' }, { text: 'b' }, { text: '', thoughtSignature: 'sig' }]
    expect(replay('gemini-3.8-flash', parts)).toEqual([{ text: 'ab' }, { text: '', thoughtSignature: 'sig' }])
  })

  it('merges unsigned Gemini text deltas that Claude already merges', () => {
    // The regression this file guards: both dialects now collapse a run of
    // unsigned text deltas, so the two replay paths agree on that much and only
    // Claude adds signature pairing on top.
    const pieces = Array.from({ length: 385 }, (_, i) => ({ text: 'chunk ' + i + ' ' }))
    const text = pieces.map(p => p.text).join('')
    expect(replay('gemini-3.8-flash', pieces)).toEqual([{ text }])
    expect(replay('gemini-3.8-flash', [{ text }])).toEqual(replay('gemini-3.8-flash', pieces))
  })

  it('leaves Gemini thinking parts alone where Claude pairs and discards them', () => {
    const frames = [
      { thought: true, text: 'Plan ' }, { thought: true, text: 'carefully.' },
      { text: '', thought_signature: 'native-signature' }, { text: 'Answer' },
    ]
    // Gemini: no pairing, no discard, no merge of thought parts.
    expect(replay('gemini-3.8-flash', frames)).toEqual([
      { thought: true, text: 'Plan ' }, { thought: true, text: 'carefully.' },
      { text: '', thoughtSignature: 'native-signature' }, { text: 'Answer' },
    ])
    // Claude: the same frames collapse into one signed thinking block.
    expect(replay(ids[0], frames)).toEqual([
      { thought: true, text: 'Plan carefully.', thoughtSignature: 'native-signature' }, { text: 'Answer' },
    ])
  })

  it.each(ids)('replays %s text identically before and after the merge change', id => {
    // REGRESSION GUARD for the Claude path. These expectations were captured
    // from the implementation as it stood BEFORE the Gemini merge was added, so
    // any drift in Claude's outbound parts shows up here.
    expect(replay(id, [{ text: 'a' }, { text: 'b' }, { text: 'signed', thoughtSignature: 'sig' }, { text: 'c' }, { text: 'd' }]))
      .toEqual([{ text: 'ab' }, { text: 'signed', thoughtSignature: 'sig' }, { text: 'cd' }])
    expect(replay(id, [{ text: 'a' }, { text: '', thoughtSignature: 's1' }, { text: 'b' }]))
      .toEqual([{ text: 'a' }, { text: '', thoughtSignature: 's1' }, { text: 'b' }])
    expect(replay(id, [{ text: 'Done.' }, { thoughtSignature: 'late-signature' }]))
      .toEqual([{ text: 'Done.' }, { thoughtSignature: 'late-signature' }])
    // The unsigned thinking part is dropped before the merge runs, so the two
    // text runs on either side of it become adjacent and collapse together.
    expect(replay(id, [{ text: 'a' }, { thought: true, text: 'Unsigned' }, { text: 'b' }, { text: 'c' }]))
      .toEqual([{ text: 'abc' }])
    expect(replay(id, [{ thought: true, text: 'First', thoughtSignature: 'sig1' },
      { thought: true, text: 'Second', thoughtSignature: 'sig2' }, { text: 'Done' }]))
      .toEqual([{ thought: true, text: 'First', thoughtSignature: 'sig1' },
        { thought: true, text: 'Second', thoughtSignature: 'sig2' }, { text: 'Done' }])
  })

  it.each(ids)('attaches a separate signature to streamed thinking for %s', id => {
    expect(replay(id, [
      { thought: true, text: 'Plan ' }, { thought: true, text: 'carefully.' },
      { text: '', thought_signature: 'native-signature' }, { text: 'Answer' },
    ])).toEqual([{ thought: true, text: 'Plan carefully.', thoughtSignature: 'native-signature' }, { text: 'Answer' }])
  })
  it.each(ids)('drops unsigned thinking but preserves text and tool calls for %s', id => {
    const call = { functionCall: { id: 'call-1', name: 'read', args: {} }, thoughtSignature: 'tool-signature' }
    expect(replay(id, [{ text: 'Checking' }, { thought: true, text: 'Unsigned' }, call])).toEqual([{ text: 'Checking' }, call])
  })
  it('keeps independently signed thinking boundaries', () => {
    const parts = [
      { thought: true, text: 'First', thoughtSignature: 'sig1' },
      { thought: true, text: 'Second', thoughtSignature: 'sig2' }, { text: 'Done' },
    ]
    expect(replay(ids[0], parts)).toEqual(parts)
  })
  it('does not reuse Gemini thinking signatures after switching to Claude', () => {
    expect(replay(ids[0], [{ thought: true, text: 'Plan', thoughtSignature: 'gemini-sig' }, { text: 'Answer' }], 'gemini-3.8-flash'))
      .toEqual([{ text: 'Answer' }])
  })
  it('omits legacy unsigned reasoning without changing visible history', () => {
    const id = ids[0]
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'Old unsigned thought' }, { type: 'text', text: 'Answer' }],
      source: { provider: 'antigravity', model: id } })
    const request = buildRequest(normalizeGenerateOptions({ provider: 'antigravity', model: id, messages: [message] }),
      MODELS.find(m => m.id === id)!, 'project', id)
    expect((request.request as any).contents[0].parts).toEqual([{ text: 'Answer' }])
  })
})
