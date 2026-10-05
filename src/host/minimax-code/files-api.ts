/**
 * MiniMax Code Files API client.
 *
 * The one capability this line could not serve inline: a clip whose base64 would
 * overrun the 64 MB request body. Uploading it to the Files API and sending an
 * `mm_file://` reference is the only documented way to send a large media file.
 *
 * EVERY fact in this file was measured against the subscription endpoint on
 * 2026-10-05, not read from the official client and not assumed:
 *
 * - The endpoint is `{agentBase}/mavis/api/v1/llm/v1/files/upload`. The
 *   `files_api_upload_endpoint: '/v1/files/upload'` in the official catalog is
 *   RELATIVE to the messages base, and the official resolver strips the
 *   `/anthropic` compatibility suffix before appending it.
 * - It requires `multipart/form-data` with `purpose` FIRST and then `file`;
 *   `purpose` is `image_understanding` or `video_understanding`.
 * - It answers `{"file":{"file_id":…},"base_resp":{"status_code":0}}`,
 *   and `status_code` must be 0 for the id to be usable.
 * - **It rejects the `X-Msh-*` identity headers that every other request on this
 *   line sends.** With them the answer is `{"file":null,…"invalid params"}`,
 *   identical to a genuinely malformed body - so a request that is correct in
 *   every other respect fails with a message that points nowhere. This client
 *   therefore sends the bearer token ALONE, and the only thing that fixes a
 *   `2013 invalid params` here is dropping those headers, not changing the form.
 * - A successful upload is referenced as `mm_file://<file_id>` in a
 *   `{ type, source: { type: 'url', url } }` block. A bare id is rejected with
 *   "image url must be http(s):// or data:...;base64", so the scheme is load-bearing.
 * - There is no list or delete route on this surface (`GET /files` answers 503
 *   `direct_route_not_configured`), so expiry cannot be confirmed server-side.
 *
 * @module dsh-chatgpt-subscription/minimax-files-api
 */

import { createHash } from 'node:crypto'
import { dshHomeDir } from '../antigravity/token-store.ts'

/** Path suffix appended to the messages URL to reach the Files API. */
export const FILES_UPLOAD_PATH = '/files/upload'

/** Scheme a stored file is referenced by on the wire. */
export const FILE_REF_SCHEME = 'mm_file://'

/**
 * Lifetime this client assumes for an uploaded file id.
 *
 * 12 hours, matching the official client's own default (its resolver falls back
 * to 43,200 seconds when the server states no TTL). It is deliberately shorter
 * than a day: a stale reference is worth a cheap re-upload, while a reference
 * that outlives its file is worth a failed turn.
 */
export const DEFAULT_FILE_ID_TTL_SEC = 43_200

/** Ceiling on one upload, so a runaway path cannot spend the whole budget. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** Time budget for one upload request. */
export const UPLOAD_TIMEOUT_MS = 120_000

/** Why one upload could not produce a usable file id. */
export type FilesApiFailure =
  | 'not-configured'
  | 'too-large'
  | 'unauthorized'
  | 'rejected'
  /** The gateway answered 50115: the route is not enabled for this credential. */
  | 'route-not-configured'
  | 'unreadable'
  | 'network'

/** One failed upload, with a message the settings surface can show. */
export class FilesApiError extends Error {
  readonly reason: FilesApiFailure

  constructor(reason: FilesApiFailure, message: string) {
    super(message)
    this.name = 'FilesApiError'
    this.reason = reason
  }
}

/** What one upload request needs. */
export interface FilesApiUploadRequest {
  readonly accessToken: string
  readonly baseUrl: string
  /** Bare base64 of the bytes, without a data-URL prefix. */
  readonly base64: string
  /** Exact decoded byte length. */
  readonly bytes: number
  readonly mediaType: string
  readonly purpose: 'image_understanding' | 'video_understanding'
  readonly filename: string
  readonly signal?: AbortSignal
}

/** Everything the Files API upload surface was measured to accept. */
export interface FilesApiUploadOptions {
  readonly fetchFn?: typeof fetch
  /** Test seam: the clock, in epoch ms. */
  readonly nowMs?: () => number
  /**
   * Test seam: where the id cache lives.
   *
   * `undefined` keeps it in memory, so a test neither reads the real cache
   * file nor leaves ids behind in it.
   */
  readonly storePath?: string | undefined
}

interface CachedFileId {
  readonly fileId: string
  readonly expiresAtMs: number
}

interface CachedFileIdStore {
  read(): Promise<Record<string, CachedFileId>>
  write(value: Record<string, CachedFileId>): Promise<void>
}

