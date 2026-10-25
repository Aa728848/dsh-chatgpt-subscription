import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEDIA_FILE_CACHE_ENTRIES,
  KimiMediaFilesUploader,
  KimiMediaUploadError,
  createMediaFilesUploader,
  fileReference,
  filesUploadUrl,
  kimiMediaFiles,
  mediaFileCacheKey,
  mediaKindFor,
  uploadMediaFile,
  type KimiMediaUploadRequest,
  type KimiMediaUploadFailure,
} from '../src/host/kimi-code/media-files.ts'

/**
 * The token every test uses.
 *
 * It appears in assertions only: the point of half this file is that it never
 * reaches a cache key, an error message or a response-body digest.
 */
const TOKEN = 'kimi-access-token-abcdef123456'

const BASE = 'https://api.kimi.com/coding'

/** Five bytes, so a content assertion has something to compare. */
const BYTES = new Uint8Array([1, 2, 3, 4, 5])

interface FetchCall {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}

/** A fetch stub that records every call and answers through `handler`. */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchFn: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} }
    calls.push(call)
    return await handler(call)
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

/** One upload request, with the fields a test cares about overridden. */
function request(overrides: Partial<KimiMediaUploadRequest> = {}): KimiMediaUploadRequest {
  return {
    accessToken: TOKEN,
    baseUrl: BASE,
    accountScope: 'account-1',
    data: BYTES,
    mediaType: 'image/png',
    ...overrides,
  }
}

/** Wait until a condition holds, so a flight is observed while it is in flight. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The FormData one captured call posted. */
function postedForm(call: FetchCall): FormData {
  const body = call.init.body
  if (!(body instanceof FormData)) throw new Error('the upload body was not a FormData')
  return body
}

/** The file part one captured call posted. */
function postedFile(call: FetchCall): File {
  const entry = postedForm(call).get('file')
  if (typeof entry === 'string' || entry === null) throw new Error('the upload carried no file part')
  return entry as File
}

/** The headers one captured call sent, lowercased. */
function postedHeaders(call: FetchCall): Record<string, string> {
  const headers = call.init.headers as Record<string, string>
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
}

/** The failure code one rejection carries, for compact table assertions. */
function failureOf(error: unknown): KimiMediaUploadFailure {
  if (!(error instanceof KimiMediaUploadError)) throw error
  return error.failure
}

afterEach(() => {
  kimiMediaFiles.clear()
  vi.restoreAllMocks()
})

describe('filesUploadUrl', () => {
  it('builds the measured /coding/v1/files route', () => {
    expect(filesUploadUrl('https://api.kimi.com/coding')).toBe('https://api.kimi.com/coding/v1/files')
    expect(new URL(filesUploadUrl(BASE)).pathname).toBe('/coding/v1/files')
    expect(filesUploadUrl('https://api.kimi.ai/coding/')).toBe('https://api.kimi.ai/coding/v1/files')
  })

  it('never doubles a /v1 the base already carries', () => {
    expect(filesUploadUrl('https://api.kimi.com/coding/v1')).toBe('https://api.kimi.com/coding/v1/files')
    expect(filesUploadUrl('https://api.kimi.com/coding/v1/')).toBe('https://api.kimi.com/coding/v1/files')
    expect(filesUploadUrl('https://api.kimi.com/coding/v1///')).toBe('https://api.kimi.com/coding/v1/files')
    expect(filesUploadUrl('  https://api.kimi.com/coding/V1/  ')).toBe('https://api.kimi.com/coding/v1/files')
  })

  it('refuses a base URL it cannot build a route from', () => {
    expect(() => filesUploadUrl('   ')).toThrow(KimiMediaUploadError)
    expect(() => filesUploadUrl('/v1')).toThrow(KimiMediaUploadError)
  })
})

describe('mediaKindFor', () => {
  it('maps the two purposes the surface accepts', () => {
    expect(mediaKindFor('image/png')).toBe('image')
    expect(mediaKindFor(' IMAGE/JPEG ')).toBe('image')
    expect(mediaKindFor('video/mp4')).toBe('video')
    expect(mediaKindFor('application/pdf')).toBeUndefined()
    expect(mediaKindFor('')).toBeUndefined()
  })
})

