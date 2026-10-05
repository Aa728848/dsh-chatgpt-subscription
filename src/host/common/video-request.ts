/**
 * Request-side machinery for video input, shared by every line that accepts it.
 *
 * Everything here walks ContentBlocks and base64-encodes bytes; none of it knows
 * which provider it is serving. A line contributes the two things that DO differ:
 * the wording for a video it cannot send, and the byte budget its endpoint
 * tolerates.
 *
 * @module dsh-chatgpt-subscription/video-request
 */

import type { ContentBlock, GenerateOptions } from './llm-compat.ts'
import {
  base64LengthOf,
  isVideoMediaType,
  videoBlockLabel,
  type VideoAttachmentRef,
  type VideoOmissionText,
} from './video.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function videoAttachmentOf(block: Record<string, unknown>): VideoAttachmentRef | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  if (typeof attachment.attachmentId !== 'string') return undefined
  return attachment as unknown as VideoAttachmentRef
}

function collectVideoRefs(content: unknown, refs: Map<string, VideoAttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'video') continue
    const attachment = videoAttachmentOf(block)
    if (attachment) refs.set(attachment.attachmentId, attachment)
  }
}
/** Base64 length of one video occurrence, or undefined when it states none. */
function requestVideoBytes(block: Record<string, unknown>): number | undefined {
  const inline = asString(block.data) || asString(block.base64)
  if (inline) return inline.length
  const attachment = videoAttachmentOf(block)
  return attachment === undefined ? undefined : base64LengthOf(attachment.bytes)
}

function collectRequestVideoBytes(content: unknown, lengths: number[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'video') continue
    const bytes = requestVideoBytes(block)
    if (bytes !== undefined) lengths.push(bytes)
  }
}

/**
 * One durable video resolved for an in-flight request, or proven unreadable.
 *
 * The shape mirrors the image counterpart so the two media kinds travel the
 * same path and differ only in the wire part each produces.
 */
export type ResolvedRequestVideo =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** Resolved videos keyed by attachment id; consumed by one request build. */
export type ResolvedRequestVideos = ReadonlyMap<string, ResolvedRequestVideo>

const NO_RESOLVED_VIDEOS: ResolvedRequestVideos = new Map()

/**
 * Attachment seam for video bytes.
 *
 * DSH's own attachment service stores images only, so a video reference can
 * only exist if some producer in this deployment created it. Rather than
 * pretend otherwise, the reader is an injected seam: absent means every video
 * resolves to `unavailable` and the model is told the clip is missing, which is
 * strictly better than silently sending a request with no video at all.
 */
export type AttachmentVideoReader = {
  readVideo(ref: VideoAttachmentRef, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

/**
 * Read every durable `{ type: 'video', attachment }` block one request carries.
 *
 * An unreadable clip resolves to `unavailable` rather than disappearing, so the
 * model is told the video is missing instead of answering about a blank.
 */
export async function resolveRequestVideos(
  options: GenerateOptions,
  attachments: AttachmentVideoReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRequestVideos> {
  const refs = new Map<string, VideoAttachmentRef>()
  for (const message of options.messages) collectVideoRefs(message.content, refs)
  if (refs.size === 0) return NO_RESOLVED_VIDEOS

  const resolved = new Map<string, ResolvedRequestVideo>()
  await Promise.all([...refs].map(async ([attachmentId, ref]) => {
    if (!attachments) {
      resolved.set(attachmentId, { kind: 'unavailable' })
      return
    }
    try {
      const stored = await attachments.readVideo(ref, signal)
      resolved.set(attachmentId, {
        kind: 'inline',
        mediaType: stored.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error) {
      // A cancellation is not a read failure: turning it into a placeholder
      // would answer a turn the caller deliberately stopped.
      if (isAbortLike(error, signal)) throw error
      resolved.set(attachmentId, { kind: 'unavailable' })
    }
  }))
  return resolved
}

/** Whether one failure is a cancellation rather than a real read failure. */
function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/** True when the request carries any video occurrence at all. */
export function requestHasVideo(options: GenerateOptions): boolean {
  return options.messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => isRecord(block) && block.type === 'video'))
}

function omittedVideoText(omit: VideoOmissionText, block: Record<string, unknown>): string {
  return omit('unreadable', videoBlockLabel(block as { attachment?: { name?: string; attachmentId?: string } }))
}

function omittedSizeText(): string {
  return '[video omitted to keep the request within its size limit; older videos are omitted first. '
    + 'If this clip is still needed, attach a shorter excerpt or ask the user to describe it.]'
}

/**
 * Drop the oldest videos once one request would exceed `maxBytes` of base64
 * video data, replacing each with a text placeholder.
 *
 * Durable history is untouched; only the request about to be sent changes.
 * Images are left alone — they have their own, much smaller budget and their own
 * offload pass.
 *
 * @param maxBytes - the endpoint's base64 video budget.
 */
export function offloadOldestRequestVideos(
  options: GenerateOptions,
  maxBytes: number,
): GenerateOptions {
  const lengths: number[] = []
  for (const message of options.messages) collectRequestVideoBytes(message.content, lengths)
  const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - maxBytes
  if (excess <= 0) return options

  let omitted = 0
  let freed = 0
  for (const bytes of lengths) {
    if (freed >= excess) break
    freed += bytes
    omitted += 1
  }

  const remaining = { count: omitted }
  const messages = options.messages.map((message) => {
    if (remaining.count === 0 || !Array.isArray(message.content)) return message
    let replaced = false
    const content = message.content.map((block) => {
      if (remaining.count === 0 || !isRecord(block) || block.type !== 'video') return block
      if (requestVideoBytes(block) === undefined) return block
      remaining.count -= 1
      replaced = true
      return { type: 'text', text: omittedSizeText() } as ContentBlock
    })
    return replaced ? { ...message, content } : message
  })
  return { ...options, messages }
}

/** One video block resolved for the wire, or the reason it cannot be sent. */
export type ResolvedVideoBlock =
  | { readonly inline: { readonly mediaType: string; readonly data: string } }
  | { readonly omission: string }

/**
 * Resolve one video block for the wire, or explain why it cannot be sent.
 *
 * @param block - the durable video occurrence.
 * @param videos - videos read for this request.
 * @param videoAccepted - whether the selected model declares video input.
 * @param omit - the line's wording for a video it cannot send.
 */
export function videoBlockToInline(
  block: Record<string, unknown>,
  videos: ResolvedRequestVideos,
  videoAccepted: boolean,
  omit: VideoOmissionText,
): ResolvedVideoBlock {
  const label = videoBlockLabel(block as { attachment?: { name?: string; attachmentId?: string } })
  if (!videoAccepted) return { omission: omit('unsupported-model', label) }

  let data = asString(block.data) || asString(block.base64)
  let mediaType = asString(block.mediaType) || asString(block.mimeType)
  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) {
      mediaType = matched[1] || mediaType
      data = matched[2] || ''
    }
  }
  if (!data || mediaType === undefined || mediaType === '') {
    const attachment = videoAttachmentOf(block)
    const resolved = attachment ? videos.get(attachment.attachmentId) : undefined
    if (resolved?.kind !== 'inline') return { omission: omittedVideoText(omit, block) }
    return isVideoMediaType(resolved.mediaType)
      ? { inline: { mediaType: resolved.mediaType, data: resolved.data } }
      : { omission: omit('unsupported-container', label) }
  }
  return isVideoMediaType(mediaType)
    ? { inline: { mediaType, data } }
    : { omission: omit('unsupported-container', label) }
}
