/**
 * Kimi Code hosted-file (media upload) client.
 *
 * WHY THIS FILE EXISTS. Everything this plugin has ever sent to the Kimi Code
 * gateway carries media INLINE, as a `data:<type>;base64,...` URL
 * (mapper.ts builds both the image and the video block that way). The gateway
 * also accepts a hosted reference instead: upload the bytes once, cite
 * `ms://<id>` afterwards. That is the only way to send a clip whose base64 would
 * overrun the request body ceiling, and it is what this module implements.
 *
 * EVERY WIRE FACT BELOW WAS MEASURED live against the subscription gateway by
 * `scripts/probe-kimi-files.probe.ts` on this line's own account and region,
 * not copied from the official client:
 *
 * - the upload is `POST {coding base}/v1/files`, `multipart/form-data` with a
 *   `file` part and a `purpose` part whose value is `image` or `video`
 *   (note: NOT the `*_understanding` vocabulary the MiniMax line uses);
 * - it authenticates with the bearer token plus the same `X-Msh-*` identity
 *   headers every other request on this line sends;
 * - the body answers with the id at the top level or nested under
 *   `data`/`file`/`result`, and the reference a later chat body cites is
 *   `ms://<id>`;
 * - `content-type` is never set by hand: the runtime writes
 *   `multipart/form-data; boundary=...` itself, and a hand-written JSON header
 *   on a form body is a malformed request.
 *
 * DELIBERATELY NARROW. No adapter, mapper or route is touched here: this module
 * only uploads, caches and returns a reference. Integration is a later change.
 *
 * @module dsh-chatgpt-subscription/kimi-media-files
 */

import { createHash } from 'node:crypto'
import { kimiIdentityHeaders } from './oauth.ts'

/** Upload route, relative to a base URL that may already carry `/v1`. */
export const FILES_UPLOAD_PATH = '/v1/files'

/** Scheme a stored id is cited by on the wire. */
export const FILE_REF_SCHEME = 'ms://'

/**
 * Ceiling on cached references.
 *
 * Bounded because a long conversation can attach many distinct clips and a
 * process that lives for days must not grow one map per upload forever. 256 is
 * far more than one conversation cites and small enough to be invisible.
 */
export const DEFAULT_MEDIA_FILE_CACHE_ENTRIES = 256

/** Time budget for one upload request. */
export const MEDIA_UPLOAD_TIMEOUT_MS = 120_000

/** The two purposes this surface measuredly accepts. */
export type KimiMediaKind = 'image' | 'video'

/** Why one upload could not produce a usable reference. */
export type KimiMediaUploadFailure =
  /** The request was unusable before anything was sent (media type, empty body, ...). */
  | 'invalid-request'
  /** The media type is not image/* or video/*, so there is no purpose to send. */
  | 'unsupported-media'
  /** HTTP 401/403: the credential was not accepted. */
  | 'unauthorized'
  /** HTTP 404/405: this base URL does not expose the upload route. */
  | 'not-found'
  /** HTTP 413: the service refused the body as too large. */
  | 'too-large'
  /** HTTP 5xx: the service failed; the same request may succeed later. */
  | 'server'
  /** Any other non-2xx answer. */
  | 'rejected'
  /** 2xx whose body was not JSON. */
  | 'not-json'
  /** 2xx whose body carried no usable id. */
  | 'no-id'
  /** The local time budget elapsed before the response arrived. */
  | 'timeout'
  /** The request never completed (socket, DNS, TLS, ...). */
  | 'network'

/**
 * One failed upload.
 *
 * Carries the HTTP status and a REDACTED digest of the response body so a
 * caller can decide (401 -> sign in again, 5xx -> retry) without the raw body
 * reaching a log. The access token is never placed in `message` or `detail`;
 * see {@link redact}.
 */
