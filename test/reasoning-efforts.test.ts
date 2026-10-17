import { describe, expect, it } from 'vitest'
import { orderReasoningEfforts } from '../src/host/common/reasoning-efforts.ts'

describe('orderReasoningEfforts', () => {
  it('sorts a fully known ladder by strength rather than presentation order', () => {
    expect(orderReasoningEfforts(['low', 'high', 'none'], ['none', 'low', 'high', 'max'])).toEqual([
      'none', 'low', 'high',
    ])
  })

  it('preserves a provider-declared ladder containing an unknown level', () => {
    expect(orderReasoningEfforts(['low', 'custom', 'none'], ['none', 'low', 'high'])).toEqual([
      'low', 'custom', 'none',
    ])
  })
})