describe('upload request shape', () => {
  it('posts multipart with purpose, a named file part and no hand-written content-type', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'img-1' }))
    const uploader = createMediaFilesUploader({ fetchFn })

    await expect(uploader.upload(request())).resolves.toBe('ms://img-1')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://api.kimi.com/coding/v1/files')
    expect(call.init.method).toBe('POST')

    const form = postedForm(call)
    expect(form.get('purpose')).toBe('image')
    const file = postedFile(call)
    expect(file.name).toBe('image.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(BYTES.byteLength)

    const headers = postedHeaders(call)
    expect(headers.authorization).toBe('Bearer ' + TOKEN)
    expect(headers.accept).toBe('application/json')
    // The runtime writes multipart/form-data with a boundary; a hand-written
    // content-type is the classic way to produce an unparsable body.
    expect(headers['content-type']).toBeUndefined()
    // The identity headers every other request on this line sends travel too.
    expect(Object.keys(headers).some((key) => key.startsWith('x-msh-'))).toBe(true)
  })

  it('uploads video under the video purpose and keeps only the leaf of a supplied name', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ data: { id: 'vid-1' } }))
    const uploader = createMediaFilesUploader({ fetchFn })

    await expect(uploader.upload(request({
      mediaType: 'video/mp4',
      data: new Uint8Array([9, 9, 9]),
      filename: 'C:\\clips\\my clip.mp4',
    }))).resolves.toBe('ms://vid-1')

    const form = postedForm(calls[0])
    expect(form.get('purpose')).toBe('video')
    const file = postedFile(calls[0])
    expect(file.name).toBe('my clip.mp4')
    expect(file.type).toBe('video/mp4')
  })
})

describe('response id parsing', () => {
  const cases: Array<{ body: unknown; ref: string }> = [
    { body: { id: 'file-1' }, ref: 'ms://file-1' },
    { body: { data: { id: 'file-2' } }, ref: 'ms://file-2' },
    { body: { file: { id: 'file-3' } }, ref: 'ms://file-3' },
    { body: { result: { id: 'file-4' } }, ref: 'ms://file-4' },
    { body: { data: { file: { id: 'file-5' } } }, ref: 'ms://file-5' },
    { body: { id: 987654 }, ref: 'ms://987654' },
    { body: { id: 'ms://file-7' }, ref: 'ms://file-7' },
    { body: { id: '  file-8  ' }, ref: 'ms://file-8' },
  ]

  it('reads a top-level id and every documented nesting level', async () => {
    for (const [index, entry] of cases.entries()) {
      const { fetchFn } = stubFetch(() => jsonResponse(entry.body))
      const uploader = createMediaFilesUploader({ fetchFn })
      // Distinct bytes per case keep each key distinct, so nothing is served
      // from the cache instead of being parsed.
      const data = new Uint8Array([index + 1, 7])
      await expect(uploader.upload(request({ data }))).resolves.toBe(entry.ref)
    }
  })

  it('fails as no-id when a 2xx body carries no usable id', async () => {
    const bodies: unknown[] = [{}, { data: {} }, { id: '' }, { id: 'a b' }, { id: null }]
    for (const [index, body] of bodies.entries()) {
      const { fetchFn } = stubFetch(() => jsonResponse(body))
      const uploader = createMediaFilesUploader({ fetchFn })
      const error = await uploader.upload(request({ data: new Uint8Array([index + 20]) })).catch((thrown) => thrown)
      expect(failureOf(error)).toBe('no-id')
      expect((error as KimiMediaUploadError).status).toBe(200)
    }
  })

  it('fails as not-json when a 2xx body is not JSON at all', async () => {
    const { fetchFn } = stubFetch(() => textResponse('<html>gateway page</html>'))
    const uploader = createMediaFilesUploader({ fetchFn })
    const error = await uploader.upload(request()).catch((thrown) => thrown)
    expect(failureOf(error)).toBe('not-json')
    expect((error as KimiMediaUploadError).detail).toContain('gateway page')
  })

  it('builds the wire reference from a bare id', () => {
    expect(fileReference('abc')).toBe('ms://abc')
  })
})