/**
 * Uploaded file ids, keyed by content and account.
 *
 * Two things make the key what it is. Content: re-uploading identical bytes
 * for every turn would be pure waste, and the same clip recurs across a
 * conversation. Account: the account pool serves one conversation from several
 * accounts, and an id minted by one account is not assumed to be readable by
 * another - so the id is never shared across accounts. That assumption is
 * deliberately conservative: if the service turns out to scope ids globally, the
 * only cost is a redundant upload.
 */
class FileIdStore {
  private readonly path: string | undefined

  /**
   * @param path - cache file. An empty string selects the in-memory store: a test
   *   must neither read nor write the real cache, because ids are scoped per
   *   account and a stale entry makes a fresh upload look cached.
   */
  constructor(path: string | undefined) {
    this.path = path === undefined || path === '' ? undefined : path
  }

  private get inMemory(): Record<string, CachedFileId> {
    if (FileIdStore.memory === undefined) FileIdStore.memory = {}
    return FileIdStore.memory
  }

  async read(): Promise<Record<string, CachedFileId>> {
    if (this.path === undefined) return { ...this.inMemory }
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(this.path, 'utf8').catch(() => '')
    if (raw.trim() === '') return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as Record<string, CachedFileId>) : {}
  }

  async write(value: Record<string, CachedFileId>): Promise<void> {
    if (this.path === undefined) {
      const holder = this.inMemory
      for (const key of Object.keys(holder)) delete holder[key]
      Object.assign(holder, value)
      return
    }
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(path.dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(value), 'utf8')
  }

    /** Shared by every in-memory instance, so they see one cache. */
  static memory: Record<string, CachedFileId> | undefined
}

/**
 * Forget every cached file id in the in-memory store.
 *
 * Test seam only. A file id is scoped to an account, so an id left over from
 * another test would make the next upload look cached and never exercise the
 * request at all.
 */
export function resetInMemoryFileIds(): void {
  FileIdStore.memory = undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uploadCachePath(): string {
  return dshHomeDir() + '/storages/minimax-code-files.json'
}

/** Stable key for one (content, account) pair. */
function cacheKey(base64: string, accountKey: string): string {
  const digest = createHash('sha256').update(base64).digest('hex')
  return accountKey + ':' + digest
}

/** The wire reference for a stored file id. */
export function fileRef(fileId: string): string {
  return FILE_REF_SCHEME + fileId
}

/** A file extension matching a media type, for the upload's filename part. */
function filenameForMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase()
  const known: Record<string, string> = {
    'video/mp4': 'clip.mp4',
    'video/quicktime': 'clip.mov',
    'video/webm': 'clip.webm',
    'video/x-msvideo': 'clip.avi',
    'video/x-flv': 'clip.flv',
    'video/3gpp': 'clip.3gp',
    'video/mpeg': 'clip.mpeg',
    'video/mpg': 'clip.mpg',
    'image/png': 'image.png',
    'image/jpeg': 'image.jpg',
    'image/gif': 'image.gif',
    'image/webp': 'image.webp',
  }
  return known[normalized] ?? 'upload.bin'
}

/**
 * The Files API upload URL for one messages URL.
 *
 * The upload is a SIBLING of `/messages`, not a child of it: the measured route
 * is `.../llm/v1/files/upload`. Appending to the messages URL would ask for
 * `/messages/files/upload`, which answers 503 `direct_route_not_configured` -
 * an error that reads like the feature is switched off rather than a path that
 * is one segment off.
 */
export function filesUploadUrl(messagesEndpoint: string): string {
  const trimmed = messagesEndpoint.trim().replace(/\/+$/, '')
  const withoutMessages = trimmed.endsWith(MESSAGES_PATH)
    ? trimmed.slice(0, -MESSAGES_PATH.length)
    : trimmed
  return withoutMessages + FILES_UPLOAD_PATH
}

/** Suffix of the messages route, which the upload path replaces. */
const MESSAGES_PATH = '/messages'

/** The `purpose` value one media type uploads under. */
export function filesPurposeFor(mediaType: string): 'image_understanding' | 'video_understanding' | undefined {
  const normalized = mediaType.trim().toLowerCase()
  if (normalized.startsWith('image/')) return 'image_understanding'
  if (normalized.startsWith('video/')) return 'video_understanding'
  return undefined
}

/**
 * Upload one media file and return its id, reusing a live cached id when the
 * same bytes were already uploaded by the same account.
 *
 * @param accountKey - identifies the account the bytes are uploaded under.
 *   Ids are never shared across accounts; see {@link FileIdStore}.
 * @returns the file id, or undefined when the request should carry the media
 *   inline instead (too large, unconfigured, or the upload failed).
 */
