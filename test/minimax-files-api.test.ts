import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FILE_ID_TTL_SEC,
  FILE_REF_SCHEME,
  FilesApiError,
  fileRef,
  filesPurposeFor,
  filesUploadUrl,
  uploadMediaFile,
  resetInMemoryFileIds,
} from '../src/host/minimax-code/files-api.ts'
import { buildMinimaxRequest } from '../src/host/minimax-code/mapper.ts'
import type { GenerateOptions, Message } from '../src/host/common/llm-compat.ts'

/** A 1x1 PNG, so the payload is a real image rather than a placeholder. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Selects the in-memory id cache, so a test never touches the real file. */
const MEMORY = ''

function okBody(fileId = 449052053180861): Response {
  return new Response(
    JSON.stringify({ file: { file_id: fileId, bytes: 70 }, base_resp: { status_code: 0, status_msg: 'success' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function request(overrides: Record<string, unknown> = {}): Parameters<typeof uploadMediaFile>[0] {
  return {
    accessToken: 'token',
    baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
    base64: PNG_B64,
    bytes: 70,
    mediaType: 'image/png',
    ...overrides,
  } as Parameters<typeof uploadMediaFile>[0]
}

beforeEach(() => {
  resetInMemoryFileIds()
})

describe('the Files API surface, as measured', () => {
  it('hangs the upload path off the messages base', () => {
    // Measured: /mavis/api/v1/files/upload and /v1/files/upload both 404;
    // the path under the messages base is the one that answers.
    expect(filesUploadUrl('https://agent.minimax.cn/mavis/api/v1/llm/v1'))
      .toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1/files/upload')
    expect(filesUploadUrl('https://host/mavis/api/v1/llm/v1/'))
      .toBe('https://host/mavis/api/v1/llm/v1/files/upload')
  })

  it('maps a media type to the purpose the service expects', () => {
    expect(filesPurposeFor('image/png')).toBe('image_understanding')
    expect(filesPurposeFor('video/mp4')).toBe('video_understanding')
    expect(filesPurposeFor('application/pdf')).toBeUndefined()
  })

  it('references a stored file with the mm_file scheme', () => {
    // Measured: a bare id is rejected with "image url must be http(s):// or
    // data:...;base64", so the scheme is load-bearing.
    expect(fileRef('449052053180861')).toBe(FILE_REF_SCHEME + '449052053180861')
  })
})

describe('uploading one file', () => {
  it('sends the bearer token ALONE, because the identity headers are refused', async () => {
    // Measured: with the X-Msh-* headers this line sends everywhere else, the
    // service answers {"file":null,..."invalid params"} - byte-identical to a
    // genuinely malformed body, which is what made this hard to find.
    let seen: Record<string, string> = {}
    const fetchFn = vi.fn(async (_url: unknown, init: RequestInit) => {
      seen = (init.headers ?? {}) as Record<string, string>
      return okBody()
    })
    await uploadMediaFile(request(), 'acct-1', { fetchFn: fetchFn as unknown as typeof fetch })
    expect(Object.keys(seen)).toEqual(['Authorization'])
  })

  it('appends purpose before the file part', async () => {
    // Asserted against the real request rather than a hand-built FormData: the
    // official client appends in this order and the server binds the part on it,
    // so a local FormData would only prove that FormData preserves insertion
    // order - which it does regardless of what the client does.
    let seen: FormData | undefined
    const fetchFn = vi.fn(async (_url: unknown, init: RequestInit) => {
      seen = init.body as FormData
      return okBody()
    })
    await uploadMediaFile(request(), 'acct-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      nowMs: () => 0,
      storePath: MEMORY,
    })
    expect([...(seen as unknown as FormData).keys()]).toEqual(['purpose', 'file'])
  })

  it('returns the file id from a successful body', async () => {
    const fetchFn = vi.fn(async () => okBody())
    const id = await uploadMediaFile(request(), 'acct-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      nowMs: () => 1_000_000, storePath: MEMORY,
    })
    expect(id).toBe('449052053180861')
  })

  it('reports the service own reason when the upload is refused', async () => {
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ file: null, base_resp: { status_code: 2013, status_msg: 'invalid params' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await expect(
      uploadMediaFile(request(), 'acct-1', { fetchFn: fetchFn as unknown as typeof fetch, nowMs: () => 0, storePath: MEMORY }),
    ).rejects.toMatchObject({ reason: 'rejected' })
  })

  it('treats a non-zero status_code as a refusal, not an id', async () => {
    // The service answers HTTP 200 with file:null, so reading the id without
    // checking status_code would put the literal "null" on the wire.
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ file: { file_id: 'x' }, base_resp: { status_code: 2013 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    await expect(
      uploadMediaFile(request(), 'acct-1', { fetchFn: fetchFn as unknown as typeof fetch, nowMs: () => 0, storePath: MEMORY }),
    ).rejects.toBeInstanceOf(FilesApiError)
  })

  it('names the route-gating answer rather than calling it a bad request', async () => {
    // 503/50115 means the account has no Files API route at all. Calling that a
    // rejected upload sends the reader looking at their request shape instead
    // of at their plan.
    const fetchFn = vi.fn(async () => new Response('direct_route_not_configured', { status: 503 }))
    await expect(
      uploadMediaFile(request(), 'acct-1', { fetchFn: fetchFn as unknown as typeof fetch, storePath: MEMORY }),
    ).rejects.toMatchObject({ reason: 'route-not-configured' })
  })

  it('reports a non-JSON body instead of claiming a bare refusal', async () => {
    // A wrong path answers an HTML page; "refused without naming a reason"
    // would send the reader looking in the wrong place entirely.
    const fetchFn = vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 }))
    await expect(
      uploadMediaFile(request(), 'acct-1', { fetchFn: fetchFn as unknown as typeof fetch, storePath: MEMORY }),
    ).rejects.toThrow(/non-JSON body/)
  })

  it('refuses a file above the upload ceiling instead of trying', async () => {
    const fetchFn = vi.fn(async () => okBody())
    await expect(
      uploadMediaFile(request({ bytes: 60 * 1024 * 1024 }), 'acct-1', {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'too-large' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('never shares a file id across accounts', async () => {
    // The pool can serve one conversation from several accounts, so the cache
    // key includes the account and a second account re-uploads.
    const fetchFn = vi.fn(async () => okBody())
    const options = { fetchFn: fetchFn as unknown as typeof fetch, nowMs: () => 5_000, storePath: MEMORY }
    await uploadMediaFile(request(), 'acct-1', options)
    await uploadMediaFile(request(), 'acct-2', options)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reuses a live id for the same bytes and account', async () => {
    const fetchFn = vi.fn(async () => okBody())
    const options = { fetchFn: fetchFn as unknown as typeof fetch, nowMs: () => 5_000, storePath: MEMORY }
    await uploadMediaFile(request(), 'acct-1', options)
    await uploadMediaFile(request(), 'acct-1', options)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('re-uploads once the cached id has expired', async () => {
    const fetchFn = vi.fn(async () => okBody())
    await uploadMediaFile(request(), 'acct-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      nowMs: () => 1_000, storePath: MEMORY,
    })
    // Past the 12h default the id is presumed dead and re-minted.
    await uploadMediaFile(request(), 'acct-1', {
      fetchFn: fetchFn as unknown as typeof fetch,
      nowMs: () => 1_000 + DEFAULT_FILE_ID_TTL_SEC * 1_000 + 1, storePath: MEMORY,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('an uploaded reference on the wire', () => {
  function options(block: unknown): GenerateOptions {
    return {
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: [block] } as Message],
    } as GenerateOptions
  }

  it('replaces the bytes with an mm_file reference', () => {
    const body = buildMinimaxRequest(options({
      type: 'image',
      uploadedRef: 'mm_file://449052053180861',
    }))
    const block = (body['messages'] as Array<{ content: unknown[] }>)[0]!.content[0] as Record<string, unknown>
    // The block also carries the prompt-cache marker, which the builder adds to
    // the last user block; only the reference itself is what is under test.
    expect(block['type']).toBe('image')
    expect(block['source']).toEqual({ type: 'url', url: 'mm_file://449052053180861' })
  })

  it('applies to a video too', () => {
    const body = buildMinimaxRequest(
      options({ type: 'video', uploadedRef: 'mm_file://7' }),
      undefined,
      { videoAccepted: true },
    )
    const block = (body['messages'] as Array<{ content: unknown[] }>)[0]!.content[0] as Record<string, unknown>
    expect(block['type']).toBe('video')
    expect(block['source']).toEqual({ type: 'url', url: 'mm_file://7' })
  })

  it('sends no base64 once a reference is recorded', () => {
    const body = buildMinimaxRequest(options({
      type: 'image',
      uploadedRef: 'mm_file://449052053180861',
      data: 'A'.repeat(4096),
    }))
    expect(JSON.stringify(body)).not.toContain('AAAA')
  })
})