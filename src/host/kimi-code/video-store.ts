/**
 * Local store for videos this plugin attaches to a Kimi Code request.
 *
 * DSH's attachment service normalizes and stores images only, and no DSH
 * surface can produce a video block, so the route owns its own store rather
 * than pretending DSH issued these references. The store is deliberately
 * narrow: a tool ingests bytes, a reader hands them back for one request.
 *
 * The identifier is the sha256 of the stored bytes, so re-ingesting the same
 * file is idempotent and a reference cannot silently point at different bytes.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomeDir } from '../antigravity/token-store.ts'
import { KIMI_VIDEO_MEDIA_TYPES, type VideoAttachmentRef } from './modalities.ts'

/**
 * Largest single video this route will carry.
 *
 * Two independent published limits bound this, and the smaller wins:
 *
 * - the official Kimi video integration encodes a local file as
 *   `data:video/...;base64,...` and caps that payload at about 50 MB;
 * - the VS Code client caps a picked video file at 20 MB.
 *
 * The integration figure is the one that describes what the MODEL accepts
 * over this exact wire, so the cap is set just under it rather than at the
 * editor's more conservative picker limit. Note this is an encoded payload
 * limit: base64 grows bytes by 4/3, so the raw file must stay under 3/4 of it.
 */
export const MAX_VIDEO_FILE_BYTES = 30 * 1024 * 1024

/** Maximum base64 payload derived from {@link MAX_VIDEO_FILE_BYTES}. */
export const MAX_VIDEO_BASE64_BYTES = Math.ceil(MAX_VIDEO_FILE_BYTES / 3) * 4

/** Directory the ingested videos live in. */
export function videoStoreDir(): string {
  return path.join(dshHomeDir(), 'storages', 'kimi-code-videos')
}

/** A file extension for a media type, for the stored object's leaf name. */
function extensionFor(mediaType: string): string {
  const map: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/x-matroska': '.mkv',
    'video/mpeg': '.mpeg',
    'video/mpg': '.mpg',
    'video/x-flv': '.flv',
    'video/x-ms-wmv': '.wmv',
    'video/3gpp': '.3gp',
  }
  return map[mediaType] ?? '.bin'
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpg',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.3gp': 'video/3gpp',
}

/**
 * Media type for one path, from its extension.
 *
 * A local file rarely carries a usable declared type, so the extension is the
 * signal; an unknown one yields undefined rather than a guess, so the caller
 * can refuse instead of sending a type the service will reject.
 */
export function mediaTypeForPath(filePath: string): string | undefined {
  return EXTENSION_MEDIA_TYPES[path.extname(filePath).toLowerCase()]
}

/**
 * Whether the service documents this container.
 *
 * Matroska (.mkv) is accepted by the third-party integrations but is not in
 * the vision guide's list, so it is stored and reported but the request mapper
 * still decides whether to send it; keeping both facts separate means a future
 * documentation change is a one-line edit here.
 */
export function isStorableVideoType(mediaType: string): boolean {
  return Object.values(EXTENSION_MEDIA_TYPES).includes(mediaType) || KIMI_VIDEO_MEDIA_TYPES.includes(mediaType)
}

/** Raised when an ingest cannot produce a usable reference. */
export class VideoIngestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'VideoIngestError'
  }
}

/**
 * Commit one video's bytes and return the reference a request can cite.
 *
 * @param data - complete encoded file bytes.
 * @param declaredType - media type from the source (extension or Content-Type).
 * @param name - display name; never interpreted as a path.
 * @param declaredBytes - total the source advertised, when it did, so an
 *   oversized file is refused before its bytes are buffered.
 */
export async function saveVideo(input: {
  data: Uint8Array
  declaredType: string | undefined
  name: string
  declaredBytes?: number
}): Promise<VideoAttachmentRef> {
  if (input.declaredBytes !== undefined && input.declaredBytes > MAX_VIDEO_FILE_BYTES) {
    throw new VideoIngestError(
      `video is ${input.declaredBytes} bytes, above the ${MAX_VIDEO_FILE_BYTES}-byte limit this route sends`,
      'VIDEO_TOO_LARGE',
    )
  }
  if (input.data.byteLength === 0) {
    throw new VideoIngestError('video is empty', 'VIDEO_EMPTY')
  }
  if (input.data.byteLength > MAX_VIDEO_FILE_BYTES) {
    throw new VideoIngestError(
      `video is ${input.data.byteLength} bytes, above the ${MAX_VIDEO_FILE_BYTES}-byte limit this route sends`,
      'VIDEO_TOO_LARGE',
    )
  }
  if (input.declaredType === undefined || !isStorableVideoType(input.declaredType)) {
    throw new VideoIngestError(
      `unsupported video type "${input.declaredType ?? 'unknown'}"; supported: ${KIMI_VIDEO_MEDIA_TYPES.join(', ')}`,
      'VIDEO_TYPE_UNSUPPORTED',
    )
  }

  const digest = createHash('sha256').update(input.data).digest('hex')
  const attachmentId = `sha256:${digest}`
  const dir = videoStoreDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, digest + extensionFor(input.declaredType))
  // Content-addressed, so an existing object already holds exactly these bytes.
  const exists = await fs.stat(target).then(() => true).catch(() => false)
  if (!exists) {
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, input.data)
    await fs.rename(tmp, target)
  }

  return {
    attachmentId,
    mediaType: input.declaredType,
    bytes: input.data.byteLength,
    name: input.name,
  }
}

/** Path of the stored object for a reference, or undefined when it is gone. */
export function storedPathFor(ref: VideoAttachmentRef): string | undefined {
  const digest = ref.attachmentId.startsWith('sha256:') ? ref.attachmentId.slice('sha256:'.length) : undefined
  if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) return undefined
  return path.join(videoStoreDir(), digest + extensionFor(ref.mediaType))
}

/**
 * Read the bytes one reference points at.
 *
 * The reference is re-verified against the stored bytes: a file whose digest
 * no longer matches its name is refused rather than sent, so a tampered or
 * truncated object cannot reach the model as if it were the original.
 */
export async function readVideoBytes(ref: VideoAttachmentRef): Promise<Uint8Array> {
  const stored = storedPathFor(ref)
  if (stored === undefined) {
    throw new VideoIngestError('video reference is not one this store issued', 'VIDEO_REFERENCE_INVALID')
  }
  let data: Buffer
  try {
    data = await fs.readFile(stored)
  } catch {
    throw new VideoIngestError('stored video is missing; attach it again', 'VIDEO_MISSING')
  }
  const digest = createHash('sha256').update(data).digest('hex')
  if (`sha256:${digest}` !== ref.attachmentId) {
    throw new VideoIngestError('stored video failed its integrity check', 'VIDEO_CORRUPT')
  }
  return data
}
