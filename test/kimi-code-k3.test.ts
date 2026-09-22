import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  MAX_MESSAGE_BODY_BYTES,
  MAX_STOP_SEQUENCE_BYTES,
  MAX_STOP_SEQUENCES,
  assertRequestBodyFits,
  buildAnthropicRequest,
  buildOpenAIRequest,
  closeStream,
  createStreamState,
  estimatedInputTokens,
  getCacheStats,
  preserveThinkingEnabled,
  processOpenAIStreamLine,
  resetCacheStats,
  stopSequences,
} from '../src/host/kimi-code/mapper.ts'
import {
  CONTEXT_HEADROOM_TOKENS,
  clampOutputToContext,
  maxOutputTokensFor,
} from '../src/host/kimi-code/types.ts'
import { KIMI_CODE_MODELS } from '../src/host/kimi-code/model-catalog.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

/** An assistant turn with reasoning but no tool call. */
function assistantWithReasoning(): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'weighing the options' },
      { type: 'text', text: 'the answer' },
    ],
  } as Message
}

afterEach(() => {
  resetCacheStats()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('reasoning_content completeness', () => {
  it('writes reasoning_content on a plain assistant turn, not only tool calls', () => {
    // Preserved Thinking requires the field on every assistant message that
    // lacks it; the documented 400 names "assistant tool call message", but the
    // official client's keep=all rule covers ordinary turns too.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        assistantWithReasoning(),
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('weighing the options')
    expect(assistant?.content).toBe('the answer')
  })

  it('writes an empty reasoning_content when a turn produced none', () => {
    // An empty string is what the service asks for; omitting the key is the
    // documented failure.
    const body = buildOpenAIRequest(options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        { role: 'assistant', content: [{ type: 'text', text: 'plain' }] } as Message,
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant')
    expect(assistant).toHaveProperty('reasoning_content')
    expect(assistant?.reasoning_content).toBe('')
  })

  it('omits reasoning_content entirely when thinking is disabled', () => {
    const body = buildOpenAIRequest(options({
      reasoningEffort: 'none' as never,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message,
        assistantWithReasoning(),
      ],
    }))
    const assistant = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })
})

describe('preserveThinkingEnabled', () => {
  it('defaults to on, matching the official CLI', () => {
    expect(preserveThinkingEnabled({})).toBe(true)
  })

  it('honours every documented off spelling', () => {
    for (const value of ['0', 'false', 'no', 'off', 'none', 'FALSE', ' Off ']) {
      expect(preserveThinkingEnabled({ DSH_KIMI_CODE_PRESERVE_THINKING: value })).toBe(false)
    }
  })

  it('keeps it on for any other value', () => {
    expect(preserveThinkingEnabled({ DSH_KIMI_CODE_PRESERVE_THINKING: '1' })).toBe(true)
  })
})

describe('preserved thinking on the wire', () => {
  it('sends thinking.keep=all on the OpenAI wire when enabled', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'high' as never }), undefined, true)
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking).toEqual({ type: 'enabled', effort: 'high', keep: 'all' })
  })

  it('omits the thinking object when the feature is off', () => {
    const body = buildOpenAIRequest(options({ reasoningEffort: 'high' as never }), undefined, false)
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking).toBeUndefined()
  })

  it('keeps the Anthropic thinking block to its standard shape', () => {
    // `keep` is a Kimi extension on the OpenAI-compatible surface; the Messages
    // wire gets the documented budget form only.
    const body = buildAnthropicRequest(options({ reasoningEffort: 'high' as never }))
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 })
  })

  it('still disables thinking outright for the none level', () => {
    const body = buildAnthropicRequest(options({ reasoningEffort: 'none' as never }))
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('carries no thinking field when no level was chosen', () => {
    expect(buildAnthropicRequest(options()).thinking).toBeUndefined()
  })
})

describe('maxOutputTokensFor', () => {
  it('tracks the context window instead of a fixed 32K ceiling', () => {
    // reasoning_content is billed as output, so a fixed cap truncates a long
    // max-effort turn; the official client caps at the window.
    const cap = maxOutputTokensFor('k3', 262_144)
    expect(cap).toBe(262_144 - CONTEXT_HEADROOM_TOKENS)
    expect(cap).toBeGreaterThan(32_768)
  })

  it('never asks for less than the model declares', () => {
    // A tiny context window cannot starve the answer below the declared floor.
    const cap = maxOutputTokensFor('k3', 8_192)
    expect(cap).toBe(32_768)
  })

  it('falls back to the registry window when none is supplied', () => {
    const declared = KIMI_CODE_MODELS.find((model) => model.id === 'k3')!
    expect(maxOutputTokensFor('k3')).toBe(declared.contextWindow - CONTEXT_HEADROOM_TOKENS)
  })

  it('handles an unknown model without throwing', () => {
    expect(maxOutputTokensFor('mystery', 100_000)).toBe(100_000 - CONTEXT_HEADROOM_TOKENS)
  })
})