export class KimiMediaUploadError extends Error {
  readonly failure: KimiMediaUploadFailure
  readonly status: number | null
  /** Redacted one-line digest of the response body, or '' when there was none. */
  readonly detail: string

  constructor(
    failure: KimiMediaUploadFailure,
    message: string,
    options: { status?: number | null; detail?: string } = {},
  ) {
    super(message)
    this.name = 'KimiMediaUploadError'
    this.failure = failure
    this.status = options.status ?? null
    this.detail = options.detail ?? ''
  }
}

/** What one upload needs. */
export interface KimiMediaUploadRequest {
  /** Bearer token the caller obtained; never logged and never part of a key. */
  readonly accessToken: string
  /** Coding API base, with or without a trailing slash and with or without `/v1`. */
  readonly baseUrl: string
  /**
   * Opaque, stable identifier of the ACCOUNT the bytes are uploaded under.
   *
   * It scopes the cache: an id minted for one account is never handed to
   * another, because nothing here proves the gateway shares ids across accounts.
   * It must identify the account (a user id, an account slot index) and must
   * NEVER be the access token — {@link KimiMediaFilesUploader.upload} refuses
   * that, so a token cannot end up inside a cache key by accident.
   */
  readonly accountScope: string
  /** Complete file bytes. */
  readonly data: Uint8Array
  /** Media type, such as `image/png` or `video/mp4`. */
  readonly mediaType: string
  /** Optional display name; only its leaf is used, and never as a path. */
  readonly filename?: string
  /** Cancels this caller's wait, and the upload once nobody is waiting. */
  readonly signal?: AbortSignal
}

/** Everything a caller of this module may swap out, plus test seams. */
export interface KimiMediaUploadOptions {
  /** Transport; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch
  /** Cache ceiling; defaults to {@link DEFAULT_MEDIA_FILE_CACHE_ENTRIES}. */
  readonly maxCacheEntries?: number
  /** Per-request time budget; 0 (or a negative value) disables it. */
  readonly timeoutMs?: number
}

/** One normalized upload, shared by every caller that joined the same flight. */
interface ResolvedUpload {
  readonly accessToken: string
  readonly baseUrl: string
  readonly accountScope: string
  readonly data: Uint8Array
  readonly mediaType: string
  readonly kind: KimiMediaKind
  readonly filename: string
  readonly signal?: AbortSignal
  readonly fetchFn: typeof fetch
  readonly timeoutMs: number
  readonly key: string
}

/** One in-flight upload, joined by every concurrent caller with the same key. */
interface UploadFlight {
  readonly promise: Promise<string>
  readonly controller: AbortController
  /** Callers still waiting; the transport is cancelled when this reaches 0. */
  waiters: number
  /** Set by the local timer, so an abort can be classified as a timeout. */
  readonly state: { timedOut: boolean }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * The upload URL for one coding base.
 *
 * The base this line resolves normally carries neither a version nor a trailing
 * slash (`https://api.kimi.com/coding`), so the measured route is built by
 * appending `/v1/files` and the answer is `.../coding/v1/files`. A caller that
 * passes a base which ALREADY ends in `/v1` — the official client's own
 * KIMI_CODE_BASE_URL shape — gets the prefix removed once rather than doubled:
 * `.../coding/v1/v1/files` is a 404 that reads like a missing route.
 */
export function filesUploadUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') {
    throw new KimiMediaUploadError('invalid-request', 'no base URL was given for the media upload')
  }
  // Strip the version exactly once, then any slash that was behind it.
  const base = trimmed.replace(/\/v1$/i, '').replace(/\/+$/, '')
  if (base === '') {
    throw new KimiMediaUploadError('invalid-request', 'the media upload base URL has no host')
  }
  return base + FILES_UPLOAD_PATH
}

// ---------------------------------------------------------------------------
// Media type
// ---------------------------------------------------------------------------

/** The upload purpose one media type maps to, or undefined when unsupported. */
export function mediaKindFor(mediaType: string): KimiMediaKind | undefined {
  const normalized = mediaType.trim().toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  return undefined
}

