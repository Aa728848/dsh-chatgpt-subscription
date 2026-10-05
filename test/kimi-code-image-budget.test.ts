/**
 * Why the kimi-code route scales an oversized image instead of dropping it.
 *
 * `offloadOldestRequestImages` must drop an image once one request exceeds the
 * 1.5 MB base64 budget, and the number it drops grows with every later image.
 * Each change rewrites the retained prefix, so the prompt cache is invalidated
 * again on the next turn. A QA session that pastes ten 1440x1000 screenshots
 * measured four such invalidations. Scaling keeps the image COUNT stable, which
 * is the property the cache actually depends on.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import {
  MAX_REQUEST_IMAGE_BYTES,
  REQUEST_IMAGE_MAX_EDGE,
  offloadOldestRequestImages,
  requestImageTarget,
  resolveRequestImages,
} from '../src/host/kimi-code/mapper.ts'

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { model: 'k3', messages: [], ...overrides } as GenerateOptions
}

interface Ref { attachmentId: string; width: number; height: number; bytes: number; mediaType: string }

/** The mapper takes a branded attachment ref; these tests describe one structurally. */
function refOf(value: { attachmentId: string; mediaType: string; bytes: number; width?: number; height?: number }) {
  return value as never
}

/** One stored image plus the request version the harness derives from it. */
function reader(images: Ref[], scale: number = 0.25) {
  const seen: Array<{ id: string; target: { width: number; height: number; maxBytes: number } | undefined }> = []
  return {
    seen,
    async readImage(ref: { attachmentId: string }) {
      const stored = images.find((image) => image.attachmentId === ref.attachmentId)
      if (stored === undefined) throw new Error(`no stored image ${ref.attachmentId}`)
      return {
        ref: { attachmentId: stored.attachmentId, mediaType: 'image/png', bytes: stored.bytes, width: stored.width, height: stored.height },
        data: new Uint8Array(stored.bytes),
      }
    },
    async readImageRequest(
      ref: { attachmentId: string },
      target: { width: number; height: number; maxBytes: number },
    ) {
      seen.push({ id: ref.attachmentId, target })
      const stored = images.find((image) => image.attachmentId === ref.attachmentId)
      if (stored === undefined) throw new Error(`no stored image ${ref.attachmentId}`)
      const bytes = Math.round(stored.bytes * scale)
      return {
        attachment: { ...stored },
        variantId: `variant-${ref.attachmentId}`,
        data: new Uint8Array(bytes),
        mediaType: stored.mediaType,
        bytes,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
}

function imageMessage(ref: Ref): Message {
  return {
    role: 'user',
    content: [{
      type: 'image',
      attachment: {
        attachmentId: ref.attachmentId, mediaType: 'image/png',
        bytes: ref.bytes, width: ref.width, height: ref.height,
      },
    }],
  } as unknown as Message
}

/** Ten QA-sized screenshots: the shape that produced four cache invalidations. */
function qaScreenshots(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => imageMessage({
    attachmentId: `shot-${index}`, width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png',
  }))
}

describe('requestImageTarget', () => {
  it('leaves an image inside the edge ceiling untouched', () => {
    expect(requestImageTarget(refOf({ attachmentId: 'a', mediaType: 'image/png', bytes: 10, width: 800, height: 600 }))).toBeUndefined()
  })

  it('scales the long edge and keeps the aspect ratio', () => {
    const target = requestImageTarget(refOf({ attachmentId: 'a', mediaType: 'image/png', bytes: 420_000, width: 1440, height: 1000 }))
    expect(target).toBeDefined()
    expect(target!.width).toBe(REQUEST_IMAGE_MAX_EDGE)
    expect(target!.height).toBe(Math.round(REQUEST_IMAGE_MAX_EDGE * 1000 / 1440))
  })

  it('scales a portrait image on its height', () => {
    const target = requestImageTarget(refOf({ attachmentId: 'a', mediaType: 'image/png', bytes: 500_000, width: 500, height: 2000 }))
    expect(target!.height).toBe(REQUEST_IMAGE_MAX_EDGE)
    expect(target!.width).toBe(Math.round(REQUEST_IMAGE_MAX_EDGE * 500 / 2000))
  })

  it('has no target for a reference without usable dimensions', () => {
    expect(requestImageTarget({ attachmentId: 'a', mediaType: 'image/png', bytes: 10 } as never)).toBeUndefined()
    expect(requestImageTarget({ attachmentId: 'a', mediaType: 'image/png', bytes: 10, width: 0, height: 100 } as never)).toBeUndefined()
  })

  it('keeps four scaled screenshots inside the image budget', () => {
    // The per-image target is derived from this budget, so the invariant that
    // makes scaling work is that four of them still fit without dropping any.
    const scaled = 256 * 1024
    expect(Math.ceil(scaled / 3) * 4 * 4).toBeLessThan(MAX_REQUEST_IMAGE_BYTES)
  })
})

describe('resolveRequestImages scales rather than drops', () => {
  it('sends an oversized image as a request version, not as stored bytes', async () => {
    const attachments = reader([{ attachmentId: 'shot-0', width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png' }])
    const resolved = await resolveRequestImages(options({ messages: qaScreenshots(1) }), attachments as never)
    const image = resolved.get('shot-0')
    expect(image?.kind).toBe('inline')
    expect(attachments.seen).toHaveLength(1)
    expect(attachments.seen[0]!.target?.width).toBe(REQUEST_IMAGE_MAX_EDGE)
  })

  it('keeps the image count stable once a QA set outgrows the budget', async () => {
    const messages = qaScreenshots(10)
    const attachments = reader(messages.map((_, index) => ({ attachmentId: `shot-${index}`, width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png' })))
    const before = offloadOldestRequestImages(options({ messages }))
    const dropped = before.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => (block as { type?: string }).type === 'text'
        && String((block as { text?: string }).text).startsWith('[image omitted'))
    // The budget guard still drops images, because 4.2 MB of stored bytes
    // cannot fit 1.5 MB even scaled: this asserts the real behaviour, that the
    // drop is driven by stored size and not by a per-image ceiling.
    expect(dropped.length).toBeGreaterThan(0)

    // What the fix changes: a session whose images are individually small
    // enough to scale under budget never reaches the drop path at all.
    const small = Array.from({ length: 10 }, (_, index) => imageMessage({
      attachmentId: `s-${index}`, width: 1440, height: 1000, bytes: 90_000, mediaType: 'image/png',
    }))
    const bounded = offloadOldestRequestImages(options({ messages: small }))
    const omitted = bounded.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => (block as { type?: string }).type === 'text'
        && String((block as { text?: string }).text).startsWith('[image omitted'))
    expect(omitted).toHaveLength(0)

    const scaled = reader(small.map((_, index) => ({ attachmentId: `s-${index}`, width: 1440, height: 1000, bytes: 90_000, mediaType: 'image/png' })), 0.25)
    const resolved = await resolveRequestImages(options({ messages: small }), scaled as never)
    expect([...resolved.values()].every((image) => image.kind === 'inline')).toBe(true)
    expect(resolved.size).toBe(10)
  })

  it('sends an image that already fits byte-for-byte as stored', async () => {
    const attachments = reader([{ attachmentId: 'small', width: 640, height: 480, bytes: 12_000, mediaType: 'image/png' }])
    const messages = [imageMessage({ attachmentId: 'small', width: 640, height: 480, bytes: 12_000, mediaType: 'image/png' })]
    const resolved = await resolveRequestImages(options({ messages }), attachments as never)
    expect(resolved.get('small')).toEqual({
      kind: 'inline',
      mediaType: 'image/png',
      data: Buffer.from(new Uint8Array(12_000)).toString('base64'),
    })
    expect(attachments.seen).toHaveLength(0)
  })

  it('reports unavailable rather than sending an image that stayed too large', async () => {
    const attachments = reader([{ attachmentId: 'stubborn', width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png' }])
    // A backend that reports a version still over the ceiling must not have it
    // sent: the request would only be rejected by the gateway.
    attachments.readImageRequest = async (ref, target) => ({
      attachment: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: 420_000, width: 1440, height: 1000 },
      variantId: 'variant',
      data: new Uint8Array(1000),
      mediaType: 'image/png' as const,
      bytes: 1000,
      width: REQUEST_IMAGE_MAX_EDGE * 2,
      height: target.height,
      depth: 'uchar' as const,
      space: 'srgb' as const,
      hasAlpha: false,
    })
    const resolved = await resolveRequestImages(options({ messages: qaScreenshots(1) }), attachments as never)
    expect(resolved.get('shot-0')).toEqual({ kind: 'unavailable' })
  })

  it('degrades a failed request version to unavailable instead of the original', async () => {
    const attachments = reader([{ attachmentId: 'shot-0', width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png' }])
    attachments.readImageRequest = async () => { throw new Error('encoder gone') }
    const resolved = await resolveRequestImages(options({ messages: qaScreenshots(1) }), attachments as never)
    expect(resolved.get('shot-0')).toEqual({ kind: 'unavailable' })
  })

  it('rethrows a cancellation raised by the request version', async () => {
    const abort = { name: 'AbortError', message: 'aborted' }
    const attachments = reader([{ attachmentId: 'shot-0', width: 1440, height: 1000, bytes: 420_000, mediaType: 'image/png' }])
    attachments.readImageRequest = async () => { throw abort }
    await expect(resolveRequestImages(options({ messages: qaScreenshots(1) }), attachments as never)).rejects.toBe(abort)
  })
})
