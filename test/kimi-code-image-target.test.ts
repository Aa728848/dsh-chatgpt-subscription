/**
 * Why the kimi-code route asks for a longer request version than every other
 * route, and why the SAME ceiling has to reach the wire.
 *
 * Kimi's own CLI downscales an oversized image to a 2000 px long edge by default,
 * so a screenshot its client sends at 2000 px must not be handed to this route at
 * the shared 1024 px ceiling. The encoded-byte target stays the shared 256 KiB
 * one, and an image that already fits is sent as stored — those two are what the
 * request-version budget and the body-fit guard are built on.
 *
 * The declaration (`imageRequestTarget`) and the request itself
 * (`resolveRequestImages`) are asserted against each other on purpose: deriving
 * the target from one ceiling and validating the returned version against another
 * discards a correct 2000 px version as if the store had ignored the request.
 */
import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'
import { resolveRequestImages } from '../src/host/common/request-images.ts'
import { KIMI_CODE_REQUEST_IMAGE_MAX_EDGE, KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'

/** Kimi's own CLI default, mirrored by this route. */
const CLI_EDGE = KIMI_CODE_REQUEST_IMAGE_MAX_EDGE
/** Shared per-image encoded-byte target, which must NOT move with the edge. */
const VERSION_MAX_BYTES = 256 * 1024

const kimi = new KimiCodeAdapter()

function ref(values: { width?: number; height?: number; bytes?: number }): ImageAttachmentRef {
  return {
    attachmentId: 'shot', mediaType: 'image/png', bytes: values.bytes ?? 5_000_000, ...values,
  } as ImageAttachmentRef
}

function targetOf(image: ImageAttachmentRef) {
  return kimi.imageRequestTarget('kimi-code', 'k3', image)
}

function expectedTarget(width: number, height: number) {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const scaledShort = Math.max(1, Math.round(CLI_EDGE * short / long))
  const maxPixels = Math.floor(CLI_EDGE * CLI_EDGE * (short / long))
  return width >= height
    ? { width: CLI_EDGE, height: scaledShort, maxPixels, maxBytes: VERSION_MAX_BYTES }
    : { width: scaledShort, height: CLI_EDGE, maxPixels, maxBytes: VERSION_MAX_BYTES }
}

describe('kimi-code image request target', () => {
  it('asks for a 2000 px long edge instead of the shared 1024 px', () => {
    // 2048x1024 used to come back as 1024x512: the exact case this change is for.
    expect(targetOf(ref({ width: 2048, height: 1024 }))).toEqual(expectedTarget(2048, 1024))
    expect(targetOf(ref({ width: 2048, height: 1024 }))!.width).toBe(CLI_EDGE)
  })

  it('keeps the aspect ratio of a portrait image on the long edge', () => {
    const target = targetOf(ref({ width: 1000, height: 3000 }))
    expect(target).toEqual(expectedTarget(1000, 3000))
    expect(target!.height).toBe(CLI_EDGE)
    expect(target!.width).toBe(Math.round(CLI_EDGE * 1000 / 3000))
  })

  it('no longer scales an image whose long edge is between 1025 and 2000', () => {
    // The band the old shared ceiling reshaped and the official one does not.
    for (const [width, height] of [[1440, 1000], [1920, 1080], [2000, 1500], [1500, 2000]]) {
      expect(targetOf(ref({ width, height, bytes: 420_000 }))).toEqual({ width, height, maxBytes: 420_000 })
    }
  })

  it('sends an image inside the 2000 px edge exactly as stored', () => {
    expect(targetOf(ref({ width: 2000, height: 2000, bytes: 900_000 }))).toEqual({ width: 2000, height: 2000, maxBytes: 900_000 })
    expect(targetOf(ref({ width: 800, height: 600, bytes: 100_000 }))).toEqual({ width: 800, height: 600, maxBytes: 100_000 })
  })

  it('keeps the shared 256 KiB per-image budget and its derived maxPixels', () => {
    const target = targetOf(ref({ width: 4000, height: 1000 }))
    // 4000 px is over the ceiling, so the scaled target — the only shape that
    // carries `maxPixels` — is the one this route has to produce here. The check
    // is explicit rather than assumed: asserting on a union member it may not
    // have would either not compile or pass on the wrong branch.
    if (target === undefined || !('maxPixels' in target)) {
      throw new Error('a 4000 px image must resolve to a scaled target carrying maxPixels, not the original image')
    }
    expect(target.maxBytes).toBe(VERSION_MAX_BYTES)
    expect(target.maxPixels).toBe(Math.floor(CLI_EDGE * CLI_EDGE * (1000 / 4000)))
    // Four request versions plus conversation text still fit the shared body.
    expect(Math.ceil(VERSION_MAX_BYTES / 3) * 4 * 4).toBeLessThan(1_500_000)
  })

  it('has no target for a reference without usable dimensions', () => {
    expect(targetOf(ref({ bytes: 10 }))).toEqual({ width: undefined, height: undefined, maxBytes: 10 })
    expect(targetOf(ref({ width: 0, height: 100, bytes: 10 }))).toEqual({ width: 0, height: 100, maxBytes: 10 })
  })

  it('leaves every other route on the shared 1024 px ceiling', () => {
    const antigravity = new AntigravityAdapter()
    expect(antigravity.imageRequestTarget('antigravity', 'gemini-3.7-flash', ref({ width: 2048, height: 1024 })))
      .toEqual({ width: 1024, height: 512, maxPixels: 524_288, maxBytes: VERSION_MAX_BYTES })
  })
})

interface Stored { width: number; height: number; bytes: number }

function imageMessage(image: Stored): Message {
  return {
    role: 'user',
    content: [{
      type: 'image',
      attachment: { attachmentId: 'shot', mediaType: 'image/png', ...image },
    }],
  } as unknown as Message
}

function generateOptions(...messages: Message[]): GenerateOptions {
  return { model: 'k3', messages } as GenerateOptions
}

/**
 * An attachment store that records what it was asked for and hands back a
 * request version at the requested dimensions — the shape a real store produces.
 * `answered` overrides those dimensions, which is what a store ignoring the
 * target looks like.
 */
function store(stored: Stored, answered: { width?: number; height?: number } = {}) {
  const asked: Array<{ width: number; height: number; maxBytes: number }> = []
  const readStored = { count: 0 }
  return {
    asked,
    readStored,
    async readImage(refArg: { attachmentId: string }) {
      readStored.count += 1
      return {
        ref: {
          attachmentId: refArg.attachmentId, mediaType: 'image/png',
          bytes: stored.bytes, width: stored.width, height: stored.height,
        },
        data: new Uint8Array(stored.bytes),
      }
    },
    async readImageRequest(refArg: { attachmentId: string }, target: { width: number; height: number; maxBytes: number }) {
      asked.push(target)
      return {
        attachment: {
          attachmentId: refArg.attachmentId, mediaType: 'image/png',
          bytes: stored.bytes, width: stored.width, height: stored.height,
        },
        variantId: `variant-${refArg.attachmentId}`,
        data: new Uint8Array(Math.min(stored.bytes, target.maxBytes)),
        mediaType: 'image/png',
        bytes: Math.min(stored.bytes, target.maxBytes),
        width: answered.width ?? target.width,
        height: answered.height ?? target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
}

const oversized = { width: 2048, height: 1024, bytes: 5_000_000 }

describe('kimi-code wire path uses the same 2000 px edge', () => {
  it('asks the store for exactly the target the adapter declares', async () => {
    const attachments = store(oversized)
    await resolveRequestImages(
      generateOptions(imageMessage(oversized)),
      attachments as never,
      undefined,
      CLI_EDGE,
    )
    expect(attachments.asked).toHaveLength(1)
    // One object, two readers: the declaration and the wire cannot drift.
    expect(attachments.asked[0]).toEqual(targetOf(ref(oversized)))
    expect(attachments.asked[0]!.width).toBe(CLI_EDGE)
  })

  it('keeps a version that is exactly at this route ceiling', async () => {
    // Validating the returned version against the shared 1024 constant is what
    // used to turn this correct 2000 px version into an unavailable image.
    const attachments = store(oversized)
    const resolved = await resolveRequestImages(
      generateOptions(imageMessage(oversized)),
      attachments as never,
      undefined,
      CLI_EDGE,
    )
    expect(resolved.get('shot')?.kind).toBe('inline')
  })

  it('leaves a caller that names no ceiling on the shared 1024 px', async () => {
    const attachments = store(oversized)
    const resolved = await resolveRequestImages(generateOptions(imageMessage(oversized)), attachments as never)
    expect(attachments.asked[0]!.width).toBe(1024)
    expect(attachments.asked[0]!.height).toBe(512)
    expect(attachments.asked[0]!.maxBytes).toBe(VERSION_MAX_BYTES)
    expect(resolved.get('shot')?.kind).toBe('inline')
  })

  it('still rejects a version over the default ceiling as an ignored downscale', async () => {
    const attachments = store(oversized, { width: 2000, height: 1000 })
    const resolved = await resolveRequestImages(generateOptions(imageMessage(oversized)), attachments as never)
    expect(resolved.get('shot')?.kind).toBe('unavailable')
  })

  it('sends an image between 1025 and 2000 as stored, without asking for a version', async () => {
    const stored = { width: 1440, height: 1000, bytes: 420_000 }
    const attachments = store(stored)
    const resolved = await resolveRequestImages(
      generateOptions(imageMessage(stored)),
      attachments as never,
      undefined,
      CLI_EDGE,
    )
    expect(attachments.asked).toHaveLength(0)
    expect(attachments.readStored.count).toBe(1)
    expect(resolved.get('shot')?.kind).toBe('inline')
  })

  it('still surfaces an abort instead of turning it into an unreadable image', async () => {
    const controller = new AbortController()
    controller.abort()
    const attachments = {
      async readImage() { throw new Error('cancelled') },
      async readImageRequest() { throw new Error('cancelled') },
    }
    await expect(resolveRequestImages(
      generateOptions(imageMessage(oversized)),
      attachments as never,
      controller.signal,
      CLI_EDGE,
    )).rejects.toThrow('cancelled')
  })
})
