/**
 * Image resolution, byte budgeting and data-URL handling for one request.
 *
 * Shared by the provider lines that send inline images, because the budget is a
 * property of the deployment rather than of any one endpoint, and because two
 * lines that budget differently send different request bytes for the same picture.
 *
 * The notable decision is SCALE, not drop: see {@link resolveRequestImages}.
 *
 * @module dsh-chatgpt-subscription/request-images
 */

import type { ContentBlock, GenerateOptions } from "./llm-compat.ts"
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Whether one failure is a cancellation rather than a real read failure.
 *
 * Structural rather than instanceof: DSH's own LlmError is not an Error subclass, so an
 * instanceof test fails on precisely the errors the harness throws when a caller
 * cancels.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== "object" || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === "AbortError"
}
/**
 * Attachment seam this route needs: verified bytes for one durable image, and a
 * downscaled request version of one that does not fit the image budget.
 *
 * Every harness generation in the peer range declares readImageRequest; a
 * backend that cannot derive request versions rejects the call, and that
 * rejection is handled like any other unreadable image.
 */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage' | 'readImageRequest'>

/** One durable user image resolved for an in-flight request, or proven unreadable. */
export type ResolvedRequestImage =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** Resolved images keyed by durable attachment id; consumed by one request build. */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>

export const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

/**
 * Base64 image payload one request may carry.
 *
 * Kimi rejects a request whose total message size exceeds 2 MB with a 400, and
 * the image bytes share that budget with the conversation text, tool schemas,
 * and system prompt — so the bound is deliberately the smaller of the two
 * documented limits rather than the largest body the transport would accept.
 */
export const MAX_REQUEST_IMAGE_BYTES = 1_500_000

/** Message-body ceiling the service documents for one request. */
export const MAX_MESSAGE_BODY_BYTES = 2_097_152

/**
 * Body ceiling once a request carries video.
 *
 * The 2 MB figure above is the documented limit for text and images, and it is
 * far too small for video: a single frame-sequence clip dwarfs it. Kimi's own
 * video guidance carries a separate, much larger request budget, so the ceiling
 * is raised only for a request that actually attaches video. A text-only or
 * image-only request keeps the tighter guard, because catching that 400 locally
 * is the whole reason it exists.
 */
export const MAX_VIDEO_MESSAGE_BODY_BYTES = 64 * 1024 * 1024

/**
 * Base64 video budget for one request.
 *
 * Deliberately below {@link MAX_VIDEO_MESSAGE_BODY_BYTES} so the surrounding
 * JSON envelope, tool schemas and text still fit; the oldest clips are dropped
 * first once the total would exceed it.
 */
export const MAX_REQUEST_VIDEO_BYTES = 48 * 1024 * 1024

const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its size limit; older images are omitted first. '
  + 'If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** Media types both upstream wires accept as inline base64. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function attachmentOf(block: Record<string, unknown>): ImageAttachmentRef | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  return typeof attachment.attachmentId === 'string' ? attachment as unknown as ImageAttachmentRef : undefined
}

export function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const attachment = attachmentOf(block)
      if (attachment) refs.set(attachment.attachmentId, attachment)
      continue
    }
    // Tool results nest their own content, and a screenshot or a read_image
    // result carries its pixels there. Stopping at the top level made every
    // tool-produced image unresolvable before it could reach the wire.
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Base64 payload one image block contributes to the wire, or undefined when it
 * contributes none.
 *
 * This is the length of what is SENT, which is not the length of what is
 * STORED. Kimi's own client downsamples and re-encodes an oversized image before
 * delivery "to avoid the supplier erroring on an oversized image", and this route
 * does the same through `requestImageTarget`: a 5 MB screenshot reaches the
 * wire as a ~256 KiB request version. Measuring `attachment.bytes` therefore
 * over-counts every image that was scaled, and an image that fits comfortably
 * after scaling was reported as several megabytes over budget and dropped.
 *
 * With `images` supplied the measurement is exact. Without it the stored size is
 * the only estimate available, so it stays the fallback and every call site that
 * has no resolved map behaves exactly as before.
 */
function requestImagePayloadLength(
  block: Record<string, unknown>,
  images?: ResolvedRequestImages,
): number | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  // Mirrors the data-URL stripping in imageBlockToInline: the prefix is not sent.
  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) data = matched[2] ?? ''
  }
  if (data) return data.length

  const attachment = attachmentOf(block)
  if (!attachment) return undefined
  if (images === undefined) return base64Length(attachment.bytes)
  const resolved = images.get(attachment.attachmentId)
  // An image that resolved to `unavailable` is serialized as a short text
  // placeholder by the mapper, so it carries no image payload and must not be
  // counted as one.
  return resolved?.kind === 'inline' ? resolved.data.length : undefined
}

/**
 * Collect every image occurrence in model request order, recursing into tool
 * results the way `collectImageRefs` does.
 *
 * RECURSION IS NOT OPTIONAL. A `read_image` result or a screenshot inside a tool
 * result carries its pixels to the wire — `toolResultBlocks` sends them — so an
 * earlier version that only looked at top-level blocks under-counted exactly the
 * images a tool-using session produces most of. The budget has to describe the
 * body that is actually built.
 */
