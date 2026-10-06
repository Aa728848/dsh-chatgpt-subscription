import { describe, expect, it } from 'vitest'
import {
  floorForcedThinkingTokens,
  MINIMAX_FORCED_THINKING_FLOOR_TOKENS,
} from '../src/host/minimax-code/mapper.ts'
import { MINIMAX_CODE_MODELS } from '../src/host/minimax-code/model-catalog.ts'

/**
 * A forced-thinking model spends its cap on reasoning before it emits text, so a
 * cap below the reasoning floor returns an empty answer with a max-tokens finish.
 * Measured on the M3.1 path with a session-title prompt: 64 tokens -> stop_reason
 * "max_tokens" with one thinking block and no text; 512 -> stop_reason "end_turn"
 * with the title after ~53 output tokens.
 */
const FORCED_THINKING = 'MiniMax-M3.1-Flash-Preview'

describe('floorForcedThinkingTokens', () => {
  it('raises a cap below the forced-thinking floor', () => {
    // The session-title default is 64, which this model cannot answer within.
    expect(floorForcedThinkingTokens(FORCED_THINKING, 64)).toBe(MINIMAX_FORCED_THINKING_FLOOR_TOKENS)
    expect(floorForcedThinkingTokens(FORCED_THINKING, 1)).toBe(MINIMAX_FORCED_THINKING_FLOOR_TOKENS)
  })

  it('leaves a cap at or above the floor untouched', () => {
    // "preserving explicit caller maxTokens": a caller that states a usable cap
    // keeps exactly what it stated.
    expect(floorForcedThinkingTokens(FORCED_THINKING, MINIMAX_FORCED_THINKING_FLOOR_TOKENS)).toBe(
      MINIMAX_FORCED_THINKING_FLOOR_TOKENS,
    )
    expect(floorForcedThinkingTokens(FORCED_THINKING, 8192)).toBe(8192)
  })

  it('leaves an absent cap alone so the catalog owns the ceiling', () => {
    expect(floorForcedThinkingTokens(FORCED_THINKING, undefined)).toBeUndefined()
  })

  it('raises a cap for an always-on model too, which cannot turn thinking off', () => {
    // "always-on" is the same trap as "forced-effort": the model reasons first
    // whatever the caller asks for, so a 64-token cap returns no text either.
    expect(floorForcedThinkingTokens('MiniMax-M2.7', 64)).toBe(MINIMAX_FORCED_THINKING_FLOOR_TOKENS)
  })

  it('does not raise a cap for a model whose thinking can be turned off', () => {
    // M3 is 'toggle': a caller may have asked for thinking off on purpose, and
    // raising the cap would not enable it while the number read back would lie.
    expect(floorForcedThinkingTokens('MiniMax-M3', 64)).toBe(64)
  })

  it('leaves an unknown model alone', () => {
    expect(floorForcedThinkingTokens('not-a-real-model', 64)).toBe(64)
  })

  it('never asks a model for more than the catalog says it can emit', () => {
    // Stated as an invariant over the real catalog rather than a made-up entry,
    // so a future forced-thinking model whose ceiling sits under the floor
    // cannot slip in asking for a cap the wire would reject.
    const forced = MINIMAX_CODE_MODELS.filter((model) =>
      model.thinking === 'always-on' || model.thinking === 'forced-effort')
    expect(forced.length).toBeGreaterThan(0)
    for (const model of forced) {
      expect(floorForcedThinkingTokens(model.id, 1)).toBeLessThanOrEqual(model.maxTokens)
      expect(floorForcedThinkingTokens(model.id, 64)).toBeLessThanOrEqual(Math.max(64, model.maxTokens))
      // A cap the caller stated above its own ceiling is the caller's number and
      // passes through, exactly as it did before the floor existed.
      expect(floorForcedThinkingTokens(model.id, 99_000)).toBe(99_000)
    }
  })
})
