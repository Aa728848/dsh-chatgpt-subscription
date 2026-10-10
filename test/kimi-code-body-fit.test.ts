/**
 * Why the kimi-code route measures the bytes it SENDS and recovers by dropping
 * only as many images as fit.
 *
 * Three defects share one root cause — the request body was judged before anyone
 * knew what it would weigh:
 *
 * 1. The budget measured `attachment.bytes`, the STORED image, while
 *    `resolveRequestImages` scales anything over 1024px on the long edge down to
 *    a ~256 KiB request version first. A 5 MB screenshot was therefore counted as
 *    ~6.7 MB of base64, judged 5 MB over budget, and dropped — even though the
 *    version about to go on the wire was 350 KiB and four of them fit. Kimi's own
 *    client compresses before delivery "to avoid the supplier erroring on an
 *    oversized image"; measuring after that transform is the same rule.
 * 2. Images inside tool results were never counted at all, though
 *    `toolResultBlocks` sends them. A session built on `read_image` understated
 *    its own image payload by whatever the tool results carried.
 * 3. The body guard only refused. One more dropped image would have fit, so a
 *    request the upstream would have accepted died in the client.
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock, GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  MAX_MESSAGE_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  imagesToOffloadCount,
  offloadOldestRequestImages,
  replaceOldestRequestImages,
  requestHasSendableImage,
  requestImagePayloadLengths,
  resolveRequestImages,
  type ResolvedRequestImages,
} from '../src/host/common/request-images.ts'
import {
  assertRequestBodyFits,
  buildAnthropicRequest,
  requestBodyBreakdown,
} from '../src/host/kimi-code/mapper.ts'

interface Ref {
  attachmentId: string
  width: number
  height: number
  bytes: number
  mediaType: string
}

function refOf(value: Ref) {
  return value as never
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { model: 'k3', messages: [], ...overrides } as GenerateOptions
}

function imageMessage(ref: Ref): Message {
  return {
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height } },
    ],
  } as unknown as Message
}

/** One tool result carrying one image, the shape a `read_image` call produces. */
function toolResultImageMessage(ref: Ref): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [
          { type: 'image', attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height } },
        ],
      },
    ],
  } as unknown as Message
}