describe('clampOutputToContext', () => {
  it('reduces the cap so prompt plus output fit the window', () => {
    expect(clampOutputToContext(200_000, 262_144, 100_000)).toBe(158_048)
  })

  it('leaves the cap alone when the prompt size is unknown', () => {
    // Guessing low would truncate reasoning; the service is the authority.
    expect(clampOutputToContext(200_000, 262_144, undefined)).toBe(200_000)
  })

  it('keeps a workable cap when the prompt already fills the window', () => {
    const capped = clampOutputToContext(200_000, 262_144, 300_000)
    expect(capped).toBe(CONTEXT_HEADROOM_TOKENS)
  })
})

describe('stopSequences', () => {
  it('accepts what the service accepts', () => {
    expect(stopSequences(['a', 'b'])).toEqual(['a', 'b'])
    expect(stopSequences(undefined)).toEqual([])
  })

  it('truncates to the documented maximum of five', () => {
    expect(stopSequences(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(MAX_STOP_SEQUENCES)
  })

  it('drops a sequence over 32 bytes rather than truncating it', () => {
    // A shortened stop string would halt generation at the wrong place, which
    // silently changes the answer.
    const long = 'x'.repeat(MAX_STOP_SEQUENCE_BYTES + 1)
    expect(stopSequences([long, 'ok'])).toEqual(['ok'])
  })

  it('counts bytes, not characters, for a multibyte sequence', () => {
    // 11 CJK characters are 33 UTF-8 bytes, over the documented bound.
    expect(stopSequences(['一'.repeat(11)])).toEqual([])
    expect(stopSequences(['一'.repeat(10)])).toHaveLength(1)
  })

  it('drops an empty sequence', () => {
    expect(stopSequences(['', 'ok'])).toEqual(['ok'])
  })
})

describe('estimatedInputTokens', () => {
  it('estimates from the serialized prompt including tools', () => {
    const withTools = estimatedInputTokens(options({
      system: 'x'.repeat(400),
      tools: [{ name: 'read', description: 'd'.repeat(400), parameters: { type: 'object', properties: {} } }] as never,
    }))
    const without = estimatedInputTokens(options())
    expect(withTools!).toBeGreaterThan(without!)
  })

  it('returns nothing for a request with no content to measure', () => {
    expect(estimatedInputTokens({ model: 'k3', messages: [] } as unknown as GenerateOptions)).toBeUndefined()
  })
})

describe('assertRequestBodyFits', () => {
  it('accepts a body within the documented 2 MB ceiling', () => {
    expect(() => assertRequestBodyFits({ model: 'k3', messages: [] })).not.toThrow()
  })

  it('refuses an oversized body with the actual remedy', () => {
    // The service's own message is "total message size N exceeds limit 2097152",
    // which names no fix; this one does, and avoids the wasted round trip.
    const huge = { model: 'k3', padding: 'x'.repeat(MAX_MESSAGE_BODY_BYTES + 10) }
    expect(() => assertRequestBodyFits(huge)).toThrow(/compact/i)
    try {
      assertRequestBodyFits(huge)
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PROVIDER_ERROR')
    }
  })
})

describe('cache statistics', () => {
  it('reports nothing before any request reported usage', () => {
    expect(getCacheStats().requests).toBe(0)
    expect(getCacheStats().hitRatio).toBeNull()
  })

  it('accumulates cached and fresh tokens into a hit ratio', () => {
    const state = createStreamState('openai')
    state.sawUsage = true
    state.inputTokens = 250
    state.cacheReadTokens = 750
    state.outputTokens = 40
    closeStream(state)

    const stats = getCacheStats()
    expect(stats.requests).toBe(1)
    expect(stats.cachedTokens).toBe(750)
    expect(stats.freshTokens).toBe(250)
    expect(stats.outputTokens).toBe(40)
    expect(stats.hitRatio).toBeCloseTo(0.75)
  })

  it('ignores a stream that never reported usage', () => {
    const state = createStreamState('openai')
    state.finishReason = 'stop'
    closeStream(state)
    expect(getCacheStats().requests).toBe(0)
  })

  it('tracks a real cache read reported by the service', () => {
    const state = createStreamState('openai')
    state.finishReason = 'stop'
    processOpenAIStreamLine(
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":900}}}',
      state,
    )
    closeStream(state)
    const stats = getCacheStats()
    expect(stats.cachedTokens).toBe(900)
    expect(stats.freshTokens).toBe(100)
    expect(stats.hitRatio).toBeCloseTo(0.9)
  })
})
