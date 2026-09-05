import { describe, expect, it } from 'vitest'
import { BlockAssembler, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildRequest, closeStream, createStreamState, processStreamLine } from '../src/host/antigravity/mapper.ts'
import { MODELS, ROUTING } from '../src/host/antigravity/types.ts'

const model = MODELS.find((entry) => entry.id === 'gemini-3.7-flash')!
const line = (value: unknown) => `data: ${JSON.stringify(value)}`
const frame = (parts: unknown[], rest = {}) => ({ response: { candidates: [{ content: { parts } }], ...rest } })

function assemble(chunks: StreamChunk[]): BlockAssembler {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler
}

function requestParts(assembler: BlockAssembler): Array<Record<string, unknown>> {
  const message = createAssistantMessage({
    content: assembler.blocks(),
    source: { provider: 'antigravity', model: model.id, replayState: assembler.replayState },
  })
  const request = buildRequest({
    provider: 'antigravity', model: model.id, messages: [message],
  } as GenerateOptions, model, 'project', 'gemini-3.7-flash-tiered', 'high')
  return (request.request as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0].parts
}

describe('Antigravity final usage and thought replay', () => {
  it('emits one final cumulative usage after late metadata, including cache and thinking tokens', () => {
    const state = createStreamState()
    const chunks = [
      ...processStreamLine(line(frame([{ thought: true, text: 'Thinking' }], {
        usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 1000, thoughtsTokenCount: 20 },
      })), state),
      ...processStreamLine(line({ response: {
        candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 50 },
      } }), state),
      ...processStreamLine(line({ response: { usageMetadata: { candidatesTokenCount: 80, totalTokenCount: 1300 } } }), state),
    ]
    expect(chunks.some((chunk) => chunk.type === 'usage' || chunk.type === 'finish')).toBe(false)
    chunks.push(...closeStream(state))
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([{
      type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 1000, outputTokens: 100, reasoningTokens: 20 },
    }])
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(assemble(chunks).usage?.outputTokens).toBe(100)
    expect(closeStream(state)).toEqual([])
  })

  it('reads outer-wrapper usage and derives output when only total and prompt are available', () => {
    const state = createStreamState()
    processStreamLine(line({
      response: { candidates: [{ finishReason: 'STOP' }] },
      usageMetadata: { promptTokenCount: 100, totalTokenCount: 145 },
    }), state)
    expect(assemble(closeStream(state)).usage).toEqual({ inputTokens: 100, outputTokens: 45 })
  })

  it('does not publish fabricated zero usage when upstream omitted counts', () => {
    const state = createStreamState()
    processStreamLine(line({ candidates: [{ finishReason: 'STOP' }] }), state)
    expect(assemble(closeStream(state)).usage).toBeUndefined()
  })

  it('ignores invalid counts and bounds cache hits by the total prompt', () => {
    const state = createStreamState()
    processStreamLine(line({ candidates: [{ finishReason: 'STOP' }], usageMetadata: {
      promptTokenCount: 10, cachedContentTokenCount: 20, candidatesTokenCount: -1, thoughtsTokenCount: 'bad',
    } }), state)
    expect(assemble(closeStream(state)).usage).toEqual({ inputTokens: 0, cacheReadTokens: 10, outputTokens: 0 })
  })

  it('retains signature-only parts and signed reasoning across a parallel tool-call round trip', () => {
    const state = createStreamState()
    const chunks: StreamChunk[] = []
    for (const part of [
      { thought: true, text: 'I will inspect the code.' },
      { text: '', thought_signature: 'reasoning-signature' },
      { functionCall: { id: 'call-one', name: 'run_code', args: { code: 'print(1)' } }, thoughtSignature: 'tool-signature' },
      { functionCall: { id: 'call-two', name: 'read_file', args: { path: 'src/main.ts' } } },
    ]) chunks.push(...processStreamLine(line(frame([part])), state))
    chunks.push(...processStreamLine(line({ response: { candidates: [{ finishReason: 'STOP' }] } }), state))
    chunks.push(...closeStream(state))
    const assembler = assemble(chunks)
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.blocks()[0]).toEqual({ type: 'reasoning', text: 'I will inspect the code.' })
    expect(assembler.replayState?.blocks).toHaveLength(3)
    expect(requestParts(assembler)).toEqual([
      { thought: true, text: 'I will inspect the code.' },
      { text: '', thoughtSignature: 'reasoning-signature' },
      { functionCall: { name: 'run_code', args: { code: 'print(1)' } }, thoughtSignature: 'tool-signature' },
      { functionCall: { name: 'read_file', args: { path: 'src/main.ts' } } },
    ])
  })

  it('preserves a final text signature arriving after STOP without adding visible text', () => {
    const state = createStreamState()
    const chunks = processStreamLine(line({ candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }), state)
    const signatureChunks = processStreamLine(line(frame([{ thoughtSignature: 'late-signature' }])), state)
    expect(signatureChunks).toEqual([])
    chunks.push(...processStreamLine('data: [DONE]', state))
    expect(requestParts(assemble(chunks))).toEqual([{ text: 'Done.' }, { thoughtSignature: 'late-signature' }])
    expect(closeStream(state)).toEqual([])
  })

  it('replays old per-block signatures and keeps unsigned reasoning distinct from answer text', () => {
    const options = {
      provider: 'antigravity', model: model.id,
      messages: [createAssistantMessage({
        content: [{ type: 'reasoning', text: 'Plan' }, { type: 'reasoning', text: 'Next' }, { type: 'text', text: 'Answer' }],
        source: { provider: 'antigravity', model: model.id, replayState: {
          response: { outputItems: [{ thinkingSignature: 'old-signature' }, {}, { textSignature: 'text-signature' }] },
        } },
      })],
    } as GenerateOptions
    const request = buildRequest(options, model, 'project', 'gemini-3.7-flash-tiered')
    expect((request.request as any).contents[0].parts).toEqual([
      { thought: true, text: 'Plan', thoughtSignature: 'old-signature' },
      { thought: true, text: 'Next' },
      { text: 'Answer', thoughtSignature: 'text-signature' },
    ])
  })

  it('keeps max-token truncation ahead of tool execution and aligns replay metadata with retained blocks', () => {
    const state = createStreamState()
    const chunks = processStreamLine(line({ candidates: [{
      content: { parts: [{ thought: true, text: 'Plan' }, { functionCall: { name: 'run_code', args: {} } }] },
      finishReason: 'MAX_TOKENS',
    }] }), state)
    chunks.push(...closeStream(state))
    const assembler = assemble(chunks)
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: 'Plan' }])
    expect(assembler.replayState?.blocks).toHaveLength(1)
  })

  it('does not turn a broken connection into a successful tool invocation', () => {
    const state = createStreamState()
    processStreamLine(line(frame([{ functionCall: { name: 'run_code', args: {} } }])), state)
    expect(() => closeStream(state)).toThrow('before its terminal response')
  })

  it('requests thought summaries for Gemini agent aliases, direct runtimes, and every configured thinking route', () => {
    for (const model of MODELS.filter((entry) => entry.id.startsWith('gemini-') && entry.reasoningEfforts)) {
      for (const runtime of Object.values(ROUTING[model.id].routing)) {
        const request = buildRequest({ provider: 'antigravity', model: model.id, messages: [] } as GenerateOptions,
          model, 'project', runtime, 'high')
        expect((request.request as any).generationConfig.thinkingConfig.includeThoughts, runtime).toBe(true)
      }
    }
    const request = buildRequest({ provider: 'antigravity', model: 'gemini-3-flash', messages: [] } as GenerateOptions,
      model, 'project', 'gemini-3-flash', 'high')
    expect((request.request as any).generationConfig.thinkingConfig.includeThoughts).toBe(true)
  })
})
