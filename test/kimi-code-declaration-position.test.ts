/**
 * Regression tests for the two defects the first cut of the dynamic-tool and
 * video support shipped with. Both were invisible to tests that called the
 * mapper directly, because both live in how a real DSH history reaches it:
 *
 * 1. declarations were collected and emitted at the front of the request, but
 *    the feature exists to keep the cached prefix stable - a declaration must
 *    stay at the position it was first sent, or the cache is invalidated;
 * 2. isAbort used instanceof Error, and DSH's own LlmError is not an Error
 *    subclass, so a real cancellation was converted into a model-visible
 *    'could not be read' placeholder instead of aborting the turn.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  buildOpenAIRequest,
  resolveRequestImages,
  resolveRequestVideos,
  withMessageTools,
} from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { model: 'k3', messages: [], ...overrides } as GenerateOptions
}

function declaration(name: string): Message {
  return withMessageTools(
    { role: 'system', content: [] } as unknown as Message,
    [{ name, description: name, parameters: {} }],
  )
}

interface Declared { index: number; name: string }

function declaredNames(body: Record<string, unknown>): Declared[] {
  const wire = body.messages as Array<Record<string, unknown>>
  const found: Declared[] = []
  wire.forEach((message, index) => {
    const tools = message.tools as Array<{ function: { name: string } }> | undefined
    if (Array.isArray(tools) && tools.length > 0) found.push({ index, name: tools[0]!.function.name })
  })
  return found
}

describe('declaration position is the cache contract', () => {
  it('emits each declaration where it sits in the history, not at the front', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] } as Message,
      declaration('early'),
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] } as Message,
      { role: 'user', content: [{ type: 'text', text: 'three' }] } as Message,
      declaration('late'),
    ]
    const body = buildOpenAIRequest(options({ messages }), new Map(), true, { messageTools: true })
    const names = declaredNames(body)
    expect(names.map((entry) => entry.name)).toEqual(['early', 'late'])
    const contents = (body.messages as Array<Record<string, unknown>>)
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
    expect(contents.indexOf('one')).toBeLessThan(names[0]!.index)
    expect(contents.indexOf('two')).toBeLessThan(names[1]!.index)
    expect(contents.indexOf('three')).toBeLessThan(names[1]!.index)
  })

  it('appends a trailing declaration last so the prefix is untouched', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] } as Message,
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as Message,
      declaration('later'),
    ]
    const body = buildOpenAIRequest(options({ messages }), new Map(), true, { messageTools: true })
    const wire = body.messages as Array<Record<string, unknown>>
    const names = declaredNames(body)
    expect(names).toHaveLength(1)
    expect(names[0]!.index).toBe(wire.length - 1)
    expect(wire[wire.length - 2]?.content).toBe('hi')
  })

  it('keeps a leading declaration at the head rather than dropping it', () => {
    const body = buildOpenAIRequest(
      options({ messages: [declaration('first'), { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message] }),
      new Map(), true, { messageTools: true },
    )
    const names = declaredNames(body)
    expect(names).toHaveLength(1)
    expect(names[0]!.index).toBe(0)
  })

  it('preserves system text and reports a declaration sharing its message', () => {
    const combined = withMessageTools(
      { role: 'system', content: [{ type: 'text', text: 'IMPORTANT INSTRUCTION' }] } as unknown as Message,
      [{ name: 'search_docs', description: 'd', parameters: {} }],
    )
    const body = buildOpenAIRequest(options({ messages: [combined] }), new Map(), true, { messageTools: true })
    const wire = body.messages as Array<Record<string, unknown>>
    expect(wire.some((message) => typeof message.content === 'string'
      && message.content.includes('IMPORTANT INSTRUCTION'))).toBe(true)
    expect(declaredNames(body)).toHaveLength(0)
    expect(JSON.stringify(body)).toContain('dynamically loaded tool(s) were not sent')
  })
})

describe('abort detection on the real DSH error path', () => {
  it('rethrows a cancellation whose error object is not an Error', async () => {
    const abort = { name: 'AbortError', message: 'aborted' }
    const attachments = { readImage: async () => { throw abort } }
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1 } }] } as unknown as Message]
    await expect(resolveRequestImages(options({ messages }), attachments as never)).rejects.toBe(abort)
  })

  it('rethrows rather than degrading when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const attachments = { readImage: async () => { throw new Error('plain failure') } }
    const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1 } }] } as unknown as Message]
    await expect(resolveRequestImages(options({ messages }), attachments as never, controller.signal))
      .rejects.toThrow('plain failure')
  })

  it('still degrades a genuine read failure to unavailable for video', async () => {
    const attachments = { readVideo: async () => { throw new Error('disk gone') } }
    const messages = [{ role: 'user', content: [{ type: 'video', attachment: { attachmentId: 'v1', mediaType: 'video/mp4', bytes: 4 } }] } as unknown as Message]
    const resolved = await resolveRequestVideos(options({ messages }), attachments as never)
    expect(resolved.get('v1')).toEqual({ kind: 'unavailable' })
  })
})
