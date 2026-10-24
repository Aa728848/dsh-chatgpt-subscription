import { describe, expect, it } from 'vitest'
import type { KimiCodeModelOption } from '../src/shared/kimi-code-contracts.ts'
import {
  canDisableThinking,
  effortLadder,
  effortOptions,
  wireLabel,
} from '../src/client/kimi-code/labels.ts'
import { zh } from '../src/client/kimi-code/locales.ts'

/**
 * The two rules the settings menu is built from.
 *
 * They are pure functions on the model directory, so they are pinned here
 * rather than through a mounted card: the card has to keep agreeing with them,
 * but the rules themselves must not be re-derived by hand in a component.
 */
function model(overrides: Partial<KimiCodeModelOption> = {}): KimiCodeModelOption {
  return {
    id: 'k3',
    name: 'K3',
    enabled: true,
    defaultContextWindow: 262_144,
    contextWindow: 262_144,
    promptBudget: 262_144,
    defaultMaxTokens: 32_768,
    reasoningEfforts: ['low', 'high', 'max'],
    wire: 'openai',
    description: null,
    supportsVideo: true,
    supportsDynamicTools: true,
    supportsToolUse: true,
    minimumPlan: null,
    quotaMultiplier: 2,
    ...overrides,
  }
}

describe('kimi-code effort ladder', () => {
  it('reads the levels a model declares, in the order the card renders them', () => {
    // Declared out of order and with an unknown level: the ladder is filtered to
    // the levels the adapter actually puts on the wire, and sorted by the shipped
    // order rather than by whatever the listing happened to say.
    expect(effortLadder(model({ reasoningEfforts: ['max', 'ultra', 'low'] }))).toEqual(['low', 'max'])
    expect(effortLadder(model({ reasoningEfforts: undefined }))).toEqual([])
  })

  it('never publishes "thinking off" for a model that only thinks', () => {
    expect(effortLadder(model({
      thinkingType: 'only',
      reasoningEfforts: ['low', 'high', 'max', 'none'],
    }))).toEqual(['low', 'high', 'max'])
    expect(canDisableThinking(model({ thinkingType: 'only' }))).toBe(false)
  })

  it('describes each wire dialect by name', () => {
    expect(wireLabel('openai', zh)).toBe(zh.wireOpenai)
    expect(wireLabel('anthropic', zh)).toBe(zh.wireAnthropic)
  })

  it('offers the union of the checked models, and no more', () => {
    const models = [
      model({ id: 'a', reasoningEfforts: ['low', 'high', 'max'] }),
      model({ id: 'b', enabled: false, reasoningEfforts: ['high'] }),
    ]
    // An unchecked model does not widen the menu: nothing can select it.
    expect(effortOptions(models)).toEqual(['low', 'high', 'max', 'none'])
    expect(effortOptions([model({ reasoningEfforts: ['high'], thinkingType: 'no' })])).toEqual(['high'])
  })

  it('drops the off switch exactly when every checked model refuses it', () => {
    const only = model({ id: 'k3.1-pro', thinkingType: 'only' })
    expect(effortOptions([only])).toEqual(['low', 'high', 'max'])
    // One switchable model is enough to keep it, whatever the order.
    expect(effortOptions([only, model()])).toContain('none')
    expect(effortOptions([model(), only])).toContain('none')
  })

  it('offers the full ladder when nothing is checked', () => {
    expect(effortOptions([model({ enabled: false })])).toEqual(['low', 'high', 'max', 'none'])
  })
})
