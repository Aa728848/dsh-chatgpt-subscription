import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  offloadOldestRequestVideos,
  resolveRequestVideos,
  videoBlockToInline,
  type ResolvedRequestVideos,
} from '../src/host/common/video-request.ts'
import { videoOmissionText } from '../src/host/minimax-code/modalities.ts'

function options(messages: Message[]): GenerateOptions {
  return { model: 'MiniMax-M3', messages } as GenerateOptions
}

function clip(id: string, bytes: number): Message {
  return {
    role: 'user',
    content: [{
      type: 'video',
      attachment: { attachmentId: id, mediaType: 'video/mp4', bytes },
    }],
  } as unknown as Message
}

function countClips(options: GenerateOptions): number {
  return options.messages.reduce((total, message) => {
    const content = message.content
    if (!Array.isArray(content)) return total
    return total + content.filter((block) => (block as { type?: string }).type === 'video').length
  }, 0)
}

/**
 * The shared layer, tested once against a caller that is not its own line.
 *
 * Kimi is the origin of this code and minimax the second user, so the tests that
 * matter most are the ones that would fail if a shared change quietly assumed
 * Kimi's wire - the base64 framing in particular, which is the one thing the two
 * endpoints spell differently.
 */
describe('shared video request layer', () => {
  it('drops the oldest clips once the budget is exceeded', () => {
    // base64LengthOf(800) = 1068 per clip, so 1200 keeps exactly one.
    const trimmed = offloadOldestRequestVideos(
      options([clip('a', 800), clip('b', 800), clip('c', 800)]),
      1200,
    )
    expect(countClips(trimmed)).toBe(1)
  })

  it('leaves a request under the budget untouched', () => {
    const original = options([clip('a', 100)])
    expect(offloadOldestRequestVideos(original, 1000)).toBe(original)
  })

  it('resolves nothing when no reader is installed', async () => {
    const resolved = await resolveRequestVideos(options([clip('a', 10)]), undefined)
    expect(resolved.get('a')).toEqual({ kind: 'unavailable' })
  })

  it('base64-encodes a clip through the reader', async () => {
    const resolved = await resolveRequestVideos(options([clip('a', 3)]), {
      readVideo: async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'video/mp4' }),
    })
    expect(resolved.get('a')).toEqual({ kind: 'inline', mediaType: 'video/mp4', data: 'AQID' })
  })

  it('passes the raw encoding through, with no data-URL wrapper', () => {
    const videos: ResolvedRequestVideos = new Map([
      ['a', { kind: 'inline', mediaType: 'video/mp4', data: 'AQID' }],
    ])
    const outcome = videoBlockToInline(
      { type: 'video', attachment: { attachmentId: 'a' } },
      videos,
      true,
      videoOmissionText,
    )
    // MiniMax decodes this field as bare base64: a data-URL prefix fails at the
    // ':' because it is not a base64 character. Kimi's video_url is the shape
    // that DOES take a data URL, so the framing is deliberately not shared.
    expect('inline' in outcome && outcome.inline.data).toBe('AQID')
  })

  it('rejects a container the endpoints do not accept', () => {
    const videos: ResolvedRequestVideos = new Map([
      ['a', { kind: 'inline', mediaType: 'application/x-dvd', data: 'AQID' }],
    ])
    const outcome = videoBlockToInline(
      { type: 'video', attachment: { attachmentId: 'a' } },
      videos,
      true,
      videoOmissionText,
    )
    expect('omission' in outcome && outcome.omission).toContain('container')
  })

  it('names the models that take video when the selection cannot carry one', () => {
    const outcome = videoBlockToInline(
      { type: 'video', attachment: { attachmentId: 'a' } },
      new Map(),
      false,
      videoOmissionText,
    )
    expect('omission' in outcome && outcome.omission).toContain('MiniMax-M3')
  })
})