export async function uploadMediaFile(
  request: Omit<FilesApiUploadRequest, 'purpose' | 'filename'>,
  accountKey: string,
  options: FilesApiUploadOptions = {},
): Promise<string | undefined> {
  const purpose = filesPurposeFor(request.mediaType)
  if (purpose === undefined) return undefined
  if (request.bytes > MAX_UPLOAD_BYTES) {
    throw new FilesApiError(
      'too-large',
      'the file is ' + formatBytes(request.bytes) + ', above the ' + formatBytes(MAX_UPLOAD_BYTES) + ' upload ceiling',
    )
  }

  const key = cacheKey(request.base64, accountKey)
  const nowMs = options.nowMs ?? Date.now
  const store = new FileIdStore(options.storePath)
  const cache = await store.read().catch(() => ({}) as Record<string, CachedFileId>)
  const cached = cache[key]
  if (cached !== undefined && cached.expiresAtMs > nowMs()) return cached.fileId

  const fetchFn = options.fetchFn ?? fetch
  const form = new FormData()
  // purpose BEFORE file: the official client appends them in this order and the
  // server parses the form positionally for the part it binds.
  form.append('purpose', purpose)
  form.append(
    'file',
    new Blob([Buffer.from(request.base64, 'base64')], { type: request.mediaType }),
    filenameForMediaType(request.mediaType),
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  const abortForTurn = (): void => controller.abort(request.signal?.reason)
  if (request.signal?.aborted === true) abortForTurn()
  else request.signal?.addEventListener('abort', abortForTurn, { once: true })

  let fileId: string | undefined
  try {
    const response = await fetchFn(filesUploadUrl(request.baseUrl), {
      method: 'POST',
      // Authorization ALONE. See the module doc: the X-Msh-* identity headers
      // this line sends everywhere else make this surface answer 2013.
      headers: { Authorization: 'Bearer ' + request.accessToken },
      body: form,
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      throw new FilesApiError('unauthorized', 'the Files API rejected the credential (HTTP ' + response.status + ')')
    }
    // 503/50115 is the gateway saying the route is not enabled for this
    // credential - a different situation from the Files API refusing a
    // well-formed upload, and one a user cannot fix by retrying.
    if (response.status === 503) {
      throw new FilesApiError(
        'route-not-configured',
        'this MiniMax Code account has no Files API route configured, so the media stays inline',
      )
    }
    if (!response.ok) {
      throw new FilesApiError(
        'rejected',
        'the Files API upload failed with HTTP ' + response.status,
      )
    }
    const raw = await response.text().catch(() => '')
    const payload: unknown = safeJson(raw)
    fileId = readFileId(payload)
    if (fileId === undefined) {
      throw new FilesApiError('rejected', describeRejection(payload, raw))
    }
  } catch (error) {
    if (error instanceof FilesApiError) throw error
    // A cancellation is not an upload failure: turning it into a silent
    // fallback would keep spending the turn after the caller stopped it.
    if (isAbort(error, request.signal)) throw error
    throw new FilesApiError(
      'network',
      'the Files API upload did not complete: ' + (error instanceof Error ? error.message : String(error)),
    )
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abortForTurn)
  }

  await store.write({
    ...cache,
    [key]: { fileId, expiresAtMs: nowMs() + DEFAULT_FILE_ID_TTL_SEC * 1_000 },
  }).catch(() => undefined)
  return fileId
}

/** Whether one failure is a cancellation rather than a real upload failure. */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/** The file id from a successful upload body, or undefined. */
function readFileId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.base_resp) || !isRecord(payload.file)) return undefined
  if (payload.base_resp['status_code'] !== 0) return undefined
  const fileId = payload.file['file_id']
  if (typeof fileId === 'number') {
    return Number.isSafeInteger(fileId) && fileId >= 0 ? String(fileId) : undefined
  }
  return typeof fileId === 'string' && fileId !== '' ? fileId : undefined
}

/** The service's own reason for a refusal, so the message names the cause. */
function describeRejection(payload: unknown, raw: string): string {
  if (isRecord(payload) && isRecord(payload.base_resp)) {
    const status = payload.base_resp['status_code']
    const reason = payload.base_resp['status_msg']
    if (typeof reason === 'string' && reason !== '') {
      return 'the Files API refused the upload (' + String(status) + '): ' + reason
    }
  }
  // A body that is not JSON at all is a different failure from a JSON refusal,
  // and "invalid params" from a gateway HTML page reads nothing like either.
  if (raw.trim() === '') return 'the Files API returned an empty body'
  if (!isRecord(payload)) return 'the Files API returned a non-JSON body: ' + raw.slice(0, 120).replace(/\s+/g, ' ')
  return 'the Files API refused the upload without naming a reason'
}

/** Parse a response body without throwing on a non-JSON payload. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

