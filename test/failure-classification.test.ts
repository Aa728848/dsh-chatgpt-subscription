import { describe, expect, it } from 'vitest'
import { cooldownFromReset, SINGLE_REFRESH_ATTEMPT } from '../src/host/common/failure-classification.ts'

describe('failure classification primitives', () => {
  it('clamps a future reset between the route bounds', () => {
    expect(cooldownFromReset({ now: 1_000, resetAtMs: 2_000, fallbackMs: 50, minimumMs: 100, maximumMs: 10_000 })).toBe(1_000)
    expect(cooldownFromReset({ now: 1_000, resetAtMs: 100_000, fallbackMs: 50, minimumMs: 100, maximumMs: 10_000 })).toBe(10_000)
  })

  it('uses the route fallback for missing, stale, or invalid reset evidence', () => {
    for (const resetAtMs of [undefined, null, 500, Number.NaN]) {
      expect(cooldownFromReset({ now: 1_000, resetAtMs, fallbackMs: 50, minimumMs: 100 })).toBe(100)
    }
  })

  it('pins nested credential refresh to one attempt', () => {
    expect(SINGLE_REFRESH_ATTEMPT).toBe(1)
  })
})
