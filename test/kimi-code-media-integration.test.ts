import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type KimiCodeCatalogModel,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import {
  createMediaFilesUploader,
  type KimiMediaFilesUploader,
} from '../src/host/kimi-code/media-files.ts'
import type { KimiCodeWire } from '../src/shared/kimi-code-contracts.ts'

/**
 * END-TO-END MEDIA INTEGRATION for the Kimi Code route.
 *
 * These tests bind the adapter's hosted-file behaviour to the wire it actually
 * produces: which upload each request performs, which reference each chat body
 * cites, what a failed upload degrades to, and what the one 404 the service
 * answers for a dead reference costs. Every transport is a stub — nothing here
 * touches the network, and no test asserts anything about the real service.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Access token every test uploads and chats with. */
const TOKEN = 'kimi-access-token-abcdef123456'

const BASE = 'https://api.kimi.com/coding'

/** A 1x1 PNG-shaped payload; the bytes only have to be bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** A small clip payload; also opaque. */
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])

/**
 * Catalog rows mirroring the shipped registry for the two tiers these tests use.
 *
 * Declared explicitly so a test's modality gate is a property of the test rather
 * than of whichever registry row happens to exist today.
 */
const CATALOG: readonly KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, inputModalities: ['text', 'image', 'video'] },
  { id: 'k3-256k', name: 'K3 (256K)', contextWindow: 262_144, inputModalities: ['text', 'image'] },
  { id: 'k3-anthropic', name: 'K3 (Messages)', contextWindow: 262_144, inputModalities: ['text', 'image', 'video'], protocol: 'anthropic' },
]

function credentials(overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: TOKEN,
    refreshToken: 'rt-1',
    // Far enough out that the adapter never refreshes during a test.
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: BASE,
    ...overrides,
  }
}

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** One captured transport call. */
interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** One readable image occurrence a test can attach. */
function imageBlock(attachmentId: string, mediaType = 'image/png'): Record<string, unknown> {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType, bytes: PNG.byteLength, width: 100, height: 100 },
  }
}

function videoBlock(attachmentId: string, mediaType = 'video/mp4'): Record<string, unknown> {
  return {
    type: 'video',
    attachment: { attachmentId, mediaType, bytes: MP4.byteLength, name: 'clip.mp4' },
  }
}

/** An image reader that hands back `bytes` for every reference it is given. */
function imageReader(bytesFor: (attachmentId: string) => Uint8Array) {
  return {
    async readImage(ref: { attachmentId: string; mediaType?: string }) {
      const bytes = bytesFor(ref.attachmentId)
      return { ref: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: bytes.byteLength, width: 100, height: 100 }, data: bytes }
    },
    async readImageRequest(ref: { attachmentId: string }) {
      const bytes = bytesFor(ref.attachmentId)
      return {
        attachment: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: bytes.byteLength, width: 100, height: 100 },
        variantId: 'v',
        data: bytes,
        mediaType: 'image/png',
        bytes: bytes.byteLength,
        width: 100,
        height: 100,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
}

/** A video reader that hands back `bytes` for every reference it is given. */
function videoReader(bytes: Uint8Array = MP4) {
  return {
    async readVideo() {
      return { data: bytes, mediaType: 'video/mp4' }
    },
  }
}

/** A chat answer shaped like a completed OpenAI-compatible stream. */
function sseResponse(): Response {
  const frames = [
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * One bytes resolver for the whole turn, whatever shape the test supplied.
 *
 * A helper rather than an inline conditional because a closure cannot narrow its
 * captured union: `() => handlers.imageBytes ?? PNG` is typed as returning the
 * FUNCTION or the bytes, which is not a reader. Binding the answer once keeps the
 * type exact without a cast.
 */
function bytesReaderFor(
  imageBytes: Uint8Array | ((attachmentId: string) => Uint8Array) | undefined,
): (attachmentId: string) => Uint8Array {
  if (typeof imageBytes === 'function') return imageBytes
  const fixed = imageBytes ?? PNG
  return () => fixed
}

/**
 * One adapter over stubbed transports.
 *
 * `credential()` is read for EVERY request, so a test can change the signed-in
 * account between two turns of the same adapter — which is the only way to
 * observe that one account's cached reference is not handed to another.
 */
async function buildAdapter(handlers: {
  upload: (form: FormData, call: Call) => Response | Promise<Response>
  chat: (body: Record<string, unknown>, call: Call) => Response | Promise<Response>
  credential?: () => KimiCodeCredentials
  imageBytes?: Uint8Array | ((attachmentId: string) => Uint8Array)
  withVideos?: boolean
  mediaFiles?: KimiMediaFilesUploader
  catalog?: readonly KimiCodeCatalogModel[]
}): Promise<{
  adapter: KimiCodeAdapter
  uploads: Call[]
  chats: Call[]
  setCredential: (next: () => KimiCodeCredentials) => void
}> {
  const uploads: Call[] = []
  const chats: Call[] = []
  let credential = handlers.credential ?? (() => credentials())

  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} }
    if (call.url.endsWith('/v1/files')) {
      uploads.push(call)
      const body = call.init.body
      if (!(body instanceof FormData)) throw new Error('the upload body was not a FormData')
      return await handlers.upload(body, call)
    }
    chats.push(call)
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    return await handlers.chat(body, call)
  }) as unknown as typeof fetch

  const store = new FileCredentialStore(tmp('kc-media-cred'))
  vi.spyOn(store, 'read').mockImplementation(async () => credential())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-media-models'))
  const catalog = handlers.catalog ?? CATALOG
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: catalog.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  } as never)

  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    loadCatalog: async () => [...catalog],
    fetchFn,
    attachments: imageReader(bytesReaderFor(handlers.imageBytes)) as never,
    ...(handlers.withVideos === true ? { videos: videoReader() as never } : {}),
    ...(handlers.mediaFiles === undefined ? {} : { mediaFiles: handlers.mediaFiles }),
  })
  return {
    adapter,
    uploads,
    chats,
    setCredential: (next) => { credential = next },
  }
}