function collectRequestImagePayloads(
  content: unknown,
  images: ResolvedRequestImages | undefined,
  lengths: number[],
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const bytes = requestImagePayloadLength(block, images)
      if (bytes !== undefined) lengths.push(bytes)
      continue
    }
    if (block.type === 'tool-result') collectRequestImagePayloads(block.content, images, lengths)
  }
}

/**
 * Wire-level base64 payload of each image occurrence one request carries, in the
 * order the request sends them, so index N is the Nth oldest image.
 */
export function requestImagePayloadLengths(
  options: GenerateOptions,
  images?: ResolvedRequestImages,
): number[] {
  const lengths: number[] = []
  for (const message of options.messages) collectRequestImagePayloads(message.content, images, lengths)
  return lengths
}

/** How many of the oldest occurrences must go to bring the total under `maxBytes`. */
export function imagesToOffloadCount(lengths: readonly number[], maxBytes: number): number {
  const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - maxBytes
  if (excess <= 0) return 0
  let freed = 0
  let omitted = 0
  for (const bytes of lengths) {
    if (freed >= excess) break
    freed += bytes
    omitted += 1
  }
  return omitted
}

/**
 * Replace the first `count` image occurrences with a visible placeholder,
 * recursing into tool results. Durable history is untouched; only the request
 * about to be sent changes.
 *
 * `images` must be the same resolution {@link requestImagePayloadLengths} was
 * measured with. An image that resolved to `unavailable` is already serialized
 * as a short text placeholder, so dropping it frees no bytes — counting it as
 * replaceable here would shift every later occurrence by one against the
 * measured lengths, and the caller would under-drop for as long as such an
 * image is in the conversation.
 */
export function replaceOldestRequestImages(
  options: GenerateOptions,
  count: number,
  images?: ResolvedRequestImages,
): GenerateOptions {
  if (count <= 0) return options
  const remaining = { count }
  const replaceIn = (content: unknown): { content: unknown; replaced: boolean } => {
    if (!Array.isArray(content) || remaining.count === 0) return { content, replaced: false }
    let replaced = false
    const next = content.map((block) => {
      if (remaining.count === 0 || !isRecord(block)) return block
      if (block.type === 'image') {
        if (requestImagePayloadLength(block, images) === undefined) return block
        remaining.count -= 1
        replaced = true
        return { type: 'text', text: OMITTED_IMAGE_TEXT } as ContentBlock
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const inner = replaceIn(block.content)
        if (!inner.replaced) return block
        replaced = true
        return { ...block, content: inner.content }
      }
      return block
    })
    return { content: next, replaced }
  }

  let changed = false
  const messages = options.messages.map((message) => {
    const result = replaceIn(message.content)
    if (!result.replaced) return message
    changed = true
    return { ...message, content: result.content } as typeof message
  })
  return changed ? { ...options, messages } : options
}

/**
 * Longest edge any image of this request may keep.
 *
 * Kimi's own client compresses an oversized image down to roughly 2 MB of raw
 * bytes before it sends it, and this route has to fit every image of one request
 * inside a far smaller shared budget. Screening on the long edge rather than on
 * the encoded size is what makes the decision stable: it reads only the
 * attachment's own dimensions, so the same image yields the same target in every
 * later turn and the cached prefix survives.
 */
export const REQUEST_IMAGE_MAX_EDGE = 1024

/**
 * Encoded-byte target for one downscaled request version.
 *
 * CHOICE: 256 KiB of raw bytes is about 350 KiB of base64, so four images fit
 * the 1.5 MB budget with room left for the conversation text, tool schemas and
 * system prompt that share the 2 MB body. Four is the point where a UI review
 * still reads the shots it needs, and the target is a per-image ceiling rather
 * than a per-request one so the same image is transformed identically in every
 * later turn. When no quality level meets the target the harness keeps its
 * smallest output.
 */
const REQUEST_IMAGE_VERSION_MAX_BYTES = 256 * 1024

/**
 * Request-version target for one stored image whose long edge is over the
 * ceiling, or undefined when it fits and is sent as stored.
 *
 * A reference without usable dimensions is sent as stored: there is no basis
 * for choosing a target, and the budget fallback still applies to it.
 */
export function requestImageTarget(
  ref: ImageAttachmentRef,
  edge: number = REQUEST_IMAGE_MAX_EDGE,
): { width: number; height: number; maxBytes: number } | undefined {
  const { width, height } = ref
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined
  if (Math.max(width, height) <= edge) return undefined
  return width >= height
    ? { width: edge, height: Math.max(1, Math.round(edge * height / width)), maxBytes: REQUEST_IMAGE_VERSION_MAX_BYTES }
    : { width: Math.max(1, Math.round(edge * width / height)), height: edge, maxBytes: REQUEST_IMAGE_VERSION_MAX_BYTES }
}

