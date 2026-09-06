import { describe, expect, it } from 'vitest'
import { toToolCallId } from '../src/host/common/brand-compat.ts'

describe('toToolCallId brand compatibility', () => {
  it('brands tool call ids without error across dsh-llm versions', () => {
    const res = toToolCallId('call_123')
    expect(String(res)).toBe('call_123')
  })
})