function generateOptions(model: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { model, messages: [{ role: 'user', content: 'hello' } as never], ...overrides } as GenerateOptions
}

/** The parts of the last user message in one OpenAI body. */
function lastUserParts(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body.messages as Array<Record<string, unknown>>
  const user = messages.filter((message) => message.role === 'user').at(-1)
  if (user === undefined) throw new Error('the request carried no user message')
  return user.content as Array<Record<string, unknown>>
}

function imageUrls(parts: ReadonlyArray<Record<string, unknown>>): string[] {
  return parts
    .filter((part) => part.type === 'image_url')
    .map((part) => String((part.image_url as { url?: unknown }).url))
}

function videoUrls(parts: ReadonlyArray<Record<string, unknown>>): string[] {
  return parts
    .filter((part) => part.type === 'video_url')
    .map((part) => String((part.video_url as { url?: unknown }).url))
}

/** The `purpose` part of one captured upload. */
function purposeOf(form: FormData): string {
  const value = form.get('purpose')
  return typeof value === 'string' ? value : ''
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Upload shape and the ms:// wire
// ---------------------------------------------------------------------------

describe('hosted media on the OpenAI-compatible wire', () => {
  it('uploads each readable image and clip under its same account and cites ms:// instead of base64', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      withVideos: true,
      upload: (form) => jsonResponse({ id: purposeOf(form) === 'image' ? 'img-1' : 'vid-1' }),
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3', {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'what is this?' }, imageBlock('a'), videoBlock('v')],
      }] as never,
    })))

    // Two uploads, at the measured route, with the measured purpose values and
    // the same bearer token the chat request is about to use.
    expect(uploads).toHaveLength(2)
    for (const call of uploads) {
      expect(call.url).toBe(`${BASE}/v1/files`)
      const headers = call.init.headers as Record<string, string>
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    }
    expect(uploads.map((call) => purposeOf(call.init.body as FormData)).sort()).toEqual(['image', 'video'])

    // One chat request, citing both references and carrying no media bytes.
    expect(chats).toHaveLength(1)
    const body = JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>
    const parts = lastUserParts(body)
    expect(imageUrls(parts)).toEqual(['ms://img-1'])
    expect(videoUrls(parts)).toEqual(['ms://vid-1'])
    const wire = JSON.stringify(body)
    expect(wire).not.toContain('data:image')
    expect(wire).not.toContain('data:video')
    expect(wire).not.toContain(Buffer.from(PNG).toString('base64'))
  })

  it('uses an injected uploader instead of building its own', async () => {
    const uploader = createMediaFilesUploader({
      fetchFn: (async () => jsonResponse({ id: 'img-1' })) as unknown as typeof fetch,
    })
    const { adapter, uploads } = await buildAdapter({
      mediaFiles: uploader,
      upload: () => jsonResponse({ id: 'img-unused' }),
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })))

    // The seam won: the injected uploader holds the reference, and the adapter's
    // own transport never saw a /v1/files call.
    expect(uploader.size).toBe(1)
    expect(uploads).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Cache reuse, scoped per account
