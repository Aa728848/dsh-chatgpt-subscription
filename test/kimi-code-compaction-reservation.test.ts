import { describe, expect, it } from 'vitest'
import { CONTEXT_HEADROOM_TOKENS, maxOutputTokensFor } from '../src/host/kimi-code/types.ts'
import { KIMI_CODE_MODELS } from '../src/host/kimi-code/model-catalog.ts'

/**
 * `defaultMaxTokens` has a second consumer inside DSH that the Kimi route's
 * own tests never see: `dsh-compaction-basic` subtracts it from the context
 * window to decide when a session is under pressure.
 *
 *   messageBudget = contextWindow - reservedCompletionTokens
 *   pressureBudget = messageBudget - headroomTokens
 *
 * `reservedCompletionTokens` falls back to the adapter's `defaultMaxTokens`
 * when a session sets no explicit `maxTokens`, which is the default for every
 * Kimi model. So the number `maxOutputTokensFor` returns is not only the wire
 * cap - it is the harness's output reservation, and a value that tracks the
 * window from below leaves no message budget to compact against.
 *
 * These assertions restate the harness arithmetic rather than importing it, so
 * the failure stays visible when the harness defaults move.
 */

/** Harness defaults from dsh-compaction-basic: 8 * 65536 = 65_536, auto on. */
const HARNESS_HEADROOM_TOKENS = 65_536
const HARNESS_THRESHOLD_RATIO = 0.8
const HARNESS_RETAIN_RATIO = 0.16

function compactionOutcome(contextWindow: number, reserved: number): 'ok' | string {
  const messageBudget = contextWindow - reserved
  if (messageBudget <= 0) return 'no message budget'
  const pressureBudget = messageBudget - HARNESS_HEADROOM_TOKENS
  if (pressureBudget <= 0) return 'no pressure budget'
  const threshold = Math.floor(Math.min(contextWindow * HARNESS_THRESHOLD_RATIO, pressureBudget))
  const retain = Math.floor(messageBudget * HARNESS_RETAIN_RATIO)
  if (retain >= threshold) return 'retain not below threshold'
  return 'ok'
}

describe('maxOutputTokensFor is also the harness output reservation', () => {
  it('leaves compaction-basic no pressure budget on every shipped Kimi model', () => {
    // The cap tracks the window (window - 4096), so the reservation is within
    // 4096 of the whole window and the 65_536 headroom cannot fit.
    const broken = KIMI_CODE_MODELS.filter(
      (model) => compactionOutcome(model.contextWindow, maxOutputTokensFor(model.id, model.contextWindow)) !== 'ok',
    )
    expect(broken.map((model) => model.id)).toEqual(KIMI_CODE_MODELS.map((model) => model.id))
  })

  it('reserves more than the window allows once headroom is counted', () => {
    const window = 262_144
    const cap = maxOutputTokensFor('k3-256k', window)
    // The reservation must stay under the window by at least the headroom.
    expect(window - cap).toBeLessThan(HARNESS_HEADROOM_TOKENS)
    expect(compactionOutcome(window, cap)).toBe('no pressure budget')
  })

  it('gets no healthier as the user lowers the context-window override', () => {
    // The settings card exposes a contextWindow override but no maxTokens
    // override, so this is the only knob a Kimi user can turn.
    for (const window of [262_144, 200_000, 131_072, 65_536]) {
      expect(compactionOutcome(window, maxOutputTokensFor('k3-256k', window))).not.toBe('ok')
    }
  })

  it('is a floor, not a ceiling: declared 32_768 never bounds the result', () => {
    // Documents the behavior the CHANGELOG calls intentional, so the reason
    // this matters stays visible next to the assertion that catches it.
    const declared = KIMI_CODE_MODELS.find((model) => model.id === 'k3-256k')!.maxTokens
    expect(maxOutputTokensFor('k3-256k', 262_144)).toBe(262_144 - CONTEXT_HEADROOM_TOKENS)
    expect(maxOutputTokensFor('k3-256k', 262_144)).toBeGreaterThan(declared)
  })
})
