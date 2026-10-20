import { describe, expect, it } from 'vitest'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'

describe('MiniMax Code reasoning metadata', () => {
  it('orders the M3.1 ladder by strength while preserving the configured default', async () => {
    const adapter = new MinimaxCodeAdapter({} as never, {}, {} as never, {
      status: () => ({ contextWindowOverrides: {}, defaultReasoningEffort: 'high' }),
    } as never)

    const resolved = await adapter.resolveModel('minimax-code', 'MiniMax-M3.1-Flash')
    // The invented 'default' tier is gone: the upstream model catalog
    // (models.dev snapshot) has no such level for any MiniMax model, and the
    // harness's own vocabulary has none either.
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })

  it('ranks max as the strongest level, not the absence of one', async () => {
    // `default` means "the caller picked nothing" and the docs say omitting
    // `effort` means max. It is not a level, so it must not sit at the top of
    // the ladder - DSH's picker renders this list in order and the core reads
    // `efforts[0]` as the least supported level.
    const adapter = new MinimaxCodeAdapter({} as never, {}, {} as never, {
      status: () => ({ contextWindowOverrides: {}, defaultReasoningEffort: null }),
    } as never)

    const resolved = await adapter.resolveModel('minimax-code', 'MiniMax-M3.1-Flash')
    const ids = resolved.reasoning?.efforts.map((effort) => effort.id) ?? []
    expect(ids).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(ids).not.toContain('default')
    // No level picked means the provider's own default, which DSH spells as
    // an absent `defaultEffort`.
    expect(resolved.reasoning?.defaultEffort).toBeUndefined()
  })
})