// ---------------------------------------------------------------------------

describe('reference cache', () => {
  it('uploads an unchanged clip once and never reuses one account reference for another', async () => {
    let current = credentials({ userId: 'user-a' })
    const { adapter, uploads } = await buildAdapter({
      credential: () => current,
      upload: () => jsonResponse({ id: `file-${uploads.length}` }),
      chat: () => sseResponse(),
    })
    const options = generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })

    await drain(adapter.stream(options))
    expect(uploads).toHaveLength(1)

    // The same account, the same bytes: the second turn must not upload again.
    await drain(adapter.stream(options))
    expect(uploads).toHaveLength(1)

    // A different account is a different file store, so the reference cannot be
    // reused even though the bytes are identical.
    current = credentials({ userId: 'user-b' })
    await drain(adapter.stream(options))
    expect(uploads).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 3. Per-media fallback, and cancellation
// ---------------------------------------------------------------------------

describe('upload failure', () => {
  it('falls back inline only for the media whose upload failed', async () => {
    // Two attachments with two DIFFERENT payloads: the upload cache keys on the
    // content, so identical bytes are one upload by design and could never show a
    // per-media failure.
    const second = new Uint8Array([...PNG, 0x2a])
    const { adapter, uploads, chats } = await buildAdapter({
      imageBytes: (attachmentId) => (attachmentId === 'b' ? second : PNG),
      upload: (form) => {
        const file = form.get('file') as File
        // The store accepts the first payload and refuses the second.
        return file.size === PNG.byteLength
          ? jsonResponse({ id: 'img-a' })
          : jsonResponse({ error: { message: 'gone' } }, 404)
      },
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a'), imageBlock('b')] }] as never,
    })))

    expect(uploads).toHaveLength(2)
    expect(chats).toHaveLength(1)
    const body = JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>
    const parts = lastUserParts(body)
    // The referenced image first, then the refused one still carrying its bytes:
    // one failed upload must not cost the request its other media.
    expect(imageUrls(parts)).toEqual([
      'ms://img-a',
      'data:image/png;base64,' + Buffer.from(second).toString('base64'),
    ])
  })

  it('treats every upload refusal as an inline fallback and still sends the turn', async () => {
    for (const status of [401, 403, 405, 413, 500, 503]) {
      const { adapter, chats } = await buildAdapter({
        upload: () => jsonResponse({ error: { message: 'no' } }, status),
        chat: () => sseResponse(),
      })
      const chunks = await drain(adapter.stream(generateOptions('k3-256k', {
        messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
      })))
      expect(chats).toHaveLength(1)
      expect(imageUrls(lastUserParts(JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>))[0])
        .toMatch(/^data:image\/png;base64,/)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    }
  })

  it('never swallows a cancellation: an aborted upload sends no chat request at all', async () => {
    const controller = new AbortController()
    const { adapter, chats } = await buildAdapter({
      upload: () => {
        controller.abort()
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      },
      chat: () => sseResponse(),
    })

    await expect(drain(adapter.stream(generateOptions('k3-256k', {
      signal: controller.signal,
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(chats).toHaveLength(0)
  })

  it('uploads nothing for a media the model does not declare', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      // Only an image reader is injected, so an unreadable clip must also stay put.
      upload: () => jsonResponse({ id: 'img-1' }),
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [videoBlock('v'), imageBlock('a')] }] as never,
    })))

    // k3-256k declares no video input, so the clip is neither uploaded nor cited.
    expect(uploads).toHaveLength(1)
    expect(purposeOf(uploads[0]!.init.body as FormData)).toBe('image')
    const parts = lastUserParts(JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>)
    expect(videoUrls(parts)).toHaveLength(0)
    expect(imageUrls(parts)).toEqual(['ms://img-1'])
  })
})