/** Reader whose request version is exactly `scaledBytes`, regardless of the stored size. */
function reader(images: Ref[], scaledBytes: number) {
  const seen: Array<{ id: string; target: { width: number; height: number; maxBytes: number } | undefined }> = []
  return {
    seen,
    async readImage(ref: { attachmentId: string }) {
      const stored = images.find((image) => image.attachmentId === ref.attachmentId)
      if (stored === undefined) throw new Error(`no stored image ${ref.attachmentId}`)
      return {
        ref: { attachmentId: stored.attachmentId, mediaType: stored.mediaType, bytes: stored.bytes, width: stored.width, height: stored.height },
        data: new Uint8Array(scaledBytes),
      }
    },
    async readImageRequest(
      ref: { attachmentId: string },
      target: { width: number; height: number; maxBytes: number },
    ) {
      seen.push({ id: ref.attachmentId, target })
      const stored = images.find((image) => image.attachmentId === ref.attachmentId)
      if (stored === undefined) throw new Error(`no stored image ${ref.attachmentId}`)
      return {
        attachment: { ...stored },
        variantId: `variant-${ref.attachmentId}`,
        data: new Uint8Array(scaledBytes),
        mediaType: stored.mediaType,
        bytes: scaledBytes,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
}

function omittedCount(messages: Message[]): number {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      if (block.type === 'text' && String((block as { text?: string }).text).startsWith('[image omitted')) return [block]
      const content = (block as { content?: unknown }).content
      if (!Array.isArray(content)) return []
      return content.filter((inner) => inner.type === 'text' && String((inner as { text?: string }).text).startsWith('[image omitted'))
    }).length
}

/** A 5 MB screenshot: far over the per-image target, but tiny after scaling. */
const HUGE_SCREENSHOT: Ref = { attachmentId: 'huge', width: 3840, height: 2160, bytes: 5_000_000, mediaType: 'image/png' }
/** What it actually weighs on the wire: 256 KiB raw, ~350 KiB of base64. */
const SCALED_BASE64 = Math.ceil((256 * 1024) / 3) * 4

describe('measuring the bytes that are sent', () => {
  it('keeps an oversized image that fits once scaled', async () => {
    const messages = [imageMessage(HUGE_SCREENSHOT)]
    const images = await resolveRequestImages(options({ messages }), reader([HUGE_SCREENSHOT], 256 * 1024) as never)

    // Stored bytes would report ~6.7 MB and drop it; the wire carries 350 KiB.
    expect(requestImagePayloadLengths(options({ messages }))[0]).toBeGreaterThan(MAX_REQUEST_IMAGE_BYTES)
    expect(requestImagePayloadLengths(options({ messages }), images)[0]).toBe(SCALED_BASE64)

    const kept = offloadOldestRequestImages(options({ messages }), MAX_REQUEST_IMAGE_BYTES, images)
    expect(omittedCount(kept.messages)).toBe(0)
    expect(requestHasSendableImage(kept)).toBe(true)
  })

  it('counts images carried inside tool results', async () => {
    const messages = [toolResultImageMessage(HUGE_SCREENSHOT)]
    // Uncounted before: the collector only walked top-level blocks.
    expect(requestImagePayloadLengths(options({ messages }))).toHaveLength(1)

    const trimmed = replaceOldestRequestImages(options({ messages }), 1)
    expect(omittedCount(trimmed.messages)).toBe(1)
    expect(requestHasSendableImage(trimmed)).toBe(false)
  })

  it('leaves the no-resolved-map path on stored bytes', () => {
    const messages = [imageMessage({ attachmentId: 's', width: 640, height: 480, bytes: 12_000, mediaType: 'image/png' })]
    expect(requestImagePayloadLengths(options({ messages }))).toEqual([16_000])
  })

  it('stops at the exact count that fits', () => {
    const lengths = [1000, 1000, 1000, 1000]
    expect(imagesToOffloadCount(lengths, 4000)).toBe(0)
    expect(imagesToOffloadCount(lengths, 3000)).toBe(1)
    expect(imagesToOffloadCount(lengths, 1500)).toBe(3)
  })
})

describe('composing an oversized-body diagnostic', () => {
  // 2.1 MB of base64 in one image: over the 2 MiB ceiling on its own.
  const imageBody = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2_100_000)}` } }],
      },
    ],
    tools: [{ type: 'function', function: { name: 'x', description: 'y'.repeat(5_000) } }],
  }

  it('splits images, tool schemas and text', () => {
    const parts = requestBodyBreakdown(imageBody)
    expect(parts.imageBytes).toBeGreaterThan(2_000_000)
    expect(parts.toolSchemaBytes).toBeGreaterThan(4_000)
    expect(parts.otherBytes).toBeGreaterThanOrEqual(0)
    expect(parts.totalBytes).toBe(
      parts.imageBytes + parts.toolSchemaBytes + parts.otherBytes,
    )
  })

  it('names images as the remedy when they dominate', () => {
    expect(() => assertRequestBodyFits(imageBody)).toThrow(/Older images are omitted first/)
    expect(() => assertRequestBodyFits(imageBody)).toThrow(/images \d+ bytes/)
  })

  it('names compaction when text dominates instead', () => {
    const textBody = {
      messages: [{ role: 'user', content: 'x'.repeat(2_400_000) }],
      tools: [],
    }
    // No image budget can fix this, so the message must not send the user to
    // delete pictures that were never the problem.
    expect(() => assertRequestBodyFits(textBody)).toThrow(/compact the conversation/i)
    expect(() => assertRequestBodyFits(textBody)).not.toThrow(/Older images/)
  })

  it('does not count a user message that merely mentions data URLs', () => {
    const decoy = {
      messages: [{ role: 'user', content: 'data:image/png;base64,AAAA and video_url in prose' }],
    }
    expect(requestBodyBreakdown(decoy).imageBytes).toBe(0)
  })
})

/**
 * #51: the guard and the counter must be the same question.
 *
 * collectRequestImagePayloads recursed into a tool-result and
 * requestHasSendableImage did not, so for a session whose images all arrive
 * through tool results — what read_image and every screenshot tool produce —
 * the counter saw the images while the guard answered "nothing left to give
 * back". The body-fit loop short-circuited on that answer and threw with every
 * image still attached, while telling the user older images had been omitted.
 *
 * The nesting itself is pinned elsewhere: normalizeMessages is what puts a
 * tool message's images inside tool-result.content (test/llm-compat.test.ts).
 */
describe('the sendable-image guard agrees with the image counter', () => {
  /** 1,044,470 bytes of PNG: about 1,392,628 base64 characters on the wire. */
  const SHOT: Ref = { attachmentId: 'shot', width: 3840, height: 2160, bytes: 1_044_470, mediaType: 'image/png' }
  /** An image the reader could not load; the mapper sends it as text instead. */
  const BROKEN: Ref = { attachmentId: 'broken', width: 640, height: 480, bytes: 500_000, mediaType: 'image/png' }
  const INLINE_BASE64 = 1_392_628

  function inline(id: string): ResolvedRequestImages {
    return new Map([[id, { kind: 'inline' as const, mediaType: 'image/png', data: 'A'.repeat(INLINE_BASE64) }]])
  }

  function imageContent(...refs: Ref[]) {
    return refs.map((ref) => ({
      type: 'image',
      attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
    }))
  }

  /** Every image occurrence still present, at any nesting depth, by attachment id. */
  function survivingImageIds(messages: Message[]): string[] {
    return messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .flatMap((block) => {
        const nested = (block as { content?: unknown }).content
        const list = Array.isArray(nested) ? nested : [block]
        return list
          .filter((inner) => typeof inner === 'object' && inner !== null && (inner as { type?: string }).type === 'image')
          .map((inner) => String((inner as { attachment?: { attachmentId?: string } }).attachment?.attachmentId))
      })
  }

  it('sees a tool-result image while the counter can still see it', () => {
    // The state #51 got wrong: the image has not been dropped yet.
    const opts = options({ messages: [toolResultImageMessage(SHOT)] })
    const images = inline(SHOT.attachmentId)

    expect(requestImagePayloadLengths(opts, images)).toHaveLength(1)
    // THE INVARIANT — before the fix the right side was false with a length of 1.
    expect(requestHasSendableImage(opts, images)).toBe(requestImagePayloadLengths(opts, images).length > 0)
    expect(requestHasSendableImage(opts, images)).toBe(true)
  })

  it('recovers an over-limit body rather than refusing it', () => {
    const opts = options({
      messages: [{
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'x'.repeat(900_000) }, ...imageContent(SHOT)],
        }],
      }] as unknown as Message[],
    })
    const images = inline(SHOT.attachmentId)

    const before = buildAnthropicRequest(opts, images)
    // The reported shape: the image plus the conversation just cross 2 MiB.
    expect(Buffer.byteLength(JSON.stringify(before), 'utf8')).toBeGreaterThan(MAX_MESSAGE_BODY_BYTES)
    expect(() => assertRequestBodyFits(before)).toThrow()

    // One dropped image is enough, so the guard must let the loop reach it.
    const repaired = replaceOldestRequestImages(opts, 1, images)
    const repairedBody = buildAnthropicRequest(repaired, images)
    expect(Buffer.byteLength(JSON.stringify(repairedBody), 'utf8')).toBeLessThan(MAX_MESSAGE_BODY_BYTES)
    expect(() => assertRequestBodyFits(repairedBody)).not.toThrow()
  })

  it('still sees a top-level image', () => {
    // Guards the fix against being pushed the other way.
    const opts = options({ messages: [imageMessage(SHOT)] })
    const images = inline(SHOT.attachmentId)

    expect(requestImagePayloadLengths(opts, images)).toHaveLength(1)
    expect(requestHasSendableImage(opts, images)).toBe(true)
  })

  it('does not report an unreadable image as sendable', () => {
    // The mapper serializes this one as a text placeholder, so it frees no
    // bytes and dropping it would only spin the loop.
    const opts = options({ messages: [toolResultImageMessage(SHOT)] })
    const images: ResolvedRequestImages = new Map([[SHOT.attachmentId, { kind: 'unavailable' as const }]])

    expect(requestImagePayloadLengths(opts, images)).toEqual([])
    expect(requestHasSendableImage(opts, images)).toBe(false)
  })

  it('spends a replacement on an image that actually carries bytes', () => {
    // countOmitted, requestImagePayloadLengths and replaceOldestRequestImages
    // had measured with different resolutions: the measured list skipped the
    // unreadable image while the replacement still spent a slot on it, so a
    // request under-dropped until the loop gave up.
    const opts = options({
      messages: [{
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: imageContent(BROKEN, SHOT) }],
      }] as unknown as Message[],
    })
    const images: ResolvedRequestImages = new Map([
      [BROKEN.attachmentId, { kind: 'unavailable' as const }],
      [SHOT.attachmentId, { kind: 'inline' as const, mediaType: 'image/png', data: 'A'.repeat(INLINE_BASE64) }],
    ])

    // Only the second occurrence is measured, so index 0 names the second image.
    expect(requestImagePayloadLengths(opts, images)).toHaveLength(1)

    const trimmed = replaceOldestRequestImages(opts, 1, images)
    expect(omittedCount(trimmed.messages)).toBe(1)
    // The slot went to the image that frees bytes, not to the unreadable one.
    expect(survivingImageIds(trimmed.messages)).toEqual([BROKEN.attachmentId])
  })
})
