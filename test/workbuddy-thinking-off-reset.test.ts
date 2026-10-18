import { describe, expect, it } from 'vitest'
import {
  WORKBUDDY_REASONING_EFFORTS,
  convergeWorkBuddyEffort,
} from '../src/shared/workbuddy-contracts.ts'
import {
  FALLBACK_MODELS,
  maxOutputTokensFor,
  workBuddyReasoningEfforts,
  type WorkBuddyModelEntry,
} from '../src/host/workbuddy/model-catalog.ts'
import { parseConfigModels } from '../src/host/workbuddy/client.ts'
import { buildChatRequest } from '../src/host/workbuddy/mapper.ts'
import { classifyFailure, readRateLimitReset } from '../src/host/workbuddy/adapter.ts'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'

function entry(overrides: Partial<WorkBuddyModelEntry> = {}): WorkBuddyModelEntry {
  return {
    id: 'test-model',
    name: 'Test Model',
    contextWindow: 128_000,
    maxContextWindow: 128_000,
    maxTokens: 32_768,
    regions: ['intl'],
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
    ...overrides,
  }
}

function options(overrides: Record<string, unknown> = {}): GenerateOptions {
  // Loose on purpose: `reasoningEffort` is a branded id upstream, and the point
  // of these tests is the plain wire value that reaches the request body.
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as unknown as GenerateOptions
}

describe('switching thinking off', () => {
  it('offers the level only on a model that allows it', () => {
    const on = [entry({ canDisableThinking: true })]
    const off = [entry({ canDisableThinking: false })]
    expect(workBuddyReasoningEfforts('test-model', on)).toEqual(['none', 'low', 'high', 'max'])
    expect(workBuddyReasoningEfforts('test-model', off)).toEqual(['low', 'high', 'max'])
    // A model with no ladder at all keeps none: there is nothing to turn off.
    expect(workBuddyReasoningEfforts('test-model', [entry({ reasoningEfforts: [], canDisableThinking: true })]))
      .toEqual([])
  })

  it('keeps the parsed ladder faithful and adds the level at presentation', () => {
    const live = parseConfigModels({
      data: {
        models: [{
          id: 'live-model',
          name: 'Live',
          maxAllowedSize: 200_000,
          maxOutputTokens: 8_192,
          supportsImages: false,
          reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: true },
        }],
      },
    }, 'intl')
    // The gateway's stated ladder is stored exactly; `canDisableThinking` is a
    // separate fact, and the accessor is what turns it into a selectable level.
    expect(live[0]?.reasoningEfforts).toEqual(['low', 'high'])
    expect(live[0]?.canDisableThinking).toBe(true)
    expect(workBuddyReasoningEfforts('live-model', live)).toEqual(['none', 'low', 'high'])
  })

  it('sends the level as reasoning_effort none', () => {
    const body = buildChatRequest(options({ reasoningEffort: 'none' }))
    expect(body.reasoning_effort).toBe('none')
  })

  it('keeps none out of the ladder-convergence ranks', () => {
    // Convergence maps an unsupported level onto the nearest rung; 'none' is
    // below every rung, so it converges to the lowest one rather than inventing
    // a rung.
    expect(convergeWorkBuddyEffort('none', ['low', 'high', 'max'])).toBe('low')
    expect(WORKBUDDY_REASONING_EFFORTS[0]).toBe('none')
  })
})

describe('quota reset instant', () => {
  const now = Date.UTC(2026, 8, 20, 0, 0, 0) // 2026-09-20T00:00:00Z

  it('reads the international wording', () => {
    // 10:50:48 at UTC+8 is 02:50:48 UTC, which is 2h50m48s after `now`.
    const delay = readRateLimitReset('your usage will reset at 2026-09-20 10:50:48 UTC+8', now)
    expect(delay).toBe((2 * 3600 + 50 * 60 + 48) * 1000)
  })

  it('reads the domestic wording', () => {
    // 12:00:00 at UTC+8 is 04:00:00 UTC, four hours after `now`.
    const delay = readRateLimitReset('额度将在 2026-09-20 12:00:00 UTC+8 重置', now)
    expect(delay).toBe(4 * 3600 * 1000)
  })

  it('ignores a stamp with no timezone as UTC, a past instant, and nonsense', () => {
    expect(readRateLimitReset('resets at 2026-09-20 01:00:00', now)).toBe(3_600_000)
    expect(readRateLimitReset('resets at 2026-09-19 01:00:00 UTC+8', now)).toBeUndefined()
    expect(readRateLimitReset('usage exceeded', now)).toBeUndefined()
    expect(readRateLimitReset('resets at 2030-01-01 00:00:00 UTC', now)).toBeUndefined()
  })

  it('carries the reset into the classified failure when no header exists', () => {
    // Built from the real clock: classifyFailure reads "now" for itself, so a
    // fixed fixture would land in the past and prove nothing.
    const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const error = classifyFailure(429, `{"code":6004,"msg":"usage exceeded, resets at ${soon}"}`)
    expect(error.code).toBe('RATE_LIMIT')
    expect(typeof error.failure.providerRetryAfterMs).toBe('number')
    expect(Number(error.failure.providerRetryAfterMs)).toBeGreaterThan(3_600_000)
    expect(Number(error.failure.providerRetryAfterMs)).toBeLessThan(3 * 3600 * 1000)
  })

  it('still prefers a structured Retry-After header', () => {
    const headers = new Headers({ 'retry-after': '30' })
    const error = classifyFailure(429, '{"code":6004,"msg":"resets at 2026-09-20 10:50:48 UTC+8"}', headers)
    expect(error.failure.providerRetryAfterMs).toBe(30_000)
  })
})