// ---------------------------------------------------------------------------
// 4. The missing-resource 404
// ---------------------------------------------------------------------------

describe('a reference the store no longer holds', () => {
  it('forgets the dead reference and resends the same account inline, exactly once', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      upload: () => jsonResponse({ id: `file-${uploads.length}` }),
      chat: () => (chats.length === 1
        ? jsonResponse({ error: { message: 'The requested resource was not found' } }, 404)
        : sseResponse()),
    })
    const options = generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })

    const chunks = await drain(adapter.stream(options))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })

    // Exactly two chat attempts: the cited one and the inline resend.
    expect(chats).toHaveLength(2)
    // The upload id the stub minted for the first (and only) upload of this turn.
    expect(imageUrls(lastUserParts(JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>)))
      .toEqual(['ms://file-1'])
    const resent = JSON.parse(String(chats[1]!.init.body)) as Record<string, unknown>
    expect(imageUrls(lastUserParts(resent))).toEqual([`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`])
    expect(JSON.stringify(resent)).not.toContain('ms://')

    // The cache entry was dropped, so the next turn uploads again rather than
    // replaying an id already known to be dead.
    await drain(adapter.stream(options))
    expect(uploads).toHaveLength(2)
  })

  it('does not resend for a 404 that is not the missing-resource sentence', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      upload: () => jsonResponse({ id: 'file-0' }),
      chat: () => jsonResponse({ error: { message: 'model k3-256k not found' } }, 404),
    })

    await expect(drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })

    expect(chats).toHaveLength(1)
    // Nothing was forgotten over a 404 that says nothing about the reference.
    expect(uploads).toHaveLength(1)
  })

  it('does not resend when the request cited no reference at all', async () => {
    const { adapter, chats } = await buildAdapter({
      upload: () => jsonResponse({ error: { message: 'no' } }, 500),
      chat: () => jsonResponse({ error: { message: 'The requested resource was not found' } }, 404),
    })

    await expect(drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a')] }] as never,
    })))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(chats).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. The Anthropic surface is untouched
// ---------------------------------------------------------------------------

describe('the Anthropic Messages wire', () => {
  it('uploads nothing and keeps its inline image and text-degraded clip', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      withVideos: true,
      upload: () => jsonResponse({ id: 'never' }),
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3-anthropic', {
      messages: [{ role: 'user', content: [imageBlock('a'), videoBlock('v')] }] as never,
    }))).catch(() => undefined)

    expect(uploads).toHaveLength(0)
    expect(chats).toHaveLength(1)
    const wire = String(chats[0]!.init.body)
    // The image keeps its documented base64 source block...
    expect(wire).toContain('"source":{"type":"base64","media_type":"image/png","data":"')
    // ...and the clip still degrades to text rather than to an invented field.
    expect(wire).not.toContain('video_url')
    expect(wire).not.toContain('ms://')
  })
})

// ---------------------------------------------------------------------------
// 6. The body ceiling still owns the request
// ---------------------------------------------------------------------------

