import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '../src/host/common/llm-compat.ts'
import { ReasoningDialectRegistry, ReasoningKeyDialect } from '../src/host/common/reasoning-dialect.ts'
import { buildClinePassBody, reasoningOf as clineReasoningOf } from '../src/host/cline-pass/mapper.ts'
import { buildOpenDesignBody, reasoningOf as openDesignReasoningOf } from '../src/host/opendesign/mapper.ts'
import { NO_RESOLVED_IMAGES } from '../src/host/common/request-images.ts'
import {
  buildQoderChatRequest,
  createQoderStreamState,
  DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
  processQoderStreamLine,
} from '../src/host/qoder/mapper.ts'

function reasoningHistory(provider: string): GenerateOptions {
  return {
    provider,
    model: 'model',
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'preserved' }] }],
  } as GenerateOptions
}

describe('ReasoningKeyDialect', () => {
  it('learns aliases and keeps provider registries isolated', () => {
    const dialect = new ReasoningKeyDialect()
    expect(dialect.outboundKey()).toBe('reasoning_content')
    expect(dialect.observe({ reasoning: 'text' })).toBe('text')
    expect(dialect.outboundKey()).toBe('reasoning')
    expect(dialect.observe({ reasoning_content: '' })).toBe('')
    expect(dialect.outboundKey()).toBe('reasoning_content')

    const registry = new ReasoningDialectRegistry()
    registry.for('a', 'chat').observe({ reasoning: 'a' })
    expect(registry.for('a', 'chat').outboundKey()).toBe('reasoning')
    expect(registry.for('b', 'chat').outboundKey()).toBe('reasoning_content')
  })
})

describe('provider reasoning replay', () => {
  it('Cline Pass replays under the learned key', () => {
    clineReasoningOf({ reasoning: 'learn' })
    const body = buildClinePassBody(reasoningHistory('cline-pass'), { maxTokens: 1024 }, new Map())
    expect(body.messages[0]).toMatchObject({ reasoning: 'preserved' })
    expect(body.messages[0]?.reasoning_content).toBeUndefined()
  })

  it('OpenDesign replays under the learned key', () => {
    openDesignReasoningOf({ reasoning: 'learn' })
    const body = buildOpenDesignBody(reasoningHistory('opendesign'), { maxTokens: 1024 }, NO_RESOLVED_IMAGES)
    expect(body.messages[0]).toMatchObject({ reasoning: 'preserved' })
    expect(body.messages[0]?.reasoning_content).toBeUndefined()
  })

  it('Qoder replays under the learned key', () => {
    const state = createQoderStreamState()
    processQoderStreamLine('data:' + JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: JSON.stringify({ choices: [{ delta: { reasoning: 'learn' } }] }),
      statusCode: 'OK',
    }), state)
    const body = buildQoderChatRequest(
      reasoningHistory('qoder'),
      undefined as never,
      DEFAULT_QODER_WIRE_REQUEST_OPTIONS,
      { modelKey: 'lite', entry: undefined, cosyVersion: '1.1.72' },
    )
    const assistant = (body.messages as Array<Record<string, unknown>>).find(message => message.role === 'assistant')
    expect(assistant).toMatchObject({ reasoning: 'preserved' })
    expect(assistant?.reasoning_content).toBeUndefined()
  })
})