/**
 * Replace the oldest inline images with a text placeholder once one request
 * would carry more than `maxBytes` of base64 image data.
 *
 * The MECHANISM is shared because it is generic: measure the retained
 * occurrences' encoded length, drop oldest-first, leave durable history alone.
 * The BUDGET is not, and it is a parameter for exactly that reason — an
 * image budget is a property of the upstream gateway, and importing one route's
 * number into another refuses that other route's own legal images. The default
 * is Kimi's, so every existing call site is byte-for-byte unchanged; a route
 * with a different ceiling passes its own.
 *
 * Durable history is untouched; only the request about to be sent changes.
 */
export function offloadOldestRequestImages(
  options: GenerateOptions,
  maxBytes: number = MAX_REQUEST_IMAGE_BYTES,
  images?: ResolvedRequestImages,
): GenerateOptions {
  const lengths = requestImagePayloadLengths(options, images)
  // The same resolution has to reach the replacement, or index N stops naming
  // the Nth measured occurrence.
  return replaceOldestRequestImages(options, imagesToOffloadCount(lengths, maxBytes), images)
}

/**
 * Whether a request still carries at least one image the mapper can send.
 *
 * A request whose images have all been replaced by placeholders can no longer
 * shrink, which is what separates "drop more images" from "this body is too
 * large for a reason no image budget can fix".
 *
 * DEFINED AS the counter, not as a traversal of its own. The two have to agree
 * by construction: when they did not, {@link collectRequestImagePayloads} saw
 * the images inside a `tool-result` — which is where a `read_image` result
 * or a screenshot lands — while this answer reported that nothing was left to
 * give back, so the body-fit loop refused a request that dropping one image
 * would have fitted. A fifth hand-written recursion would have fixed that one
 * instance; deriving one from the other makes the next drift impossible rather
 * than merely unlikely.
 *
 * `images` must be the same resolution the builder will use. An image that
 * resolved to `unavailable` is serialized as text and therefore is not a
 * sendable image; reporting it as one only spins the loop until it gives up.
 */
export function requestHasSendableImage(options: GenerateOptions, images?: ResolvedRequestImages): boolean {
  return requestImagePayloadLengths(options, images).length > 0
}

/**
 * Read every durable `{ type: 'image', attachment }` block one request carries.
 * An unreadable image resolves to `unavailable` rather than disappearing, so
 * the model is told the picture is missing instead of answering about a blank.
 *
 * An image whose long edge is over {@link REQUEST_IMAGE_MAX_EDGE} is sent as the
 * harness's downscaled request version (see {@link requestImageTarget}). The
 * stored image and durable history do not change, and an image that already
 * fits is sent byte-for-byte as stored.
 *
 * WHY scale instead of drop. `offloadOldestRequestImages` has to drop an image
 * once the request exceeds `MAX_REQUEST_IMAGE_BYTES`, and the number it drops
 * grows with every later image. Each change rewrites the retained prefix, so the
 * prompt cache is invalidated again on the very next turn. Scaling keeps the
 * image COUNT stable, which is what preserves that prefix: a conversation that
 * outgrew the budget once stays inside it instead of breaking the cache every
 * time an image is added.
 */
export async function resolveRequestImages(
  options: GenerateOptions,
  attachments: AttachmentImageReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRequestImages> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return NO_RESOLVED_IMAGES

  const resolved = new Map<string, ResolvedRequestImage>()
  await Promise.all([...refs].map(async ([attachmentId, ref]) => {
    if (!attachments) {
      resolved.set(attachmentId, { kind: 'unavailable' })
      return
    }
    try {
      const target = requestImageTarget(ref)
      if (target !== undefined) {
        const version = await attachments.readImageRequest(ref, target, signal)
        resolved.set(attachmentId, Math.max(version.width, version.height) > REQUEST_IMAGE_MAX_EDGE
          ? { kind: 'unavailable' }
          : { kind: 'inline', mediaType: version.mediaType, data: Buffer.from(version.data).toString('base64') })
        return
      }
      const stored = await attachments.readImage(ref, signal)
      resolved.set(attachmentId, {
        kind: 'inline',
        mediaType: stored.ref.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error) {
      if (isAbort(error, signal)) throw error
      resolved.set(attachmentId, { kind: 'unavailable' })
    }
  }))
  return resolved
}

export function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label} could not be read` : 'the image could not be read'
  return `[image unavailable: ${subject}; ask the user to attach it again if the image is needed]`
}

export interface InlineImage {
  mediaType: string
  data: string
}

export function imageBlockToInline(block: Record<string, unknown>, images: ResolvedRequestImages): InlineImage | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  let mediaType =
    asString(block.mimeType)
    || asString(block.mediaType)
    || (source ? asString(source.mimeType) || asString(source.mediaType) : undefined)
    || 'image/png'

  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) {
      mediaType = matched[1] || mediaType
      data = matched[2] || ''
    }
  }
  if (data) return { mediaType, data }

  const attachment = attachmentOf(block)
  const resolved = attachment ? images.get(attachment.attachmentId) : undefined
  // The media type comes from the verified reference, not from the block.
  return resolved?.kind === 'inline' ? { mediaType: resolved.mediaType, data: resolved.data } : undefined
}