describe('body fit with references', () => {
  it('refuses an oversized conversation before paying for any upload', async () => {
    const { adapter, uploads, chats } = await buildAdapter({
      upload: () => jsonResponse({ id: 'file-0' }),
      chat: () => sseResponse(),
    })

    await expect(drain(adapter.stream(generateOptions('k3-256k', {
      messages: [
        { role: 'user', content: [imageBlock('a')] },
        { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2_400_000) }] },
      ] as never,
    })))).rejects.toThrow(/Kimi Code rejected the request before sending/)

    // The ceiling was checked before the upload, so nothing was paid for.
    expect(uploads).toHaveLength(0)
    expect(chats).toHaveLength(0)
  })

  it('uploads nothing for a media the body no longer carries, and cites the one it keeps', async () => {
    // Two ~1 MB images together exceed the route's image budget, so the budget
    // pass replaces the OLDEST occurrence with a text placeholder before the
    // request is planned. The plan still lists both readings, so unless the upload
    // set is read off the FINAL build the dropped one is uploaded under a reference
    // nothing cites — bytes paid for that no request will ever mention.
    //
    // The budget is PINNED for this test. The route's own ceiling is Kimi's 20 MiB
    // (the official CLI's REQUEST_MEDIA_BUDGET_BYTES), and a test that allocated
    // twenty megabytes of pixels to reach it would be slow for no gain. The pinned
    // pair of marks drops exactly the OLDER image: the two images carry 1.33 MB
    // and 1.20 MB of base64, the ceiling is 2.40 MB and the recovery mark is
    // 1.20 MB, so the older one goes and the younger one stays.
    const previousBudget = process.env.DSH_KIMI_CODE_MAX_IMAGE_BYTES
    process.env.DSH_KIMI_CODE_MAX_IMAGE_BYTES = '2400000'
    try {
      const dropped = new Uint8Array(1_000_000).fill(7)
      const kept = new Uint8Array(900_000).fill(9)
      const { adapter, uploads, chats } = await buildAdapter({
        imageBytes: (attachmentId) => (attachmentId === 'a' ? dropped : kept),
        // The minted id names the payload size, so which occurrence was uploaded is
        // not a guess: only the surviving one is 900,000 bytes.
        upload: (form) => jsonResponse({ id: 'img-' + (form.get('file') as File).size }),
        chat: () => sseResponse(),
      })

      const chunks = await drain(adapter.stream(generateOptions('k3-256k', {
        messages: [{ role: 'user', content: [imageBlock('a'), imageBlock('b')] }] as never,
      })))

      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
      // Exactly ONE upload: the occurrence that survived the budget pass.
      expect(uploads).toHaveLength(1)
      const body = JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>
      expect(imageUrls(lastUserParts(body))).toEqual(['ms://img-' + kept.byteLength])
      // The dropped occurrence contributes neither a reference nor its bytes.
      expect(JSON.stringify(body)).not.toContain('data:image')
    } finally {
      // The pin belongs to THIS test: the next one must see the route's own
      // ceiling again.
      if (previousBudget === undefined) delete process.env.DSH_KIMI_CODE_MAX_IMAGE_BYTES
      else process.env.DSH_KIMI_CODE_MAX_IMAGE_BYTES = previousBudget
    }
  })

  it('sends a body the inline form would have overrun, because the reference is smaller', async () => {
    // 1.1 MB of image bytes become ~1.47 MB of base64, which is inside the image
    // budget and therefore kept inline; with ~0.7 MB of text the inline body is
    // over the 2 MB ceiling of this tier, while the reference body is not.
    const bigImage = new Uint8Array(1_100_000)
    const { adapter, uploads, chats } = await buildAdapter({
      imageBytes: bigImage,
      upload: () => jsonResponse({ id: 'file-0' }),
      chat: () => sseResponse(),
    })

    const chunks = await drain(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [imageBlock('a'), { type: 'text', text: 'y'.repeat(700_000) }] }] as never,
    })))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(uploads).toHaveLength(1)
    expect(chats).toHaveLength(1)
    const body = JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>
    expect(imageUrls(lastUserParts(body))).toEqual(['ms://file-0'])
    expect(JSON.stringify(body)).not.toContain('data:image')
    // The reference body really is far smaller than the inline one would have been.
    expect(Buffer.byteLength(String(chats[0]!.init.body), 'utf8')).toBeLessThan(1_000_000)
  })
})

// ---------------------------------------------------------------------------
// 7. The wire the mapper must keep for the reasoning dialect
// ---------------------------------------------------------------------------

describe('unrelated wire behaviour is preserved', () => {
  it('still sends the preserved-thinking fields alongside a reference', async () => {
    const { adapter, chats } = await buildAdapter({
      upload: () => jsonResponse({ id: 'file-0' }),
      chat: () => sseResponse(),
    })

    await drain(adapter.stream(generateOptions('k3-256k', {
      messages: [
        { role: 'user', content: [imageBlock('a')] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier' }], source: { replayState: { blocks: [{ reasoning: [{ key: 'reasoning_content', length: 2 }] }] } } },
      ] as never,
    })))

    const body = JSON.parse(String(chats[0]!.init.body)) as Record<string, unknown>
    expect(body.thinking).toMatchObject({ type: 'enabled', keep: 'all' })
    const assistant = (body.messages as Array<Record<string, unknown>>).find((message) => message.role === 'assistant')
    expect(assistant).toMatchObject({ reasoning_content: '' })
  })
})
