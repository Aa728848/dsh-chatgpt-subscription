import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  clampToolCallId,
  closeStream,
  createStreamState,
  mapReasoningEffort,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  promptCacheKey,
  thinkingBudgetFor,
} from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] } as Message,
    ],
    ...overrides,
  } as GenerateOptions
}

describe('mapReasoningEffort', () => {
  it('maps the documented third-party effort vocabulary onto the three K3 levels', () => {
    // The service documents this mapping verbatim and answers anything outside
    // it with HTTP 400, so every accepted spelling must land on a real level.
    expect(mapReasoningEffort('low')).toBe('low')
    expect(mapReasoningEffort('minimum')).toBe('low')
    expect(mapReasoningEffort('light')).toBe('low')
    expect(mapReasoningEffort('high')).toBe('high')
    expect(mapReasoningEffort('medium')).toBe('high')
    expect(mapReasoningEffort('max')).toBe('max')
    expect(mapReasoningEffort('xhigh')).toBe('max')
    expect(mapReasoningEffort('ultra')).toBe('max')
  })

  it('maps every thinking-off spelling onto the disabled encoding', () => {
    expect(mapReasoningEffort('none')).toBe('none')
    expect(mapReasoningEffort('off')).toBe('none')
    expect(mapReasoningEffort('disabled')).toBe('none')
  })

  it('drops an unknown level rather than sending a value the service rejects', () => {
    expect(mapReasoningEffort('turbo')).toBeUndefined()
    expect(mapReasoningEffort(undefined)).toBeUndefined()
    expect(mapReasoningEffort('')).toBeUndefined()
  })
})

describe('buildOpenAIRequest', () => {
  it('sends reasoning_effort for a selected level', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'max' as never }))
    expect(body.reasoning_effort).toBe('max')
    // Preserved Thinking is on by default, so the thinking object rides along.
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'max', keep: 'all' })
  })

  it('encodes thinking off as the disabled thinking block', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'none' as never }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('never sends a temperature, which the service fixes per model', () => {
    const body = buildOpenAIRequest(options({ temperature: 0.2 }))
    expect(body.temperature).toBeUndefined()
  })

  it('uses max_completion_tokens rather than the legacy field', () => {
    const body = buildOpenAIRequest(options())
    expect(body.max_completion_tokens).toBeTypeOf('number')
    expect(body.max_tokens).toBeUndefined()
  })

  it('enables streaming with usage so the quota accounting is complete', () => {
    const body = buildOpenAIRequest(options())
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('replays reasoning_content on an assistant turn that also calls a tool', () => {
    // The service answers 400 "thinking is enabled but reasoning_content is
    // missing in assistant tool call message" without this field.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should read the file first.' },
            { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
          ],
        } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('I should read the file first.')
    expect(Array.isArray(assistant?.tool_calls)).toBe(true)
  })

  it('replays reasoning_content on a plain assistant turn too', () => {
    // Preserved Thinking (the official default) requires the field on every
    // assistant message that lacks it, not only on tool-call turns.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'answer' },
          ],
        } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((entry) => entry.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('thinking')
    expect(assistant?.content).toBe('answer')
  })

  it('carries a stable prompt cache key that identifies the conversation', () => {
    const first = buildOpenAIRequest(options())
    const second = buildOpenAIRequest(options())
    expect(first.prompt_cache_key).toBeTruthy()
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key)
    // A different conversation must not reuse the key.
    const other = buildOpenAIRequest(options({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Different question' }] } as Message],
    }))
    expect(other.prompt_cache_key).not.toBe(first.prompt_cache_key)
  })

  it('declares tools in the OpenAI function shape', () => {
    const body = buildOpenAIRequest(options({
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }] as never,
    }))
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    }])
  })
})

describe('buildAnthropicRequest', () => {
  it('sends a thinking budget for an enabled level', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'high' as never }))
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 })
  })

  it('sends a disabled thinking block for the none level', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'none' as never }))
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('drops temperature when a thinking budget is present, which the wire forbids', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'high' as never, temperature: 0.5 }))
    expect(body.temperature).toBeUndefined()
  })

  it('carries no thinking field when no level was chosen', () => {
    const body = buildAnthropicRequest(options())
    expect(body.thinking).toBeUndefined()
  })
})