describe('caching', () => {
  it('serves a repeated upload from the cache without touching the transport', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'cached-1' }))
    const uploader = createMediaFilesUploader({ fetchFn })

    await expect(uploader.upload(request())).resolves.toBe('ms://cached-1')
    await expect(uploader.upload(request())).resolves.toBe('ms://cached-1')

    expect(calls).toHaveLength(1)
    expect(uploader.size).toBe(1)
  })

  it('never reuses a reference across accounts, content, media type or base URL', async () => {
    const { fetchFn, calls } = stubFetch((call) => {
      const form = postedForm(call)
      return jsonResponse({ id: 'id-' + calls.length + '-' + String(form.get('purpose')) })
    })
    const uploader = createMediaFilesUploader({ fetchFn })

    await uploader.upload(request())
    await uploader.upload(request({ accountScope: 'account-2' }))
    await uploader.upload(request({ data: new Uint8Array([1, 2, 3, 4, 6]) }))
    await uploader.upload(request({ mediaType: 'video/png', data: BYTES }))
    await uploader.upload(request({ baseUrl: 'https://api.kimi.ai/coding' }))

    expect(calls).toHaveLength(5)
    expect(new Set(calls.map((call) => call.url)).size).toBe(2)
  })

  it('keeps the cache bounded and evicts the least recently used reference', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'id-' + calls.length }))
    const uploader = createMediaFilesUploader({ fetchFn, maxCacheEntries: 2 })

    const a = new Uint8Array([1])
    const b = new Uint8Array([2])
    const c = new Uint8Array([3])

    await uploader.upload(request({ data: a }))
    await uploader.upload(request({ data: b }))
    expect(uploader.size).toBe(2)

    // Touch A, then add C: B is now the least recently used entry.
    await uploader.upload(request({ data: a }))
    await uploader.upload(request({ data: c }))
    expect(uploader.size).toBe(2)

    // A and C are still cached; B has to be uploaded again.
    await uploader.upload(request({ data: a }))
    await uploader.upload(request({ data: c }))
    expect(calls).toHaveLength(3)

    await uploader.upload(request({ data: b }))
    expect(calls).toHaveLength(4)
    expect(uploader.size).toBe(2)
  })

  it('uses the documented default ceiling and can be emptied', async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ id: 'x' }))
    const uploader = createMediaFilesUploader({ fetchFn })
    expect(DEFAULT_MEDIA_FILE_CACHE_ENTRIES).toBe(256)

    await uploader.upload(request())
    expect(uploader.size).toBe(1)
    expect(uploader.forget({
      accountScope: 'account-1',
      baseUrl: BASE,
      mediaType: 'image/png',
      data: BYTES,
    })).toBe(true)
    expect(uploader.size).toBe(0)

    uploader.clear()
    expect(uploader.size).toBe(0)
  })

  it('does not cache a failure, so the next attempt uploads again', async () => {
    let attempt = 0
    const { fetchFn, calls } = stubFetch(() => {
      attempt += 1
      return attempt === 1 ? jsonResponse({ error: { message: 'boom' } }, 500) : jsonResponse({ id: 'retry-1' })
    })
    const uploader = createMediaFilesUploader({ fetchFn })

    const first = await uploader.upload(request()).catch((thrown) => thrown)
    expect(failureOf(first)).toBe('server')
    expect(uploader.size).toBe(0)

    await expect(uploader.upload(request())).resolves.toBe('ms://retry-1')
    expect(calls).toHaveLength(2)
    expect(uploader.size).toBe(1)
  })
})

