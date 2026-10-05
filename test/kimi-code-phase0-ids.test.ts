import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  ToolCallIdNormalizer,
  buildOpenAIRequest,
  clampToolCallId,
  outboundReasoningKey,
  processOpenAIStreamLine,
  createStreamState,
  resetReasoningDialect,
} from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}`
}

describe('clampToolCallId', () => {
  it('truncates an over-long id to the 64 character cap', () => {
    expect(clampToolCallId('a'.repeat(100))).toBe('a'.repeat(64))
  })

  it('replaces characters the service rejects', () => {
    expect(clampToolCallId('call:1/2.3 4')).toBe('call_1_2_3_4')
  })

  it('is idempotent, so a sanitized id stays stable on replay', () => {
    const once = clampToolCallId('call:1/2.3 4')
    expect(clampToolCallId(once)).toBe(once)
  })

  it('keeps an id that is already within the allowlist unchanged', () => {
    expect(clampToolCallId('call_abc-123')).toBe('call_abc-123')
  })
})

describe('ToolCallIdNormalizer', () => {
  it('returns the same answer for the same input', () => {
    const ids = new ToolCallIdNormalizer()
    expect(ids.normalize('call_1')).toBe('call_1')
    expect(ids.normalize('call_1')).toBe('call_1')
  })

  it('keeps two ids distinct when truncation would collapse them', () => {
    const ids = new ToolCallIdNormalizer()
    const shared = 'x'.repeat(70)
    const first = ids.normalize(shared + 'a')
    const second = ids.normalize(shared + 'b')
    expect(first).not.toBe(second)
    expect(first).toHaveLength(64)
    expect(second.length).toBeLessThanOrEqual(64)
  })

  it('assigns a suffix without losing the 64 character cap', () => {
    const ids = new ToolCallIdNormalizer()
    const shared = 'y'.repeat(64)
    ids.normalize(shared)
    const second = ids.normalize(shared + 'tail')
    expect(second).toMatch(/_2$/)
    expect(second).toHaveLength(64)
  })

  it('falls back to a usable id when the input sanitizes to nothing', () => {
    const ids = new ToolCallIdNormalizer()
    expect(ids.normalize('***')).toBe('___')
    expect(clampToolCallId('')).toBe('')
  })

  it('survives many colliding ids without losing uniqueness', () => {
    const ids = new ToolCallIdNormalizer()
    const shared = 'z'.repeat(80)
    const assigned = Array.from({ length: 25 }, (_, index) => ids.normalize(shared + index))
    expect(new Set(assigned).size).toBe(25)
    for (const id of assigned) expect(id.length).toBeLessThanOrEqual(64)
  })
})

describe('tool-call ids on the wire', () => {
  it('sends the same sanitized id on the call and on its result', () => {
    const raw = 'call:with/slash'
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: raw, name: 'read', arguments: '{}' }],
        } as Message,
        {
          role: 'user',
          source: { kind: 'tool' },
          content: [{ type: 'tool-result', toolCallId: raw, content: [{ type: 'text', text: 'ok' }] }],
        } as Message,
      ],
    }))
    const messages = body['messages'] as Array<Record<string, unknown>>
    const assistant = messages.find((m) => m['role'] === 'assistant')!
    const call = (assistant['tool_calls'] as Array<{ id: string }>)[0]!
    const result = messages.find((m) => m['role'] === 'tool')!
    expect(call.id).toBe('call_with_slash')
    expect(result['tool_call_id']).toBe('call_with_slash')
  })
})

describe('reasoning key dialect', () => {
  it('defaults to the Kimi field before any response is seen', () => {
    resetReasoningDialect()
    expect(outboundReasoningKey()).toBe('reasoning_content')
  })

  it('reads reasoning_content and keeps it as the default', () => {
    resetReasoningDialect()
    const state = createStreamState('openai')
    processOpenAIStreamLine(sse({ choices: [{ delta: { reasoning_content: 'thought' } }] }), state)
    expect(outboundReasoningKey()).toBe('reasoning_content')
  })

  it('adapts to reasoning when the endpoint answers with it', () => {
    resetReasoningDialect()
    const state = createStreamState('openai')
    processOpenAIStreamLine(sse({ choices: [{ delta: { reasoning: 'thought' } }] }), state)
    expect(outboundReasoningKey()).toBe('reasoning')
  })

  it('adapts to reasoning_details on the gateway spelling', () => {
    resetReasoningDialect()
    const state = createStreamState('openai')
    processOpenAIStreamLine(sse({ choices: [{ delta: { reasoning_details: 'thought' } }] }), state)
    expect(outboundReasoningKey()).toBe('reasoning_details')
  })

  it('ignores a null placeholder rather than treating it as observed', () => {
    resetReasoningDialect()
    const state = createStreamState('openai')
    processOpenAIStreamLine(sse({ choices: [{ delta: { reasoning_content: null } }] }), state)
    expect(outboundReasoningKey()).toBe('reasoning_content')
  })

  it('keeps the last observed key across a response with no reasoning', () => {
    resetReasoningDialect()
    const state = createStreamState('openai')
    processOpenAIStreamLine(sse({ choices: [{ delta: { reasoning: 'thought' } }] }), state)
    processOpenAIStreamLine(sse({ choices: [{ delta: { content: 'plain' } }] }), state)
    expect(outboundReasoningKey()).toBe('reasoning')
  })
})