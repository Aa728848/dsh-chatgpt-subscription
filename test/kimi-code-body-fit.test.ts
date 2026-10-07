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
