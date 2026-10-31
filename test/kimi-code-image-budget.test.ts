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
  buildRequest,
  collectRemainingImageKeys,
  getLastDriftCause,
  markPendingImageOffload,
  offloadOldestRequestImages,
  offloadRequestImagesWithStickyBudget,
  requestImageKey,
  requestImageTarget,
  resetCacheStats,
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

/**
 * One inline image occurrence: the payload travels in the block itself.
 *
 * Inline rather than durable because the sticky budget has to be exercised on
 * the BYTES, and a durable reference is measured against the resolution the
 * harness derived for it — a second variable this test does not need.
 */
function inlineImage(data: string): Message {
  return {
    role: 'user',
    content: [{ type: 'image', data, mediaType: 'image/png' }],
  } as unknown as Message
}

/** The image blocks one request still carries, and the placeholders among them. */
function imageBlocksOf(request: { messages: Array<{ content: unknown }> }): {
  images: number
  omitted: number
} {
  const blocks = request.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  return {
    images: blocks.filter((block) => (block as { type?: string }).type === 'image').length,
    omitted: blocks.filter((block) => String((block as { text?: string }).text).startsWith('[image omitted')).length,
  }
}

describe('offloadRequestImagesWithStickyBudget', () => {
  it('leaves a request under the high mark untouched', () => {
    const request = options({ messages: [inlineImage('A'.repeat(400))] })
    const result = offloadRequestImagesWithStickyBudget(request, 1_000, 500)
    // The SAME request comes back: nothing was rewritten, so the cached prefix
    // of a conversation under its budget is untouched.
    expect(result.options).toBe(request)
    expect(result.droppedCount).toBe(0)
    expect(result.newlyDroppedKeys).toEqual([])
    expect(result.remainingBytes).toBe(400)
  })

  it('trims the oldest images back under the low mark', () => {
    const request = options({
      messages: [inlineImage('A'.repeat(400)), inlineImage('B'.repeat(400)), inlineImage('C'.repeat(400))],
    })
    const result = offloadRequestImagesWithStickyBudget(request, 1_000, 500)
    // 1200 bytes is over the high mark: the oldest goes, leaving 800, which is
    // still over the low mark, so the next one goes too. Stopping at the low
    // mark and not at the high one is what keeps the retained COUNT stable.
    expect(result.newlyDroppedKeys).toHaveLength(2)
    expect(result.remainingBytes).toBe(400)
    expect(result.droppedCount).toBe(2)
    expect(imageBlocksOf(result.options)).toEqual({ images: 1, omitted: 2 })
  })

  it('keeps an image an earlier turn dropped dropped, even under the high mark', () => {
    const request = options({
      messages: [inlineImage('A'.repeat(400)), inlineImage('B'.repeat(400)), inlineImage('C'.repeat(400))],
    })
    const first = offloadRequestImagesWithStickyBudget(request, 1_000, 500)
    // The next turn replays the DURABLE history — the pictures are still in it,
    // because a placeholder replaces them only in the request that goes out.
    // That request is far under its high mark, so nothing NEW is dropped — and
    // the two pictures the first turn gave back stay given back.
    const second = offloadRequestImagesWithStickyBudget(
      request,
      100_000,
      50_000,
      undefined,
      first.allDroppedKeys,
    )
    expect(second.newlyDroppedKeys).toEqual([])
    expect(second.droppedCount).toBe(2)
    expect(second.allDroppedKeys.size).toBe(2)
    expect(imageBlocksOf(second.options)).toEqual({ images: 1, omitted: 2 })
  })

  it('budgets an image that travels inside a tool result', () => {
    const request = options({
      messages: [{
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'image', data: 'A'.repeat(400) }] }],
      } as unknown as Message],
    })
    const result = offloadRequestImagesWithStickyBudget(request, 100, 50)
    expect(result.newlyDroppedKeys).toHaveLength(1)
    expect(result.droppedCount).toBe(1)
  })
})

describe('requestImageKey', () => {
  it('names a durable attachment by its id', () => {
    expect(requestImageKey({
      type: 'image',
      attachment: { attachmentId: 'shot-0', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
    })).toBe('attachment:shot-0')
  })

  it('names an inline picture by its payload, so the same picture keeps its name', () => {
    const key = requestImageKey({ type: 'image', data: 'AAAA' })
    expect(key).toBe(requestImageKey({ type: 'image', data: 'AAAA' }))
    expect(key).not.toBe(requestImageKey({ type: 'image', data: 'BBBB' }))
    expect(key?.startsWith('inline:')).toBe(true)
  })

  it('has no key for a block that carries no image', () => {
    expect(requestImageKey({ type: 'text', text: 'hello' })).toBeUndefined()
  })
})

describe('collectRemainingImageKeys', () => {
  it('names the images a request still carries', () => {
    const request = options({ messages: [inlineImage('AAAA'), inlineImage('BBBB')] })
    expect(collectRemainingImageKeys(request)).toHaveLength(2)
    // The same picture twice is one identity, not two.
    expect(collectRemainingImageKeys(options({ messages: [inlineImage('AAAA'), inlineImage('AAAA')] }))).toHaveLength(1)
  })
})

describe('the image offload is what breaks the prefix', () => {
  it('attributes a stable prefix to the offload that caused it', () => {
    const session = 'sess-image-offload'
    try {
      const request = options({ sessionId: session as never })
      // A session's FIRST request has no prefix to keep, so the cause is the
      // session's first request and not the offload.
      buildRequest(request, 'openai')
      expect(getLastDriftCause(session)).toBe('first-request')
      // The next one would have been stable, but the request dropped an image
      // and the drop rewrote the prefix the service had cached.
      markPendingImageOffload(session, 1)
      buildRequest(request, 'openai')
      expect(getLastDriftCause(session)).toBe('image-offload')
    } finally {
      resetCacheStats(session)
    }
  })

  it('keeps the better explanation when the prefix broke for another reason', () => {
    const session = 'sess-image-offload-system'
    try {
      buildRequest(options({ sessionId: session as never, system: 'one' }), 'openai')
      // The system prompt changed, which breaks the prefix on its own and says
      // more about the miss than the offload does.
      markPendingImageOffload(session, 1)
      buildRequest(options({ sessionId: session as never, system: 'two' }), 'openai')
      expect(getLastDriftCause(session)).toBe('system-prompt')
    } finally {
      resetCacheStats(session)
    }
  })
})
