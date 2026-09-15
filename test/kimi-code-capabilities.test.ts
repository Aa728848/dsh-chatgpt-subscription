/**
 * Tests for the two Kimi K3 capabilities this plugin adds on top of the base
 * coding route: video input, and message-level tool declarations
 * (`dynamically_loaded_tools`).
 *
 * Both are wire features the official client drives, so the assertions here
 * pin the exact request shape rather than just the presence of a field.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  MESSAGE_TOOLS,
  assertRequestBodyFits,
  buildAnthropicRequest,
  buildOpenAIRequest,
  buildRequest,
  messageToolsOf,
  offloadOldestRequestVideos,
  requestHasVideo,
  resolveRequestVideos,
  withMessageTools,
} from '../src/host/kimi-code/mapper.ts'
import {
  KIMI_VIDEO_MEDIA_TYPES,
  isVideoMediaType,
  videoDataUrl,
  videoOmissionText,
} from '../src/host/kimi-code/modalities.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model: 'k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] } as Message],
    ...overrides,
  } as GenerateOptions
}

function videoBlock(attachmentId: string, bytes = 1024, mediaType = 'video/mp4'): Message {
  return {
    role: 'user',
    content: [{ type: 'video', attachment: { attachmentId, mediaType, bytes, name: attachmentId } }],
  } as unknown as Message
}

function reader(videos: Record<string, { data: Uint8Array; mediaType?: string }>) {
  return {
    readVideo: async (ref: { attachmentId: string }) => {
      const entry = videos[ref.attachmentId]
      if (entry === undefined) throw new Error('missing')
      return { data: entry.data, mediaType: entry.mediaType ?? 'video/mp4' }
    },
  }
}

describe('video modality vocabulary', () => {
  it('accepts the containers the Kimi vision guide documents', () => {
    for (const mediaType of KIMI_VIDEO_MEDIA_TYPES) expect(isVideoMediaType(mediaType)).toBe(true)
    expect(isVideoMediaType('video/mp4')).toBe(true)
    // Case and padding must not decide acceptance.
    expect(isVideoMediaType('  VIDEO/MP4 ')).toBe(true)
  })

  it('rejects a container outside the documented set', () => {
    expect(isVideoMediaType('image/png')).toBe(false)
    expect(isVideoMediaType('video/x-matroska')).toBe(false)
    expect(isVideoMediaType('')).toBe(false)
  })

  it('builds the documented data URL form', () => {
    expect(videoDataUrl('video/mp4', 'AAAA')).toBe('data:video/mp4;base64,AAAA')
  })

  it('explains every omission reason without inventing support', () => {
    expect(videoOmissionText('unsupported-model', 'clip.mp4')).toContain('clip.mp4')
    expect(videoOmissionText('unreadable')).toContain('could not be read')
    expect(videoOmissionText('unsupported-container', 'x.avi')).toContain('video/')
    expect(videoOmissionText('unsupported-wire')).toContain('Anthropic')
  })
})

describe('requestHasVideo', () => {
  it('detects a video occurrence anywhere in the history', () => {
    expect(requestHasVideo(options())).toBe(false)
    expect(requestHasVideo(options({ messages: [videoBlock('v1')] }))).toBe(true)
  })
})

describe('resolveRequestVideos', () => {
  it('inlines the bytes of every distinct video', async () => {
    const resolved = await resolveRequestVideos(
      options({ messages: [videoBlock('v1'), videoBlock('v2')] }),
      reader({ v1: { data: new Uint8Array([1, 2, 3]) }, v2: { data: new Uint8Array([4]) } }),
    )
    expect(resolved.get('v1')).toEqual({ kind: 'inline', mediaType: 'video/mp4', data: Buffer.from([1, 2, 3]).toString('base64') })
    expect(resolved.get('v2')?.kind).toBe('inline')
  })

  it('returns the empty map when no video is present', async () => {
    expect((await resolveRequestVideos(options(), reader({}))).size).toBe(0)
  })

  it('marks a video unavailable when no reader is configured', async () => {
    const resolved = await resolveRequestVideos(options({ messages: [videoBlock('v1')] }), undefined)
    expect(resolved.get('v1')).toEqual({ kind: 'unavailable' })
  })

  it('marks a video unavailable when its bytes cannot be read', async () => {
    const resolved = await resolveRequestVideos(options({ messages: [videoBlock('v1')] }), reader({}))
    expect(resolved.get('v1')).toEqual({ kind: 'unavailable' })
  })
})

describe('offloadOldestRequestVideos', () => {
  it('leaves a request under the budget untouched', () => {
    const input = options({ messages: [videoBlock('v1', 1024)] })
    expect(offloadOldestRequestVideos(input)).toBe(input)
  })

  it('omits the oldest clips once the video budget is exceeded', () => {
    const huge = 32 * 1024 * 1024
    const input = options({ messages: [videoBlock('old', huge), videoBlock('recent', huge)] })
    const bounded = offloadOldestRequestVideos(input)
    expect(bounded).not.toBe(input)
    const blocks = bounded.messages.flatMap((message) => message.content as unknown[])
    // The oldest occurrence is replaced by text; the newer one survives.
    expect(blocks.some((block) => (block as { type?: string }).type === 'video')).toBe(true)
    expect(blocks.some((block) => (block as { type?: string }).type === 'text')).toBe(true)
  })
})

describe('video on the OpenAI wire', () => {
  it('emits a video_url part when the model declares video input', async () => {
    const request = options({ messages: [videoBlock('v1')] })
    const videos = await resolveRequestVideos(request, reader({ v1: { data: new Uint8Array([9, 9]) } }))
    const body = buildOpenAIRequest(request, new Map(), true, { videos, videoAccepted: true })
    const messages = body.messages as Array<Record<string, unknown>>
    const parts = messages[0]?.content as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: 'video_url', video_url: { url: videoDataUrl('video/mp4', Buffer.from([9, 9]).toString('base64')) } })
  })

  it('degrades to text when the model does not accept video', async () => {
    const request = options({ messages: [videoBlock('v1')] })
    const videos = await resolveRequestVideos(request, reader({ v1: { data: new Uint8Array([1]) } }))
    const body = buildOpenAIRequest(request, new Map(), true, { videos, videoAccepted: false })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(typeof messages[0]?.content).toBe('string')
    expect(String(messages[0]?.content)).toContain('does not accept video input')
  })

  it('degrades to text when the bytes are unavailable', () => {
    const body = buildOpenAIRequest(options({ messages: [videoBlock('v1')] }), new Map(), true, { videoAccepted: true })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(String(messages[0]?.content)).toContain('could not be read')
  })

  it('rejects a container the service does not document', () => {
    const body = buildOpenAIRequest(
      options({ messages: [videoBlock('v1', 10, 'video/x-matroska')] }),
      new Map(),
      true,
      { videoAccepted: true, videos: new Map([['v1', { kind: 'inline' as const, mediaType: 'video/x-matroska', data: 'AA' }]]) },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    expect(String(messages[0]?.content)).toContain('container')
  })
})

describe('video on the Anthropic wire', () => {
  it('never emits an undocumented video part', () => {
    const body = buildAnthropicRequest(options({ messages: [videoBlock('v1')] }))
    const messages = body.messages as Array<Record<string, unknown>>
    const parts = messages[0]?.content as Array<Record<string, unknown>>
    expect(parts.every((part) => part.type !== 'video_url' && part.type !== 'video')).toBe(true)
    expect(parts[0]?.text).toContain('Anthropic')
  })
})

describe('dynamic tool loading', () => {
  function declarationMessage(): Message {
    return withMessageTools(
      { role: 'system', content: [] } as unknown as Message,
      [{ name: 'search_docs', description: 'Search the docs', parameters: { type: 'object' } }],
    )
  }

  it('round-trips declarations through the symbol carrier', () => {
    const message = declarationMessage()
    expect(messageToolsOf(message)).toHaveLength(1)
    expect(messageToolsOf({ role: 'system', content: [] } as unknown as Message)).toBeUndefined()
    // The carrier must not become an enumerable field other readers would see.
    expect(Object.keys(message)).not.toContain(String(MESSAGE_TOOLS))
  })

  it('emits a content-less system message with the full definition', () => {
    const body = buildOpenAIRequest(
      options({ messages: [declarationMessage(), { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message] }),
      new Map(), true, { messageTools: true },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    const declared = messages.find((message) => Array.isArray(message.tools))
    expect(declared).toBeDefined()
    // A `content` field on this message is a hard schema violation.
    expect(declared).not.toHaveProperty('content')
    expect(declared?.role).toBe('system')
    expect(declared?.tools).toEqual([{
      type: 'function',
      function: { name: 'search_docs', description: 'Search the docs', parameters: { type: 'object' } },
    }])
  })

  it('tells the turn instead of sending a declaration the model cannot accept', () => {
    const body = buildOpenAIRequest(
      options({ messages: [declarationMessage(), { role: 'user', content: [{ type: 'text', text: 'go' }] } as Message] }),
      new Map(), true, { messageTools: false },
    )
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages.some((message) => Array.isArray(message.tools))).toBe(false)
    expect(JSON.stringify(body)).toContain('dynamically_loaded_tools capability')
  })

  it('keeps declarations in history order so the cached prefix stays stable', () => {
    const first = withMessageTools({ role: 'system', content: [] } as unknown as Message, [{ name: 'a', description: 'a', parameters: {} }])
    const second = withMessageTools({ role: 'system', content: [] } as unknown as Message, [{ name: 'b', description: 'b', parameters: {} }])
    const messages = [first, { role: 'user', content: [{ type: 'text', text: 'x' }] } as Message, second]
    const body = buildOpenAIRequest(options({ messages }), new Map(), true, { messageTools: true })
    const declared = (body.messages as Array<Record<string, unknown>>).filter((message) => Array.isArray(message.tools))
    expect(declared.map((message) => (message.tools as Array<{ function: { name: string } }>)[0]?.function.name)).toEqual(['a', 'b'])
  })

  it('drops declarations on the Anthropic wire, which does not document them', () => {
    const body = buildAnthropicRequest(options({ messages: [declarationMessage()] }))
    expect(JSON.stringify(body)).not.toContain('search_docs')
  })
})

describe('request body budget', () => {
  it('still rejects a text-only body over the documented 2 MB limit', () => {
    const body = { model: 'k3', messages: [{ role: 'user', content: 'x'.repeat(2_200_000) }] }
    expect(() => assertRequestBodyFits(body)).toThrow(/2097152-byte limit/)
  })

  it('allows a body carrying video to exceed the text limit', () => {
    const body = { model: 'k3', messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,' + 'A'.repeat(3_000_000) } }] }] }
    expect(() => assertRequestBodyFits(body)).not.toThrow()
  })
})

describe('buildRequest routing', () => {
  it('passes media options to the OpenAI builder only', () => {
    const messages = [withMessageTools({ role: 'system', content: [] } as unknown as Message, [{ name: 't', description: 'd', parameters: {} }])]
    const openai = buildRequest(options({ messages }), 'openai', new Map(), true, { messageTools: true })
    expect(JSON.stringify(openai)).toContain('"tools"')
    const anthropic = buildRequest(options({ messages }), 'anthropic', new Map(), true, { messageTools: true })
    expect(JSON.stringify(anthropic)).not.toContain('"tools":[{"type":"function"')
  })
})