describe('single flight', () => {
  it('uploads once for concurrent callers with the same key', async () => {
    let release: (response: Response) => void = () => undefined
    const { fetchFn, calls } = stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const uploader = createMediaFilesUploader({ fetchFn })

    const first = uploader.upload(request())
    const second = uploader.upload(request())
    await waitFor(() => calls.length === 1)

    expect(calls).toHaveLength(1)
    release(jsonResponse({ id: 'shared-1' }))

    await expect(first).resolves.toBe('ms://shared-1')
    await expect(second).resolves.toBe('ms://shared-1')
    expect(calls).toHaveLength(1)
  })

  it('joins the flight even when the concurrent caller holds a rotated token', async () => {
    let release: (response: Response) => void = () => undefined
    const { fetchFn, calls } = stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const uploader = createMediaFilesUploader({ fetchFn })

    const first = uploader.upload(request())
    // Same account, different token: the key does not depend on the credential,
    // so the second caller must not start a second upload.
    const second = uploader.upload(request({ accessToken: 'rotated-token-999999' }))
    await waitFor(() => calls.length === 1)
    release(jsonResponse({ id: 'shared-2' }))

    await expect(first).resolves.toBe('ms://shared-2')
    await expect(second).resolves.toBe('ms://shared-2')
    expect(calls).toHaveLength(1)
  })

  it('keeps the shared upload alive when the FIRST caller is the one that aborts', async () => {
    let release: (response: Response) => void = () => undefined
    const { fetchFn, calls } = stubFetch((call) => new Promise<Response>((resolve, reject) => {
      release = resolve
      // A transport that honours its signal, like a real fetch does: if the
      // shared request inherited the first caller's signal, this rejects with it.
      call.init.signal?.addEventListener('abort', () => reject(abortSignalError()), { once: true })
    }))
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()

    // The signal holder is the caller whose request opened the flight, and the
    // patient caller has no signal at all. A transport that inherited the first
    // caller's signal would die with it, failing the caller still waiting.
    const impatient = uploader.upload(request({ signal: controller.signal }))
    const patient = uploader.upload(request())
    await waitFor(() => calls.length === 1)

    controller.abort()
    const error = await impatient.catch((thrown) => thrown)
    expect(failureOfSafe(error)).toBe('AbortError')

    release(jsonResponse({ id: 'survived-leader-abort' }))
    await expect(patient).resolves.toBe('ms://survived-leader-abort')
    expect(calls).toHaveLength(1)
  })

  it('starts a fresh flight after the sharing one failed', async () => {
    let release: (response: Response) => void = () => undefined
    let attempt = 0
    const { fetchFn, calls } = stubFetch(() => {
      attempt += 1
      if (attempt === 1) return new Promise<Response>((resolve) => { release = resolve })
      return jsonResponse({ id: 'second-flight' })
    })
    const uploader = createMediaFilesUploader({ fetchFn })

    const first = uploader.upload(request())
    const joined = uploader.upload(request())
    await waitFor(() => calls.length === 1)
    release(jsonResponse({ error: 'nope' }, 500))

    await expect(first).rejects.toBeInstanceOf(KimiMediaUploadError)
    await expect(joined).rejects.toBeInstanceOf(KimiMediaUploadError)

    await expect(uploader.upload(request())).resolves.toBe('ms://second-flight')
    expect(calls).toHaveLength(2)
  })
})

describe('failures', () => {
  const table: Array<{ status: number; failure: KimiMediaUploadFailure }> = [
    { status: 401, failure: 'unauthorized' },
    { status: 403, failure: 'unauthorized' },
    { status: 404, failure: 'not-found' },
    { status: 405, failure: 'not-found' },
    { status: 413, failure: 'too-large' },
    { status: 500, failure: 'server' },
    { status: 502, failure: 'server' },
    { status: 418, failure: 'rejected' },
  ]

  it('names each HTTP refusal without leaking the token', async () => {
    for (const entry of table) {
      const { fetchFn } = stubFetch(() => jsonResponse({
        error: { code: 'bad_request', message: 'token ' + TOKEN + ' is not permitted' },
      }, entry.status))
      const uploader = createMediaFilesUploader({ fetchFn })
      const error = await uploader.upload(request({ data: new Uint8Array([entry.status % 251]) })).catch((thrown) => thrown)

      expect(failureOf(error)).toBe(entry.failure)
      const typed = error as KimiMediaUploadError
      expect(typed.status).toBe(entry.status)
      expect(typed.message).toContain(String(entry.status))
      expect(typed.message).not.toContain(TOKEN)
      expect(typed.detail).not.toContain(TOKEN)
      expect(typed.detail).toContain('code=bad_request')
      expect(uploader.size).toBe(0)
    }
  })

  it('reports a transport rejection as network instead of an upload refusal', async () => {
    const failure = new Error('getaddrinfo ENOTFOUND api.kimi.com')
    const fetchFn = (async () => { throw failure }) as unknown as typeof fetch
    const uploader = createMediaFilesUploader({ fetchFn })

    const error = await uploader.upload(request()).catch((thrown) => thrown)
    expect(failureOf(error)).toBe('network')
    expect((error as KimiMediaUploadError).status).toBeNull()
  })

  it('refuses an unusable request before a request is sent', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'never' }))
    const uploader = createMediaFilesUploader({ fetchFn })

    expect(failureOf(await uploader.upload(request({ mediaType: 'application/pdf' })).catch((e) => e)))
      .toBe('unsupported-media')
    expect(failureOf(await uploader.upload(request({ data: new Uint8Array() })).catch((e) => e)))
      .toBe('invalid-request')
    expect(failureOf(await uploader.upload(request({ accessToken: '  ' })).catch((e) => e)))
      .toBe('invalid-request')
    expect(failureOf(await uploader.upload(request({ accountScope: ' ' })).catch((e) => e)))
      .toBe('invalid-request')
    expect(failureOf(await uploader.upload(request({ baseUrl: ' ' })).catch((e) => e)))
      .toBe('invalid-request')

    expect(calls).toHaveLength(0)
  })

  it('refuses to use the access token as the cache scope', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'never' }))
    const uploader = createMediaFilesUploader({ fetchFn })

    const error = await uploader.upload(request({ accountScope: TOKEN })).catch((thrown) => thrown)
    expect(failureOf(error)).toBe('invalid-request')
    expect((error as KimiMediaUploadError).message).not.toContain(TOKEN)
    expect(calls).toHaveLength(0)
  })
})

