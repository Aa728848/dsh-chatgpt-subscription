import { describe, expect, it } from 'vitest'
import {
  buildResponsesRequest,
  closeStream,
  createStreamState,
  processResponsesStreamLine,
} from '../src/host/command-code/mapper.ts'
import { parseProviderModels } from '../src/host/command-code/client.ts'
import { wireForCatalogEntry, wireForModel } from '../src/host/command-code/types.ts'

describe('command code routing', () => {
  it('follows the endpoints the catalog publishes', () => {
    const [claude, gpt, other] = parseProviderModels({
      data: [
        { id: 'claude-sonnet-5', supported_endpoints: ['/v1/messages'] },
        { id: 'gpt-6-astra', supported_endpoints: ['/v1/responses'] },
        { id: 'some-open-model', supported_endpoints: ['/v1/chat/completions'] },
      ],
    })

    expect(wireForCatalogEntry(claude!)).toBe('anthropic')
    expect(wireForCatalogEntry(gpt!)).toBe('responses')
    expect(wireForCatalogEntry(other!)).toBe('openai')
  })

  it('falls back to the shipped table when the catalog says nothing', () => {
    const [entry] = parseProviderModels({ data: [{ id: 'gpt-6-astra' }] })

    expect(wireForCatalogEntry(entry!)).toBeUndefined()
    expect(wireForModel('gpt-6-astra')).toBe('openai')
    expect(wireForModel('claude-sonnet-5')).toBe('anthropic')
  })
})

/** One tool call, as DSH records it after the model asked for it. */
function toolHistory(): never {
  return {
    model: 'gpt-6-astra',
    system: 'be terse',
    reasoningEffort: 'high',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'call_1' },
      },
    ],
  } as never
}

describe('command code responses request', () => {
  it('sends a flat input list rather than messages', () => {
    const body = buildResponsesRequest(toolHistory())

    expect(body.messages).toBeUndefined()
    expect(body.instructions).toBe('be terse')
    expect(body.reasoning).toEqual({ effort: 'high' })
    const input = body.input as Array<Record<string, unknown>>
    expect(input.map(item => item.type ?? item.role)).toEqual(['user', 'function_call', 'function_call_output'])
  })

  it('carries the tool name and arguments, which the next turn needs', () => {
    // Chat Completions nests these under `function`; a builder that read the
    // top level would emit a call with neither, and the history would be unusable.
    const body = buildResponsesRequest(toolHistory())
    const input = body.input as Array<Record<string, unknown>>
    const call = input.find(item => item.type === 'function_call')

    expect(call).toMatchObject({ call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' })
  })
})

describe('command code responses stream', () => {
  it('assembles text and usage', () => {
    const state = createStreamState('responses')
    const send = (event: unknown) => processResponsesStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'response.output_text.delta', delta: 'hel' }),
      ...send({ type: 'response.output_text.delta', delta: 'lo' }),
      ...send({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } } } }),
      ...closeStream(state),
    ]

    const texts = out.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { text: string } }).block.text)
    expect(texts).toEqual(['hello'])
    const usage = out.find(chunk => chunk.type === 'usage') as { usage: Record<string, number> } | undefined
    expect(usage?.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 10 })
    expect(out.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('matches argument deltas by item id, not by call id', () => {
    // The two ids differ in practice: `item_id` names the output item and
    // `call_id` is the id the executor sees. Matching on the call id alone
    // silently dropped every argument and delivered an empty call.
    const state = createStreamState('responses')
    const send = (event: unknown) => processResponsesStreamLine('data: ' + JSON.stringify(event), state)
    const out = [
      ...send({ type: 'response.output_item.added', item_id: 'fc_1', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' } }),
      ...send({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' }),
      ...send({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a"}' }),
      ...send({ type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"path":"a"}' }),
      ...send({ type: 'response.completed', response: {} }),
      ...closeStream(state),
    ]

    const block = out.find(chunk => chunk.type === 'block-end') as { block: { type: string; name: string; arguments: string } } | undefined
    expect(block?.block).toMatchObject({ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' })
  })

  it('keeps two calls started in sequence distinguishable', () => {
    const state = createStreamState('responses')
    const send = (event: unknown) => processResponsesStreamLine('data: ' + JSON.stringify(event), state)
    const started: ReturnType<typeof send> = []
    started.push(...send({ type: 'response.output_item.added', item_id: 'fc_1', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' } }))
    started.push(...send({ type: 'response.output_item.added', item_id: 'fc_2', item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'write', arguments: '' } }))
    const out = [
      ...started,
      ...send({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"b":1}' }),
      ...closeStream(state),
    ]

    const calls = out
      .filter(chunk => chunk.type === 'block-end')
      .map(chunk => (chunk as { block: { type: string; name: string; arguments: string } }).block)
      .filter(block => block.type === 'tool-call')
    // The earlier call keeps its own empty arguments instead of being handed
    // the later call's.
    expect(calls.find(call => call.name === 'read')?.arguments).toBe('{}')
    expect(calls.find(call => call.name === 'write')?.arguments).toBe('{"b":1}')
  })
})