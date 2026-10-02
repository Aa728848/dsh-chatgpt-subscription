import { describe, expect, it } from 'vitest'
import { buildResponsesRequest } from '../src/host/command-code/mapper.ts'
import { closeStream, createStreamState, processResponsesStreamLine } from '../src/host/command-code/mapper.ts'
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
    // A GPT model with no published route is not silently moved onto a route
    // nobody vouched for; the shipped table decides, and it is Chat Completions.
    expect(wireForModel('gpt-6-astra')).toBe('openai')
    expect(wireForModel('claude-sonnet-5')).toBe('anthropic')
  })
})

describe('command code responses wire', () => {
  const options = {
    provider: 'command-code',
    model: 'gpt-6-astra',
    system: 'be terse',
    reasoningEffort: 'high',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }],
        // A tool result is recognized by its provenance, not by its shape.
        source: { kind: 'tool', callId: 'call_1' },
      },
    ],
  } as never

  it('sends a flat input list rather than messages', () => {
    const body = buildResponsesRequest(options)

    expect(body.messages).toBeUndefined()
    expect(body.instructions).toBe('be terse')
    expect(body.reasoning).toEqual({ effort: 'high' })
    const input = body.input as Array<Record<string, unknown>>
    expect(input.map(item => item.type ?? item.role)).toEqual(['user', 'function_call', 'function_call_output'])
  })
})

describe('command code responses stream', () => {
  it('turns responses events into text and tool blocks', () => {
    const state = createStreamState('responses')
    const send = (event: unknown): ReturnType<typeof processResponsesStreamLine> =>
      processResponsesStreamLine('data: ' + JSON.stringify(event), state)

    const out = [
      ...send({ type: 'response.output_text.delta', delta: 'hel' }),
      ...send({ type: 'response.output_text.delta', delta: 'lo' }),
      ...send({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } } } }),
      ...closeStream(state),
    ]

    const texts = out.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { text: string } }).block.text)
    expect(texts).toEqual(['hello'])
    const usage = out.find(chunk => chunk.type === 'usage') as { usage: { inputTokens: number; cacheReadTokens?: number } } | undefined
    // Cached input is reported separately, so it is not double-counted.
    expect(usage?.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 10 })
    expect(out.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})