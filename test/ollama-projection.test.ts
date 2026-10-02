import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
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

/** A real one-pixel PNG, the way DSH stores an attachment. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const ATTACHMENT = {
  attachmentId: 'sha256:shot',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
} as unknown as ImageAttachmentRef

/** The shape DSH actually builds for a user turn carrying a screenshot. */
function imageTurn(): never {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', attachment: ATTACHMENT },
    ],
  } as never
}

const store = { readImage: async () => ({ ref: ATTACHMENT, data: PNG }) }

describe('ollama request projection', () => {
  it('sends a one-shot system prompt that lives outside the history', async () => {
    const request = await toOllamaRequest(options({ system: 'be terse' }))

    expect(request.messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('keeps a system prompt that the history also carries', async () => {
    const request = await toOllamaRequest(options({
      system: 'be terse',
      messages: [{ role: 'system', content: 'be terse' }],
    }))

    expect(request.messages.filter(message => message.role === 'system')).toHaveLength(2)
  })

  it('reads a durable attachment instead of dropping the image', async () => {
    // The shape under test is the one DSH produces: a reference, not bytes.
    const request = await toOllamaRequest(options({ messages: [imageTurn()] }), store)

    expect(request.messages[0]!.images).toEqual([`data:image/png;base64,${PNG_BASE64}`])

    const native = buildBody('native', { model: 'm', messages: request.messages }) as {
      messages: Array<{ images?: string[] }>
    }
    expect(native.messages[0]!.images).toEqual([`data:image/png;base64,${PNG_BASE64}`])

    const openai = buildBody('openai', { model: 'm', messages: request.messages }) as {
      messages: Array<{ content: unknown }>
    }
    expect(openai.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
    ])
  })

  it('does not lose the turn when the attachment cannot be read', async () => {
    // Without a store the bytes are unavailable, but the text must survive: an
    // image that cannot be loaded is not a reason to send an empty turn.
    const request = await toOllamaRequest(options({ messages: [imageTurn()] }))

    expect(request.messages[0]!.content).toBe('what is this')
    expect(request.messages[0]!.images).toBeUndefined()
  })

  it('sends think only when the caller asked for an effort', async () => {
    expect((await toOllamaRequest(options())).think).toBeUndefined()
    expect((await toOllamaRequest(options({ reasoningEffort: 'high' }))).think).toBe('high')
    expect((await toOllamaRequest(options({ reasoningEffort: 'none' }))).think).toBe(false)
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
    const ends = out.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { text: string } }).block.text)
    expect(ends).toEqual(['first I look then answer', 'done'])
  })
})