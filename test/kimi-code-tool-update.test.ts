import { afterEach, describe, expect, it } from 'vitest'
import { toolUpdateMode } from '../src/host/kimi-code/adapter.ts'

const capable = [{ id: 'kimi-openai', name: 'x', contextWindow: 1000, supportsDynamicTools: true }] as never
const incapable = [{ id: 'plain', name: 'y', contextWindow: 1000, supportsDynamicTools: false }] as never
const anthropic = [{
  id: 'kimi-anthropic',
  name: 'z',
  contextWindow: 1000,
  supportsDynamicTools: true,
  protocol: 'anthropic',
}] as never

afterEach(() => {
  delete process.env.DSH_KIMI_CODE_TOOL_UPDATE
})

describe('toolUpdateMode', () => {
  it('declares in-history for a capable model on the OpenAI-compatible surface', () => {
    // in-history, not addition-only: only this mode can express a removal
    // without shrinking the declaration list and rewriting the prefix.
    expect(toolUpdateMode('kimi-openai', capable)).toBe('in-history')
  })

  it('declares nothing for a model without the capability', () => {
    expect(toolUpdateMode('plain', incapable)).toBeUndefined()
  })

  it('declares nothing on the Anthropic-compatible surface, which documents no such field', () => {
    expect(toolUpdateMode('kimi-anthropic', anthropic)).toBeUndefined()
  })

  it('honours the operator opt-out', () => {
    process.env.DSH_KIMI_CODE_TOOL_UPDATE = '0'
    expect(toolUpdateMode('kimi-openai', capable)).toBeUndefined()
  })
})
