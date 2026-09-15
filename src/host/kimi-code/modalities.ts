/**
 * Kimi Code's extra request modalities, declared into DSH's provider-neutral
 * vocabularies by this plugin alone.
 *
 * DSH ships ModelModalityMap = { text, image } and a ContentBlockMap with no
 * video entry, but both are merge-extensible interfaces: a plugin may widen
 * them with a TypeScript module augmentation. That is what this file does, so
 * Kimi's documented video_in capability can travel through DSH's real
 * capability pipeline - the same one that gates read_image, prompt admission,
 * and subagent delegation - instead of being display-only trivia in a tooltip.
 *
 * Nothing here modifies DSH. The augmentation lives in this plugin's
 * compilation unit; DSH's own sources keep compiling against the two
 * modalities they already know.
 *
 * The block shape deliberately mirrors ImageAttachmentRef field for field.
 * DSH itself never constructs a video block - the attachment service only
 * promotes images - so the only readers are this plugin's request mapper and
 * its tests.
 */

/**
 * Container formats the Kimi coding endpoint accepts as video input.
 *
 * Transcribed from the official vision guide and file-upload reference; the
 * service validates the media type, so an unlisted container is reported
 * before it is base64-expanded into a request that would be rejected.
 */
export const KIMI_VIDEO_MEDIA_TYPES: readonly string[] = [
  'video/mp4',
  'video/mpeg',
  'video/mpg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-flv',
  'video/webm',
  'video/x-ms-wmv',
  'video/3gpp',
]

/** Runtime membership test for one video container. */
export function isVideoMediaType(mediaType: string): boolean {
  return KIMI_VIDEO_MEDIA_TYPES.includes(mediaType.trim().toLowerCase())
}

/**
 * One durable video reference carried by a request.
 *
 * attachmentId is a plain string rather than DSH's branded AttachmentId: no
 * DSH service issues this identifier, so branding it would imply an origin
 * that does not exist. The field name matches ImageAttachmentRef so one
 * traversal helper can walk both block kinds.
 */
export interface VideoAttachmentRef {
  attachmentId: string
  /** Verified media type, for example video/mp4. */
  mediaType: string
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic duration in milliseconds, when the producer knows it. */
  durationMs?: number
  /** Optional display name, stripped of any local path. */
  name?: string
}

/** One video occurrence in message content. */
export interface VideoBlock {
  type: 'video'
  attachment: VideoAttachmentRef
}

declare module '@deepseek-ai/dsh-llm' {
  interface ModelModalityMap {
    /** Widened by this plugin: Kimi's k3 and kimi-for-coding accept video. */
    video: 'video'
  }

  interface ContentBlockMap {
    /** Widened by this plugin; only the Kimi Code mapper reads it. */
    video: VideoBlock
  }
}

/** Base64 length of raw bytes, including padding. */
export function base64LengthOf(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** Canonical data URL the OpenAI-compatible video part carries. */
export function videoDataUrl(mediaType: string, base64: string): string {
  return 'data:' + mediaType + ';base64,' + base64
}
/**
 * Human-readable byte size for a refusal message.
 * @param bytes - exact encoded byte length.
 */
export function formatMediaBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

/** Why one video occurrence was replaced by text instead of being sent. */
export type VideoOmissionReason =
  | 'unsupported-model'
  | 'unreadable'
  | 'unsupported-container'
  /** The selected protocol has no documented video part, so none is sent. */
  | 'unsupported-wire'

/**
 * Deterministic text standing in for a video the request cannot carry.
 *
 * The model is told the video existed and why it is absent, so it asks for a
 * description instead of answering as though the message were empty.
 * @param reason - why the occurrence was omitted.
 * @param label - display name or attachment id, when known.
 */
export function videoOmissionText(reason: VideoOmissionReason, label?: string): string {
  const subject = label === undefined || label === '' ? 'the attached video' : label
  switch (reason) {
    case 'unsupported-model':
      return '[video omitted: ' + subject + ' cannot be sent because the selected Kimi model does not accept video input; switch to k3 or kimi-for-coding, or ask the user to describe the video.]'
    case 'unsupported-container':
      return '[video omitted: ' + subject + ' uses a container the Kimi coding endpoint does not accept; supported formats are ' + KIMI_VIDEO_MEDIA_TYPES.join(', ') + '.]'
    case 'unreadable':
      return '[video omitted: ' + subject + ' could not be read from storage; ask the user to attach it again if its contents are needed.]'
    case 'unsupported-wire':
      return '[video omitted: ' + subject + ' cannot be sent because the selected Kimi model is served over the Anthropic Messages protocol, which does not document a video content part. Kimi video input is an OpenAI-surface feature; switch the model to one served over the OpenAI-compatible surface, or ask the user to describe the video.]'
  }
}

/** Attachment id or display name for one block, whichever is present. */
export function videoBlockLabel(block: { attachment?: { name?: string; attachmentId?: string } }): string | undefined {
  const attachment = block.attachment
  if (attachment === undefined) return undefined
  return attachment.name !== undefined && attachment.name !== '' ? attachment.name : attachment.attachmentId
}