describe('thinkingBudgetFor', () => {
  it('keeps the budget below max_tokens with room for the answer', () => {
    expect(thinkingBudgetFor('max', 32_768)).toBe(16_384)
    // A budget that cannot leave room for the answer is dropped rather than
    // sent invalid, because Anthropic requires it to stay below max_tokens.
    expect(thinkingBudgetFor('max', 2_000)).toBeUndefined()
  })

  it('has no budget when thinking is off', () => {
    expect(thinkingBudgetFor('none', 32_768)).toBeUndefined()
    expect(thinkingBudgetFor(undefined, 32_768)).toBeUndefined()
  })
})

describe('clampToolCallId', () => {
  it('caps an id at the 64 characters the service accepts', () => {
    const long = 'x'.repeat(80)
    expect(clampToolCallId(long)).toHaveLength(64)
    expect(clampToolCallId('short')).toBe('short')
  })
})

describe('promptCacheKey', () => {
  it('returns nothing for a conversation with no user turn', () => {
    expect(promptCacheKey({ model: 'k3', messages: [] } as unknown as GenerateOptions)).toBeUndefined()
  })
})

describe('OpenAI stream parsing', () => {
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`

  it('emits reasoning before text and finishes once', () => {
    const state = createStreamState('openai')
    const chunks = [
      ...processOpenAIStreamLine(frame({ choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }), state),
      ...processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), state),
      ...processOpenAIStreamLine('data: [DONE]', state),
    ]
    const kinds = chunks.map((chunk) => chunk.type)
    expect(kinds).toContain('reasoning-delta')
    expect(kinds).toContain('text-delta')
    expect(kinds).toContain('finish')
    // Reasoning must be streamed before the visible answer.
    expect(kinds.indexOf('reasoning-delta')).toBeLessThan(kinds.indexOf('text-delta'))
  })

  it('accumulates tool-call argument fragments across deltas', () => {
    const state = createStreamState('openai')
    processOpenAIStreamLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] }, finish_reason: null }],
    }), state)
    processOpenAIStreamLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: null }],
    }), state)
    const out = processOpenAIStreamLine(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), state)
    const block = out.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .find((entry) => entry.type === 'tool-call')
    expect(block).toMatchObject({ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' })
  })

  it('reads usage including cached tokens, and reports it when the stream closes', () => {
    const state = createStreamState('openai')
    state.finishReason = 'stop'
    processOpenAIStreamLine(frame({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    }), state)
    const chunks = closeStream(state)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
    })
  })

  it('raises a provider error for a mid-stream error frame', () => {
    const state = createStreamState('openai')
    expect(() => processOpenAIStreamLine(
      frame({ error: { message: 'upstream failed', type: 'server_error' } }),
      state,
    )).toThrow(/upstream failed/)
  })

  it('closes on the [DONE] sentinel', () => {
    const state = createStreamState('openai')
    const chunks = processOpenAIStreamLine('data: [DONE]', state)
    expect(state.done).toBe(true)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })
})

describe('Anthropic stream parsing', () => {
  it('turns a thinking block into a reasoning delta', () => {
    const state = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}', state)
    const chunks = processAnthropicStreamLine('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}', state)
    expect(chunks.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true)
  })

  it('accumulates a tool_use input across partial_json deltas', () => {
    const state = createStreamState('anthropic')
    const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`
    processAnthropicStreamLine(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } }), state)
    processAnthropicStreamLine(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }), state)
    processAnthropicStreamLine(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a"}' } }), state)
    const out = processAnthropicStreamLine(frame({ type: 'content_block_stop', index: 0 }), state)
    const block = out.flatMap((chunk) => (chunk.type === 'block-end' ? [chunk.block] : []))
      .find((entry) => entry.type === 'tool-call')
    expect(block).toMatchObject({ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' })
  })

  it('finishes on message_stop', () => {
    const state = createStreamState('anthropic')
    processAnthropicStreamLine('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}', state)
    const chunks = processAnthropicStreamLine('data: {"type":"message_stop"}', state)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
  })

  it('ignores a ping keepalive', () => {
    const state = createStreamState('anthropic')
    expect(processAnthropicStreamLine('data: {"type":"ping"}', state)).toEqual([])
  })

  it('reports the stop reason as a tool-call finish', () => {
    const state = createStreamState('anthropic')
    state.done = true
    state.finishReason = 'tool_use'
    const chunks = closeStream(state)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})