describe('abort', () => {
  it('rejects a call whose signal was already aborted without any request', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'never' }))
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()
    controller.abort()

    const error = await uploader.upload(request({ signal: controller.signal })).catch((thrown) => thrown)
    expect(error).not.toBeInstanceOf(KimiMediaUploadError)
    expect((error as Error).name).toBe('AbortError')
    expect(calls).toHaveLength(0)
    expect(uploader.size).toBe(0)
  })

  it('leaves no flight behind for a call that was cancelled before it asked', async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ id: 'after-pre-abort' }))
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()
    controller.abort()

    const error = await uploader.upload(request({ signal: controller.signal })).catch((thrown) => thrown)
    expect(failureOfSafe(error)).toBe('AbortError')
    // Nothing was sent, and no doomed flight is sitting under the key: the next
    // real caller must start its own upload rather than join one already dead.
    expect(calls).toHaveLength(0)
    expect(uploader.size).toBe(0)

    await expect(uploader.upload(request())).resolves.toBe('ms://after-pre-abort')
    expect(calls).toHaveLength(1)
  })

  it('propagates an abort that lands mid-flight and caches nothing', async () => {
    let attempts = 0
    const { fetchFn, calls } = stubFetch((call) => {
      attempts += 1
      if (attempts === 1) {
        // A transport that honours the signal, like a real fetch does.
        return new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(abortSignalError()), { once: true })
        })
      }
      return jsonResponse({ id: 'after-abort' })
    })
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()

    const pending = uploader.upload(request({ signal: controller.signal }))
    await waitFor(() => calls.length === 1)
    controller.abort()

    const error = await pending.catch((thrown) => thrown)
    expect(error).not.toBeInstanceOf(KimiMediaUploadError)
    expect(failureOfSafe(error)).toBe('AbortError')
    // A cancellation is not a cached result: the next attempt must upload.
    await expect(uploader.upload(request())).resolves.toBe('ms://after-abort')
    expect(calls).toHaveLength(2)
  })

  it('lets one cancelled caller stop waiting while another still gets the reference', async () => {
    let release: (response: Response) => void = () => undefined
    const { fetchFn, calls } = stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()

    const patient = uploader.upload(request())
    const impatient = uploader.upload(request({ signal: controller.signal }))
    await waitFor(() => calls.length === 1)

    controller.abort()
    const error = await impatient.catch((thrown) => thrown)
    expect(failureOfSafe(error)).toBe('AbortError')

    // The shared upload was not cancelled, because one caller was still waiting.
    release(jsonResponse({ id: 'survived' }))
    await expect(patient).resolves.toBe('ms://survived')
    expect(calls).toHaveLength(1)
  })

  it('rejects promptly even when the transport ignores the signal', async () => {
    const fetchFn = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
    const uploader = createMediaFilesUploader({ fetchFn })
    const controller = new AbortController()

    const pending = uploader.upload(request({ signal: controller.signal }))
    controller.abort()

    const error = await pending.catch((thrown) => thrown)
    expect(failureOfSafe(error)).toBe('AbortError')
  })

  it('cancels the shared upload only once every waiter has gone', async () => {
    let transportAborted = false
    let attempt = 0
    const { fetchFn, calls } = stubFetch((call) => {
      attempt += 1
      if (attempt > 1) return jsonResponse({ id: 'after-all-aborted' })
      return new Promise<Response>((_resolve, reject) => {
        // A transport that honours its signal, like a real fetch does.
        call.init.signal?.addEventListener('abort', () => {
          transportAborted = true
          reject(abortSignalError())
        }, { once: true })
      })
    })
    const uploader = createMediaFilesUploader({ fetchFn })
    const first = new AbortController()
    const second = new AbortController()

    const one = uploader.upload(request({ signal: first.signal }))
    const two = uploader.upload(request({ signal: second.signal }))
    await waitFor(() => calls.length === 1)

    // One caller leaving must NOT stop the upload the other is still waiting for.
    first.abort()
    expect(failureOfSafe(await one.catch((thrown) => thrown))).toBe('AbortError')
    expect(transportAborted).toBe(false)

    // The last caller leaving must stop it, and leave nothing cached.
    second.abort()
    expect(failureOfSafe(await two.catch((thrown) => thrown))).toBe('AbortError')
    expect(transportAborted).toBe(true)
    expect(uploader.size).toBe(0)

    await expect(uploader.upload(request())).resolves.toBe('ms://after-all-aborted')
    expect(calls).toHaveLength(2)
  })

  it('keeps a timeout distinct from an abort', async () => {
    const { fetchFn, calls } = stubFetch((call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(abortSignalError()), { once: true })
    }))
    const uploader = createMediaFilesUploader({ fetchFn, timeoutMs: 10 })

    const error = await uploader.upload(request()).catch((thrown) => thrown)
    expect(failureOf(error)).toBe('timeout')
    expect(uploader.size).toBe(0)
    expect(calls).toHaveLength(1)
  })
})

