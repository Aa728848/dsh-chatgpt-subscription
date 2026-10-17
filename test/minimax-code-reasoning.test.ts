import { describe, expect, it } from 'vitest'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'

describe('MiniMax Code reasoning metadata', () => {
  it('orders the M3.1 ladder by strength while preserving the configured default', async () => {
    const adapter = new MinimaxCodeAdapter({} as never, {}, {} as never, {
      status: () => ({ contextWindowOverrides: {}, defaultReasoningEffort: 'high' }),
    } as never)

    const resolved = await adapter.resolveModel('minimax-code', 'MiniMax-M3.1-Flash-Preview')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'default',
    ])
    expect(resolved.reasoning?.defaultEffort).toBe('high')
  })
})
