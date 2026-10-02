import { describe, expect, it } from 'vitest'
import { buildBody } from '../src/host/ollama/client.ts'
import { toOllamaRequest } from '../src/host/ollama/adapter.ts'
import { applyEvent, closeStream, createStreamState } from '../src/host/ollama/mapper.ts'

function options(overrides: Record<string, unknown> = {}): never {
  return {
    provider: 'ollama',
    model: 'gpt-oss:120b',
    messages: [],
    ...overrides,
  } as never
}

describe('ollama request projection', () => {
  it('sends a one-shot system prompt that lives outside the history', () => {
    const request = toOllamaRequest(options({ system: 'be terse' }))

    expect(request.messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('keeps the history system message distinct from the one-shot prompt', () => {
    const request = toOllamaRequest(options({
      system: 'be terse',
      messages: [{ role: 'system', content: 'be terse' }],
    }))

    expect(request.messages.filter(message => message.role === 'system')).toHaveLength(2)
  })

  it('keeps image bytes instead of dropping them', () => {
    const request = toOllamaRequest(options({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { data: 'QUJD' } },
        ],
      }],
    }))

    expect(request.messages[0]!.images).toEqual(['QUJD'])
    // The native surface takes images as a sibling array.
    const native = buildBody('native', { model: 'm', messages: request.messages }) as {
      messages: Array<{ images?: string[] }>
    }
    expect(native.messages[0]!.images).toEqual(['QUJD'])
    // The OpenAI surface takes them as content parts.
    const openai = buildBody('openai', { model: 'm', messages: request.messages }) as {
      messages: Array<{ content: unknown }>
    }
    expect(openai.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'QUJD' } },
    ])
  })

  it('sends think only when the caller asked for an effort', () => {
    expect(toOllamaRequest(options()).think).toBeUndefined()
    expect(toOllamaRequest(options({ reasoningEffort: 'high' })).think).toBe('high')
    expect(toOllamaRequest(options({ reasoningEffort: 'none' })).think).toBe(false)
  })
})

describe('ollama thinking stream', () => {
  it('keeps the trace and the answer in separate blocks', () => {
    const state = createStreamState()
    const out = [
      ...applyEvent(state, { type: 'thinking', text: 'first I look' }),
      ...applyEvent(state, { type: 'thinking', text: ' then answer' }),
      ...applyEvent(state, { type: 'text', text: 'done' }),
      ...closeStream(state),
    ]

    const kinds = out.filter(chunk => chunk.type === 'block-start').map(chunk => (chunk as { blockType: string }).blockType)
    expect(kinds).toEqual(['reasoning', 'text'])
    // The trace closes before the answer opens, so no block is left dangling.
    const ends = out.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { text: string } }).block.text)
    expect(ends).toEqual(['first I look then answer', 'done'])
  })
})