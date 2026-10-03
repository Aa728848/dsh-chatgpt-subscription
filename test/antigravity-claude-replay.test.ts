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
