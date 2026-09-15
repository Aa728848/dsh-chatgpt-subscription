/**
 * Regression tests for the issues raised in review of the video and
 * dynamically-loaded-tools work. Each test names the defect it pins so the
 * failure message is self-explanatory.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  MESSAGE_TOOLS,
  MESSAGE_TOOLS_KEY,
  assertRequestBodyFits,
  buildAnthropicRequest,
  buildOpenAIRequest,
  messageToolsOf,
  rehydrateMessageTools,
  withMessageTools,
} from '../src/host/kimi-code/mapper.ts'
import { dynamicToolsForEntry } from '../src/host/kimi-code/client.ts'
import type { KimiCodeCatalogModel } from '../src/host/kimi-code/token-store.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

function declaration(name: string, text?: string): Message {
  const content = text === undefined ? [] : [{ type: 'text' as const, text }]
  return withMessageTools(
    { role: 'system', content } as unknown as Message,
    [{ name, description: name, parameters: {} }],
  )
}

describe('live listing can turn the capability OFF (explicit false wins)', () => {
  it('honours an explicit false instead of falling back to the registry', () => {
    // The registry says k3 supports it; the service saying false must win, or
    // the documented precedence is a lie.
    const live: KimiCodeCatalogModel[] = [{ id: 'k3', supportsDynamicTools: false }]
    expect(dynamicToolsForEntry('k3', live)).toBe(false)
  })

  it('honours an explicit true', () => {
    const live: KimiCodeCatalogModel[] = [{ id: 'kimi-for-coding-highspeed', supportsDynamicTools: true }]
    expect(dynamicToolsForEntry('kimi-for-coding-highspeed', live)).toBe(true)
  })

  it('falls back to the registry only when the listing is silent', () => {
    // Absent (undefined) is genuinely different from false.
    expect(dynamicToolsForEntry('k3', [{ id: 'k3' }])).toBe(true)
    expect(dynamicToolsForEntry('kimi-for-coding-highspeed', [{ id: 'kimi-for-coding-highspeed' }])).toBe(false)
    expect(dynamicToolsForEntry('k3', [])).toBe(true)
  })
})

describe('a declaration carrier does not duplicate its system text', () => {
  it('ships the text exactly once, at the declaration position', () => {
    // Previously the text was folded into the leading system prompt AND
    // re-emitted at the slot, so the same instruction appeared twice.
    const body = buildOpenAIRequest(
      options({ messages: [declaration('search_docs', 'UNIQUE_INSTRUCTION'), { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message] }),
      new Map(), true, { messageTools: true },
    )
    const serialized = JSON.stringify(body)
    expect((serialized.match(/UNIQUE_INSTRUCTION/g) ?? [])).toHaveLength(1)
  })

  it('still folds ordinary system text into the leading prompt', () => {
    const body = buildOpenAIRequest(
      options({ messages: [{ role: 'system', content: [{ type: 'text', text: 'ORDINARY' }] } as Message] }),
      new Map(), true, {},
    )
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]?.role).toBe('system')
    expect(String(messages[0]?.content)).toContain('ORDINARY')
  })
})

describe('the Anthropic wire reports declarations it cannot carry', () => {
  it('names the unsent declarations in the system prompt', () => {
    const body = buildAnthropicRequest(options({ messages: [declaration('search_docs')] }))
    // The tool itself must not appear, but the count must be explained.
    expect(JSON.stringify(body)).not.toContain('search_docs')
    expect(String(body.system)).toContain('dynamically loaded tool(s) were not sent')
    expect(String(body.system)).toContain('Anthropic')
  })

  it('leaves the system prompt alone when there are no declarations', () => {
    const body = buildAnthropicRequest(options())
    expect(JSON.stringify(body)).not.toContain('were not sent')
  })
})

describe('the body guard takes the video fact from the caller', () => {
  it('does not widen the limit because user text contains the marker', () => {
    // Sniffing the serialized body for "video_url" let a message that merely
    // quotes it raise the text/image ceiling to 64 MB.
    const body = { model: 'k3', messages: [{ role: 'user', content: 'x'.repeat(2_200_000) + ' "video_url"' }] }
    expect(() => assertRequestBodyFits(body, false)).toThrow(/2097152-byte limit/)
  })

  it('allows an oversized body only when the caller says it carries video', () => {
    const body = { model: 'k3', messages: [{ role: 'user', content: 'x'.repeat(3_000_000) }] }
    expect(() => assertRequestBodyFits(body, true)).not.toThrow()
  })
})

describe('declarations survive JSON persistence', () => {
  it('keeps the declaration through a serialize/parse round trip', () => {
    const message = declaration('search_docs')
    const restored = JSON.parse(JSON.stringify(message)) as Message
    // The symbol cannot survive JSON; the string carrier must.
    expect((restored as unknown as Record<PropertyKey, unknown>)[MESSAGE_TOOLS]).toBeUndefined()
    expect((restored as unknown as Record<PropertyKey, unknown>)[MESSAGE_TOOLS_KEY]).toBeDefined()
    expect(messageToolsOf(restored)).toHaveLength(1)
  })

  it('re-attaches the symbol so a restored session still sends the declaration', () => {
    const restored = JSON.parse(JSON.stringify(declaration('search_docs'))) as Message
    rehydrateMessageTools(restored)
    expect((restored as unknown as Record<PropertyKey, unknown>)[MESSAGE_TOOLS]).toBeDefined()
    const body = buildOpenAIRequest(
      options({ messages: [restored, { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message] }),
      new Map(), true, { messageTools: true },
    )
    expect(JSON.stringify(body)).toContain('search_docs')
  })
})
