import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { installReasoningCollapseGuard } from '../src/host/reasoning-collapse-guard/index.ts'

/**
 * The reasoning-collapse guard (the line's circuit breaker) is switched off by
 * default. These cases pin the two halves of that decision so neither can drift
 * silently: the wiring must not install it on its own, and the implementation
 * must stay importable and intact for a deployment that opts back in.
 */
describe('reasoning-collapse guard: switched off by default, kept functional', () => {
  it('resolves the config to an explicit off switch when the plugin passes none', () => {
    expect(Config({}).reasoningCollapseGuard).toBe(false)
  })

  it('still lets a deployment opt back in with its own tuning object', () => {
    expect(Config({ reasoningCollapseGuard: {} }).reasoningCollapseGuard).toEqual({})
    const tuned = { reasoningCollapseGuard: { threshold: 0.9, maxBreaksPerTurn: 1 } }
    expect(Config(tuned).reasoningCollapseGuard).toEqual(tuned.reasoningCollapseGuard)
    expect(Config({ reasoningCollapseGuard: false }).reasoningCollapseGuard).toBe(false)
  })

  it('keeps the implementation installable, so the switch is the only thing that changed', () => {
    expect(typeof installReasoningCollapseGuard).toBe('function')
    // No event bus on this fake Context: the guard reports "not installed"
    // rather than throwing, which is the same degradation a host without
    // `ctx.on` gets.
    expect(installReasoningCollapseGuard({} as never, {})).toBeUndefined()
  })
})