/** File extensions for the media types this line sends, for the file part's name. */
const MEDIA_TYPE_FILENAMES: Record<string, string> = {
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/gif': 'image.gif',
  'image/webp': 'image.webp',
  'image/heic': 'image.heic',
  'image/bmp': 'image.bmp',
  'video/mp4': 'video.mp4',
  'video/quicktime': 'video.mov',
  'video/webm': 'video.webm',
  'video/x-msvideo': 'video.avi',
  'video/mpeg': 'video.mpeg',
  'video/mpg': 'video.mpg',
  'video/x-flv': 'video.flv',
  'video/3gpp': 'video.3gp',
}

/**
 * The name the file part carries.
 *
 * A caller-supplied name is reduced to its leaf and stripped of control
 * characters: the part name is metadata, never a path, so a Windows-style
 * source name must not travel with its directories. Nothing depends on the
 * extension, but a reviewer looking at a captured request benefits from a real
 * one, and some gateways sniff it.
 */
function filenameFor(kind: KimiMediaKind, mediaType: string, provided?: string): string {
  const fallback = MEDIA_TYPE_FILENAMES[mediaType.trim().toLowerCase()]
    ?? (kind === 'image' ? 'image.bin' : 'video.bin')
  if (provided === undefined) return fallback
  const leaf = provided.split(/[\\/]/).pop() ?? ''
  const safe = leaf.replace(/[\u0000-\u001f\u007f"]/g, '').trim()
  return safe === '' ? fallback : safe
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Remove anything token-shaped from a string that may reach a log or an error.
 *
 * The token this upload used is removed by exact match first — a body echoing
 * the request, a proxy page quoting the Authorization header, or a service that
 * reflects the credential all end up here — then the generic shapes (bearer
 * values, JWTs, e-mail addresses) are blanked. The result is whitespace-flattened
 * and bounded so one refusal cannot become a wall of text.
 */
function redact(text: string, token: string, limit = 240): string {
  let out = text
  if (token !== '') out = out.split(token).join('<redacted>')
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9._-]{8,}/g, '<jwt>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/** Parse a body without throwing, reporting whether it was JSON at all. */
function parseJson(raw: string): { ok: boolean; value: unknown } {
  const text = raw.trim()
  if (text === '') return { ok: false, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, value: undefined }
  }
}

/**
 * One-line digest of a refusal body.
 *
 * A JSON refusal names a code and a sentence; an HTML gateway page names
 * neither. Both are reduced to a short redacted line, because "the server said
 * no" and "the server said no because the model does not accept this type" lead
 * to different fixes.
 */
function bodyDigest(raw: string, token: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const parsed = parseJson(text)
  if (parsed.ok && isRecord(parsed.value)) {
    const root = parsed.value
    const nested = isRecord(root.error) ? root.error : undefined
    const code = firstString(nested?.code) ?? firstString(root.code) ?? firstString(root.error_code) ?? ''
    const message = nested !== undefined
      ? firstString(nested.message) ?? firstString(nested.code) ?? ''
      : typeof root.error === 'string' ? root.error : firstString(root.message) ?? firstString(root.detail) ?? ''
    const composed = [code === '' ? '' : 'code=' + code, message].filter((part) => part !== '').join(' ')
    if (composed !== '') return redact(composed, token)
  }
  return redact(text, token)
}

// ---------------------------------------------------------------------------
// Response id
// ---------------------------------------------------------------------------

/** Keys the id was measured to hide behind, besides a top-level one. */
const NESTED_ID_KEYS = ['data', 'file', 'result'] as const

/** Longest id accepted, so a body echoing a document cannot become a reference. */
const MAX_FILE_ID_LENGTH = 200

/** A non-empty, single-token id; anything else is not a reference this line cites. */
function normalizeFileId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const bare = trimmed.startsWith(FILE_REF_SCHEME) ? trimmed.slice(FILE_REF_SCHEME.length) : trimmed
  if (bare === '' || bare.length > MAX_FILE_ID_LENGTH) return undefined
  // An id with whitespace or a control character is a sentence, not an id.
  if (/[\s\u0000-\u001f\u007f]/.test(bare)) return undefined
  return bare
}

/**
 * The id from a successful upload body.
 *
 * The measured body carries it at the top level, and documented shapes nest it
 * under `data`, `file` or `result`; both are read so a service-side change of
 * envelope does not blank the whole chain. A body with no id is reported by the
 * caller as `no-id` rather than accepted as an empty reference.
 */
function readFileId(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined
  if (!isRecord(value)) return undefined
  const direct = normalizeFileId(value.id)
  if (direct !== undefined) return direct
  for (const key of NESTED_ID_KEYS) {
    const nested = readFileId(value[key], depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** The wire reference for a stored id. */
export function fileReference(id: string): string {
  return FILE_REF_SCHEME + id
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** Hex SHA-256 of the bytes; the content half of the key. */
function contentSha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The cache key for one upload.
 *
 * Five things, and each of them is load-bearing:
 *
 * - ACCOUNT SCOPE, because an id minted for one account is never assumed to be
 *   readable by another (see {@link KimiMediaUploadRequest.accountScope});
 * - BASE URL (normalized through {@link filesUploadUrl}, so a trailing slash
 *   cannot split one endpoint into two slots), because two regions or two
 *   deployments are two distinct file stores;
 * - MEDIA KIND and MEDIA TYPE, because the same bytes uploaded as an image and
 *   as a video are two different resources as far as the purpose is concerned;
 * - CONTENT SHA-256, so identical bytes reuse one upload and any change at all
 *   misses the cache.
 *
 * The access token is NOT part of it: a key is written to memory only, but a
 * token in a key is a token in the next dump, and the account is already
 * identified by its scope. `|` cannot appear in a scope because the scope is
 * sanitized here.
 */
export function mediaFileCacheKey(input: {
  accountScope: string
  baseUrl: string
  mediaType: string
  data: Uint8Array
}): string {
  const kind = mediaKindFor(input.mediaType) ?? 'unsupported'
  const scope = input.accountScope.trim().replace(/[|\s]+/g, '_')
  return [
    'v1',
    scope,
    filesUploadUrl(input.baseUrl),
    kind,
    input.mediaType.trim().toLowerCase(),
    contentSha256(input.data),
  ].join('|')
}

// ---------------------------------------------------------------------------
// Uploader
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Whether one rejection is a cancellation rather than an upload failure. */
function looksAborted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

/** The abort to reject a caller with, keeping the reason it supplied. */
function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('the media upload was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Uploads one media file per distinct key, caching and single-flighting them.
 *
 * Two behaviours are deliberate and easy to get wrong:
 *
 * 1. SINGLE FLIGHT. Concurrent callers with the same key share one request.
 *    A caller that aborts stops waiting immediately and gets an AbortError, but
 *    the shared request is only cancelled once NO caller is still waiting — so
 *    one cancelled turn does not fail another turn that wants the same clip.
 * 2. NO TTL. A successful reference is cached until it is evicted by the LRU
 *    ceiling. Inventing an expiry would either expire a live id (a failed turn)
 *    or outlive it silently; nothing here measured a lifetime, so nothing here
 *    pretends to know one. A reference the service later rejects is dropped with
 *    {@link forget} by whoever sees that rejection.
 */
export class KimiMediaFilesUploader {
  private readonly fetchFn: typeof fetch
  private readonly maxCacheEntries: number
  private readonly timeoutMs: number
  /** key -> `ms://<id>`, in least-recently-used order. */
  private readonly cache = new Map<string, string>()
  private readonly flights = new Map<string, UploadFlight>()

  constructor(options: KimiMediaUploadOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    const cap = options.maxCacheEntries
    this.maxCacheEntries = cap !== undefined && Number.isFinite(cap) && cap > 0
      ? Math.floor(cap)
      : DEFAULT_MEDIA_FILE_CACHE_ENTRIES
    const timeout = options.timeoutMs
    this.timeoutMs = timeout !== undefined && Number.isFinite(timeout) ? timeout : MEDIA_UPLOAD_TIMEOUT_MS
  }

  /** Cached references currently held, for a settings surface or a test. */
  get size(): number {
    return this.cache.size
  }

  /** Uploads one file and returns the `ms://<id>` reference a request cites. */
  async upload(request: KimiMediaUploadRequest): Promise<string> {
    const resolved = this.resolve(request)
    // A caller cancelled BEFORE it asked starts nothing: no request, no cache
    // entry, and — the part that is easy to miss — no flight either. Opening a
    // flight here would begin an upload nobody wants and briefly hold the key
    // against the next real caller, which would then join a doomed flight.
    if (resolved.signal?.aborted === true) throw abortError(resolved.signal)
    const cached = this.readCache(resolved.key)
    if (cached !== undefined) return cached

    let flight = this.flights.get(resolved.key)
    if (flight === undefined) {
      flight = this.startFlight(resolved)
      this.flights.set(resolved.key, flight)
    }
    return this.join(flight, resolved)
  }

  /**
   * Drop the reference one upload would use.
   *
   * The caller that sees a stored id REJECTED on the wire calls this so the next
   * attempt uploads again instead of replaying the same dead reference.
   */
  forget(request: Omit<KimiMediaUploadRequest, 'accessToken'>): boolean {
    let key: string
    try {
      key = mediaFileCacheKey({
        accountScope: request.accountScope,
        baseUrl: request.baseUrl,
        mediaType: request.mediaType,
        data: request.data,
      })
    } catch {
      return false
    }
    return this.cache.delete(key)
  }

  /** Forget everything; a sign-out or a test starting over. */
  clear(): void {
    this.cache.clear()
  }

  // -- internals ------------------------------------------------------------

  /** Validate and normalize one request, or throw before anything is sent. */
  private resolve(request: KimiMediaUploadRequest): ResolvedUpload {
    const accessToken = request.accessToken.trim()
    if (accessToken === '') {
      throw new KimiMediaUploadError('invalid-request', 'the media upload needs an access token')
    }
    const accountScope = request.accountScope.trim()
    if (accountScope === '') {
      throw new KimiMediaUploadError('invalid-request', 'the media upload needs an account scope for its cache key')
    }
    // The scope is the only caller-supplied string that reaches the key, and a
    // token there would put a credential exactly where this module promised it
    // would never be. Refuse it loudly instead of sanitizing it silently.
    if (accountScope === request.accessToken) {
      throw new KimiMediaUploadError('invalid-request', 'the media upload cache scope must not be the access token')
    }
    const mediaType = request.mediaType.trim()
    const kind = mediaKindFor(mediaType)
    if (kind === undefined) {
      throw new KimiMediaUploadError(
        'unsupported-media',
        'the media upload accepts image/* or video/* only, not "' + mediaType + '"',
      )
    }
    if (request.data.byteLength === 0) {
      throw new KimiMediaUploadError('invalid-request', 'the media upload was given no bytes')
    }
    // Built before the request so an unusable base URL fails without a flight.
    filesUploadUrl(request.baseUrl)
    return {
      accessToken,
      baseUrl: request.baseUrl,
      accountScope,
      data: request.data,
      mediaType,
      kind,
      filename: filenameFor(kind, mediaType, request.filename),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      fetchFn: this.fetchFn,
      timeoutMs: this.timeoutMs,
      key: mediaFileCacheKey({ accountScope, baseUrl: request.baseUrl, mediaType, data: request.data }),
    }
  }

  private readCache(key: string): string | undefined {
    const ref = this.cache.get(key)
    if (ref === undefined) return undefined
    // Re-insert so the entry becomes the most recently used one.
    this.cache.delete(key)
    this.cache.set(key, ref)
    return ref
  }

  private writeCache(key: string, ref: string): void {
    this.cache.delete(key)
    this.cache.set(key, ref)
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }

  /** Open one flight and run it; the map entry is dropped as it settles. */
  private startFlight(request: ResolvedUpload): UploadFlight {
    const controller = new AbortController()
    const state: { timedOut: boolean } = { timedOut: false }
    const promise = this.performUpload(controller, state, request).finally(() => {
      if (this.flights.get(request.key)?.promise === promise) this.flights.delete(request.key)
    })
    // A flight whose every waiter aborted settles with nobody awaiting it; that
    // rejection is already recorded through the race below, so mark it handled
    // here rather than leaving it to surface as an unhandled rejection.
    void promise.catch(() => undefined)
    return { promise, controller, waiters: 0, state }
  }

  /**
   * Wait for one flight, respecting THIS caller's abort.
   *
   * The flight is not bound to the caller's signal: a caller that aborts
   * detaches, and the transport is cancelled only when the last waiter has gone.
   */
  private async join(flight: UploadFlight, request: ResolvedUpload): Promise<string> {
    const signal = request.signal
    if (signal?.aborted === true) throw abortError(signal)

    flight.waiters += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      flight.waiters -= 1
      if (flight.waiters <= 0) {
        // Nobody is waiting any more. Drop the key FIRST, so a caller that arrives
        // in the window between the cancellation and the flight's settlement starts
        // a fresh upload instead of joining this doomed one, then stop the upload.
        if (this.flights.get(request.key) === flight) this.flights.delete(request.key)
        flight.controller.abort()
      }
    }

    if (signal === undefined) {
      try {
        return await flight.promise
      } finally {
        release()
      }
    }

    // This caller's own cancellation, independent of the shared request: it fires
    // immediately even when the transport ignores the signal, which is what keeps
    // an abort from turning into a slow network failure.
    const callerSignal: AbortSignal = signal
    let detach: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(abortError(callerSignal))
      detach = (): void => callerSignal.removeEventListener('abort', onAbort)
      callerSignal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([flight.promise, cancelled])
    } finally {
      detach?.()
      release()
    }
  }

  /** The one request a flight performs. */
  private async performUpload(
    controller: AbortController,
    state: { timedOut: boolean },
    request: ResolvedUpload,
  ): Promise<string> {
    const form = new FormData()
    // `file` then `purpose`: this exact order is what the live probe sent and the
    // gateway accepted. The MiniMax line needs the opposite order, so the order
    // here is a measured fact rather than a habit.
    form.append('file', new Blob([request.data], { type: request.mediaType }), request.filename)
    form.append('purpose', request.kind)

    // Identity headers plus the bearer token the caller obtained. `content-type`
    // is deliberately absent: the runtime writes the multipart boundary itself,
    // and a hand-written value would produce a body the server cannot parse.
    const headers = await kimiIdentityHeaders({
      authorization: 'Bearer ' + request.accessToken,
      accept: 'application/json',
    })

    const timer = request.timeoutMs > 0
      ? setTimeout(() => {
          state.timedOut = true
          controller.abort()
        }, request.timeoutMs)
      : undefined
    timer?.unref()

    try {
      // ONLY the flight's own controller reaches the transport. It fires when the
      // last waiter leaves (see join) or when the local timer expires. A single
      // caller's signal is deliberately NOT merged in here: it governs that
      // caller's own wait, and merging it would let one cancelled caller kill an
      // upload another caller is still waiting for.
      let response: Response
      try {
        response = await request.fetchFn(filesUploadUrl(request.baseUrl), {
          method: 'POST',
          headers,
          body: form,
          signal: controller.signal,
        })
      } catch (error) {
        throw this.transportFailure(error, state, request)
      }

      let raw = ''
      try {
        raw = await response.text()
      } catch (error) {
        throw this.transportFailure(error, state, request)
      }
      return this.settle(response, raw, request)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Turn a transport rejection into the error the caller must see. */
  private transportFailure(
    error: unknown,
    state: { timedOut: boolean },
    request: ResolvedUpload,
  ): unknown {
    if (looksAborted(error)) {
      // Only the flight's controller can abort the transport, and it has exactly
      // two causes: the local timer (a timeout, which IS a failure) and the last
      // waiter leaving (a cancellation, which stays one instead of being dressed
      // up as a network failure). A caller's own abort never reaches here — it
      // rejects that caller's promise in join.
      if (state.timedOut) {
        return new KimiMediaUploadError(
          'timeout',
          'the media upload did not finish within ' + request.timeoutMs + ' ms',
        )
      }
      return abortError()
    }
    const message = error instanceof Error ? error.message : String(error)
    return new KimiMediaUploadError(
      'network',
      'the media upload did not complete: ' + redact(message, request.accessToken),
    )
  }

  /** Read one response into a reference, or into a typed failure. */
  private settle(response: Response, raw: string, request: ResolvedUpload): string {
    const status = response.status
    if (response.ok !== true) {
      const detail = bodyDigest(raw, request.accessToken)
      if (status === 401 || status === 403) {
        throw new KimiMediaUploadError(
          'unauthorized',
          'the Kimi Code hosted-file endpoint rejected the credential (HTTP ' + status + ')',
          { status, detail },
        )
      }
      if (status === 404 || status === 405) {
        // A missing route is not a transient: retrying the same base URL answers
        // the same 404. The caller falls back to inline media.
        throw new KimiMediaUploadError(
          'not-found',
          'the Kimi Code hosted-file endpoint is not available on this base URL (HTTP ' + status + ')',
          { status, detail },
        )
      }
      if (status === 413) {
        throw new KimiMediaUploadError(
          'too-large',
          'the Kimi Code hosted-file endpoint refused the upload as too large (HTTP 413)',
          { status, detail },
        )
      }
      if (status >= 500) {
        throw new KimiMediaUploadError(
          'server',
          'the Kimi Code hosted-file endpoint failed (HTTP ' + status + ')',
          { status, detail },
        )
      }
      throw new KimiMediaUploadError(
        'rejected',
        'the Kimi Code hosted-file endpoint refused the upload (HTTP ' + status + ')',
        { status, detail },
      )
    }

    const parsed = parseJson(raw)
    if (!parsed.ok) {
      throw new KimiMediaUploadError(
        'not-json',
        'the media upload answered HTTP ' + status + ' without a JSON body',
        { status, detail: redact(raw, request.accessToken) },
      )
    }
    const id = readFileId(parsed.value)
    if (id === undefined) {
      throw new KimiMediaUploadError(
        'no-id',
        'the media upload answered HTTP ' + status + ' without a usable file id',
        { status, detail: redact(raw, request.accessToken) },
      )
    }
    const ref = fileReference(id)
    this.writeCache(request.key, ref)
    return ref
  }
}

/** One uploader with the default transport and cache size. */
export function createMediaFilesUploader(options: KimiMediaUploadOptions = {}): KimiMediaFilesUploader {
  return new KimiMediaFilesUploader(options)
}

/**
 * The process-wide uploader the adapter will use.
 *
 * Shared on purpose: the cache is the whole point, and a per-call instance would
 * upload the same clip once per turn.
 */
export const kimiMediaFiles = createMediaFilesUploader()

/** Upload one file through the shared uploader. */
export function uploadMediaFile(request: KimiMediaUploadRequest): Promise<string> {
  return kimiMediaFiles.upload(request)
}