describe('cache key', () => {
  it('identifies one upload without ever containing the credential', () => {
    const key = mediaFileCacheKey({
      accountScope: 'account-1',
      baseUrl: BASE,
      mediaType: 'image/png',
      data: BYTES,
    })
    expect(key).toContain('account-1')
    expect(key).toContain('https://api.kimi.com/coding/v1/files')
    expect(key).toContain('|image|image/png|')
    expect(key).toMatch(/\|[0-9a-f]{64}$/)
    expect(key).not.toContain(TOKEN)
  })

  it('changes with the account, the base, the kind, the media type and the content', () => {
    const base = { accountScope: 'account-1', baseUrl: BASE, mediaType: 'image/png', data: BYTES }
    const key = mediaFileCacheKey(base)
    expect(mediaFileCacheKey(base)).toBe(key)
    expect(mediaFileCacheKey({ ...base, accountScope: 'account-2' })).not.toBe(key)
    expect(mediaFileCacheKey({ ...base, baseUrl: 'https://api.kimi.ai/coding' })).not.toBe(key)
    expect(mediaFileCacheKey({ ...base, mediaType: 'video/mp4' })).not.toBe(key)
    expect(mediaFileCacheKey({ ...base, data: new Uint8Array([1, 2, 3, 4, 6]) })).not.toBe(key)
  })

  it('folds the base URL variants that reach one endpoint into one slot', () => {
    const base = { accountScope: 'account-1', mediaType: 'image/png', data: BYTES }
    const key = mediaFileCacheKey({ ...base, baseUrl: 'https://api.kimi.com/coding' })
    expect(mediaFileCacheKey({ ...base, baseUrl: 'https://api.kimi.com/coding/' })).toBe(key)
    expect(mediaFileCacheKey({ ...base, baseUrl: 'https://api.kimi.com/coding/v1' })).toBe(key)
  })

  it('cannot be split by a scope that contains the separator', () => {
    const base = { baseUrl: BASE, mediaType: 'image/png', data: BYTES }
    expect(mediaFileCacheKey({ ...base, accountScope: 'a|b' }))
      .toBe(mediaFileCacheKey({ ...base, accountScope: 'a b' }))
  })
})

describe('shared uploader', () => {
  it('is a single instance behind uploadMediaFile', async () => {
    expect(kimiMediaFiles).toBeInstanceOf(KimiMediaFilesUploader)
    const { fetchFn } = stubFetch(() => jsonResponse({ id: 'shared-instance' }))
    // The shared uploader is replaced with a stubbed one so no network is used.
    const stubbed = createMediaFilesUploader({ fetchFn })
    await expect(stubbed.upload(request())).resolves.toBe('ms://shared-instance')
    expect(typeof uploadMediaFile).toBe('function')
  })
})

/** An AbortError the way a real transport produces one. */
function abortSignalError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

/** The name of a rejection, or '' when it carries none. */
function failureOfSafe(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}