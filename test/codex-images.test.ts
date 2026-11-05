import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { toToolCallId } from '../src/host/common/brand-compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'
import {
  CODEX_IMAGE_EDIT_URL,
  CODEX_IMAGE_GENERATION_URL,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_TOOL_NAME,
} from '../src/compat.ts'
import { createCodexImageTool } from '../src/host/codex-images.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const GIF_1X1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const pngBytes = Buffer.from(PNG_1X1, 'base64')
const gifBytes = Buffer.from(GIF_1X1, 'base64')
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const webpBytes = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20, 0x00, 0x00, 0x00, 0x00,
])

/** Every fixture lives under one directory this file owns and removes again. */
let fixtures = ''

const FILES = {
  png: '',
  jpeg: '',
  webp: '',
  gif: '',
  text: '',
  fakePng: '',
  empty: '',
  directory: '',
  tooBig: '',
  largeOne: '',
  largeTwo: '',
}

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'dsh-codex-image-'))
  FILES.png = join(fixtures, 'reference.png')
  FILES.jpeg = join(fixtures, 'reference.jpg')
  FILES.webp = join(fixtures, 'reference.webp')
  FILES.gif = join(fixtures, 'animation.gif')
  FILES.text = join(fixtures, 'notes.txt')
  FILES.fakePng = join(fixtures, 'mislabeled.png')
  FILES.empty = join(fixtures, 'empty.png')
  FILES.directory = join(fixtures, 'folder.png')
  FILES.tooBig = join(fixtures, 'big.png')
  FILES.largeOne = join(fixtures, 'large-one.png')
  FILES.largeTwo = join(fixtures, 'large-two.png')
  await writeFile(FILES.png, pngBytes)
  await writeFile(FILES.jpeg, jpegBytes)
  await writeFile(FILES.webp, webpBytes)
  await writeFile(FILES.gif, gifBytes)
  await writeFile(FILES.text, 'just text')
  await writeFile(FILES.fakePng, jpegBytes)
  await writeFile(FILES.empty, Buffer.alloc(0))
  await mkdir(FILES.directory, { recursive: true })
  await writeFile(FILES.tooBig, Buffer.concat([pngBytes, Buffer.alloc(4_000 - pngBytes.length)]))
  await writeFile(FILES.largeOne, Buffer.concat([pngBytes, Buffer.alloc(700 - pngBytes.length)]))
  await writeFile(FILES.largeTwo, Buffer.concat([pngBytes, Buffer.alloc(700 - pngBytes.length)]))
})

afterAll(async () => {
  if (fixtures !== '') await rm(fixtures, { recursive: true, force: true })
})

async function makeOAuth(): Promise<OAuthService> {
  const store = new MemoryTokenStore()
  await store.save({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'account-id',
  })
  return new OAuthService(store)
}

interface ImageLimitsOverrides {
  maxImageBytes?: number
  maxMessageImageBytes?: number
  maxImagesPerMessage?: number
  mediaTypes?: ImageAttachmentLimits['mediaTypes']
}

function makeAttachments(overrides: ImageLimitsOverrides = {}) {
  const saved: SaveImageAttachment[] = []
  const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => {
    saved.push(input)
    return {
      attachmentId: 'image-1' as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
      name: input.name,
    }
  })
  const attachments = {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 1_000_000,
      maxImagePixels: 4_000_000,
      maxImageDimension: 8_192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...overrides,
    },
    saveImage,
  } as unknown as AttachmentStore
  return { attachments, saveImage, saved }
}

function execContext(nested: boolean) {
  const deferred: unknown[] = []
  const exec = {
    callId: toToolCallId('call-image'),
    rootCallId: toToolCallId('call-image'),
    name: CODEX_IMAGE_TOOL_NAME,
    arguments: {},
    signal: new AbortController().signal,
    ...(nested ? { parent: Symbol('parent') as never } : {}),
    token: Symbol('tool') as never,
    deferContext: (message: unknown) => { deferred.push(message) },
    concludeTurn: vi.fn(),
  }
  return { exec: exec as never, deferred }
}

function okPng(): Response {
  return Response.json({ data: [{ b64_json: PNG_1X1 }] })
}

function okGif(): Response {
  return Response.json({ data: [{ b64_json: GIF_1X1 }] })
}

interface CapturedRequest {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

function captured(fetchFn: { mock: { calls: unknown[][] } }, index = -1): CapturedRequest {
  const calls = fetchFn.mock.calls
  const call = (index < 0 ? calls[calls.length + index] : calls[index])!
  const init = call[1] as RequestInit
  return { url: String(call[0]), init, body: JSON.parse(String(init.body)) as Record<string, unknown> }
}

describe('Codex image tool', () => {
  it('requests a PNG, saves it as an attachment, and renders an image block', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments, saveImage } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })
    const { exec, deferred } = execContext(true)
    const args = { prompt: 'draw a small blue square' }

    const value = await tool.execute(args, exec)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const request = captured(fetchFn)
    expect(request.url).toBe(CODEX_IMAGE_GENERATION_URL)
    // The default body is unchanged: a call with no new option states exactly
    // these five fields, in this order, and nothing else.
    expect(Object.keys(request.body)).toEqual(['prompt', 'background', 'model', 'quality', 'size'])
    expect(request.body).toMatchObject({
      prompt: 'draw a small blue square',
      background: 'auto',
      model: CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    })
    expect(request.init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image/png',
      name: 'codex-generated-image.png',
    }))
    expect(value).toMatchObject({
      prompt: 'draw a small blue square',
      model: CODEX_IMAGE_MODEL,
      image: { attachmentId: 'image-1', mediaType: 'image/png', width: 1, height: 1 },
    })
    expect(tool.output.render(args, value as never)).toContainEqual({
      type: 'image',
      attachment: expect.objectContaining({ attachmentId: 'image-1' }),
    })
    // The generated image only reaches the next request through the injected
    // message, so its provenance and content are asserted here: the harness
    // MessageSourceMap has no catch-all kind, and this package declares its own.
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'image', attachment: expect.objectContaining({ attachmentId: 'image-1' }) }],
      source: {
        kind: PLUGIN_MESSAGE_SOURCE_KIND,
        form: 'notice',
        summary: 'Generated image from Codex image tool.',
      },
    })
    oauth.dispose()
  })

  it('sends size and quality as given and leaves the background auto otherwise', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await tool.execute({ prompt: 'a fox', size: '1536x1024', quality: 'high' }, execContext(false).exec)
    expect(captured(fetchFn).body).toMatchObject({ size: '1536x1024', quality: 'high', background: 'auto' })

    await tool.execute({ prompt: 'a fox', size: '1024x1536', quality: 'low' }, execContext(false).exec)
    expect(captured(fetchFn).body).toMatchObject({ size: '1024x1536', quality: 'low' })
    oauth.dispose()
  })

  it('maps transparentBackground true and false onto the background field', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await tool.execute({ prompt: 'a logo', transparentBackground: true }, execContext(false).exec)
    expect(captured(fetchFn).body.background).toBe('transparent')

    await tool.execute({ prompt: 'a logo', transparentBackground: false }, execContext(false).exec)
    expect(captured(fetchFn).body.background).toBe('opaque')
    oauth.dispose()
  })

  it('requests a GIF with top-level frame fields and saves the returned GIF as a .gif attachment', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments, saved } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    const value = await tool.execute(
      { prompt: 'a bouncing ball', gif: { frameCount: 8, frameDurationMs: 120 } },
      execContext(false).exec,
    )

    const body = captured(fetchFn).body
    expect(body.output_format).toBe('gif')
    expect(body.frame_count).toBe(8)
    expect(body.frame_duration_ms).toBe(120)
    // The frame fields are top-level: a nested output object would be ignored
    // upstream and silently produce a still image.
    expect(body.output).toBeUndefined()
    expect(Object.keys(body)).toEqual([
      'prompt', 'background', 'model', 'quality', 'size',
      'output_format', 'frame_count', 'frame_duration_ms',
    ])
    expect(saved[0]).toMatchObject({ mediaType: 'image/gif', name: 'codex-generated-image.gif' })
    expect(value).toMatchObject({ image: { mediaType: 'image/gif', bytes: gifBytes.length } })
    oauth.dispose()
  })

  it('accepts an empty gif object and omits both frame numbers', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await tool.execute({ prompt: 'a wave', gif: {} }, execContext(false).exec)

    const body = captured(fetchFn).body
    expect(body.output_format).toBe('gif')
    expect('frame_count' in body).toBe(false)
    expect('frame_duration_ms' in body).toBe(false)
    oauth.dispose()
  })

  it('refuses out-of-range frame numbers before any request', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    // Whole numbers outside the stated range are refused by the tool itself,
    // because the parameter schema DSL carries no numeric bounds.
    for (const gif of [
      { frameCount: 1 },
      { frameCount: 17 },
      { frameDurationMs: 19 },
      { frameDurationMs: 2_001 },
    ]) {
      await expect(tool.execute({ prompt: 'a wave', gif }, execContext(false).exec))
        .rejects.toMatchObject({ code: 'CODEX_IMAGE_GIF_INVALID' })
    }
    // A fractional number is not an integer parameter at all, so the harness's
    // own argument validation refuses it even earlier.
    for (const gif of [{ frameCount: 2.5 }, { frameDurationMs: 50.5 }]) {
      await expect(tool.execute({ prompt: 'a wave', gif }, execContext(false).exec))
        .rejects.toMatchObject({ name: 'ToolArgsError' })
    }
    // 2 and 16 frames, 20 and 2000 ms are the accepted edges.
    for (const gif of [{ frameCount: 2 }, { frameCount: 16 }, { frameDurationMs: 20 }, { frameDurationMs: 2_000 }]) {
      await tool.execute({ prompt: 'a wave', gif }, execContext(false).exec)
    }
    expect(fetchFn).toHaveBeenCalledTimes(4)
    oauth.dispose()
  })

  it('posts reference images to the edit route as inline data URLs in a JSON images array', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await tool.execute(
      { prompt: 'make it red', referenceImagePaths: [FILES.png, FILES.jpeg, FILES.webp] },
      execContext(false).exec,
    )

    const request = captured(fetchFn)
    expect(request.url).toBe(CODEX_IMAGE_EDIT_URL)
    expect(String(request.init.body)).not.toContain('Content-Disposition')
    expect(request.body.images).toEqual([
      { image_url: 'data:image/png;base64,' + PNG_1X1 },
      { image_url: 'data:image/jpeg;base64,' + jpegBytes.toString('base64') },
      { image_url: 'data:image/webp;base64,' + webpBytes.toString('base64') },
    ])
    // The ordinary fields travel with the edit, unchanged.
    expect(request.body).toMatchObject({
      prompt: 'make it red',
      background: 'auto',
      model: CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    })
    oauth.dispose()
  })

  it('refuses reference paths that are not one local still image', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    const cases: { paths: string[]; code: string; hint?: string }[] = [
      { paths: ['https://example.com/cat.png'], code: 'CODEX_IMAGE_REFERENCE_INVALID_PATH', hint: 'URL' },
      { paths: ['data:image/png;base64,AAAA'], code: 'CODEX_IMAGE_REFERENCE_INVALID_PATH' },
      { paths: [''], code: 'CODEX_IMAGE_REFERENCE_INVALID_PATH' },
      { paths: [FILES.directory], code: 'CODEX_IMAGE_REFERENCE_NOT_A_FILE' },
      { paths: [FILES.text], code: 'CODEX_IMAGE_REFERENCE_UNSUPPORTED' },
      { paths: [FILES.gif], code: 'CODEX_IMAGE_REFERENCE_UNSUPPORTED', hint: 'GIF' },
      { paths: [join(fixtures, 'missing.png')], code: 'CODEX_IMAGE_REFERENCE_NOT_FOUND' },
      { paths: [FILES.empty], code: 'CODEX_IMAGE_REFERENCE_EMPTY' },
      // A .png name over JPEG bytes is refused rather than sent under the wrong type.
      { paths: [FILES.fakePng], code: 'CODEX_IMAGE_REFERENCE_INVALID_CONTENT' },
      { paths: Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? FILES.png : FILES.jpeg)), code: 'CODEX_IMAGE_REFERENCE_LIMIT' },
    ]

    for (const { paths, code, hint } of cases) {
      const failure = await tool.execute({ prompt: 'edit', referenceImagePaths: paths }, execContext(false).exec)
        .then(() => null, (error: unknown) => error as { code?: string; message?: string })
      expect(failure, 'expected ' + JSON.stringify(paths) + ' to be refused').not.toBeNull()
      expect(failure?.code).toBe(code)
      if (hint !== undefined) expect(failure?.message).toContain(hint)
    }
    expect(fetchFn).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('refuses an oversized reference image before reading its bytes', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments } = makeAttachments({ maxImageBytes: 1_000, maxMessageImageBytes: 1_000 })
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await expect(tool.execute({ prompt: 'edit', referenceImagePaths: [FILES.tooBig] }, execContext(false).exec))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCE_TOO_LARGE' })
    // And the per-message budget is enforced across several images.
    await expect(tool.execute({ prompt: 'edit', referenceImagePaths: [FILES.largeOne, FILES.largeTwo] }, execContext(false).exec))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_REFERENCE_TOO_LARGE' })
    expect(fetchFn).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('fails clearly when the deployment accepts no GIF output', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments } = makeAttachments({ mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await expect(tool.execute({ prompt: 'a wave', gif: {} }, execContext(false).exec))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED' })
    expect(fetchFn).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('fails clearly when a GIF comes back but cannot be stored', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments, saveImage } = makeAttachments({ mediaTypes: ['image/png'] })
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await expect(tool.execute({ prompt: 'a wave' }, execContext(false).exec))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED' })
    expect(saveImage).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('rejects a requested GIF that comes back as a still image', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okPng())
    const { attachments, saveImage } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    // Saving the PNG here would report the animation request as satisfied, and
    // the caller could not tell a downgraded result from a good one.
    const failure = await tool.execute({ prompt: 'a bouncing ball', gif: { frameCount: 4 } }, execContext(false).exec)
      .then(() => null, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('CODEX_IMAGE_RESPONSE_INVALID')
    expect(failure?.message).toContain('GIF')
    expect(failure?.message).toContain('image/png')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(saveImage).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('still accepts a GIF for a request that did not ask for one', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => okGif())
    const { attachments, saved } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    // The mismatch check is one-directional: a still-image request that happens
    // to be answered with an animation is stored as what it really is.
    const value = await tool.execute({ prompt: 'a wave' }, execContext(false).exec)
    expect(value).toMatchObject({ image: { mediaType: 'image/gif' } })
    expect(saved[0]).toMatchObject({ mediaType: 'image/gif', name: 'codex-generated-image.gif' })
    oauth.dispose()
  })

  it('replays the identical request once after a 401', async () => {
    const oauth = await makeOAuth()
    const credentials = vi.spyOn(oauth, 'credentials').mockImplementation(async () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-id',
    }) as never)
    const fetchFn = vi.fn<typeof fetch>()
    fetchFn.mockResolvedValueOnce(new Response('', { status: 401 }))
    fetchFn.mockResolvedValueOnce(okGif())
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await tool.execute(
      { prompt: 'a fox', size: '1536x1024', quality: 'high', gif: { frameCount: 6 } },
      execContext(false).exec,
    )

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const first = captured(fetchFn, 0)
    const second = captured(fetchFn, 1)
    // The retry is the SAME request: a refused call is not silently degraded by
    // dropping the parameters it was refused for.
    expect(second.url).toBe(first.url)
    expect(second.body).toEqual(first.body)
    expect(credentials).toHaveBeenCalledTimes(2)
    expect(credentials.mock.calls[1]?.[0]).toBe(true)
    credentials.mockRestore()
    oauth.dispose()
  })

  it('reports a bounded, redacted excerpt for 429', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>()
    const longRun = 'A'.repeat(400)
    fetchFn.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'slow down', credential: 'Bearer sk-secret-token-value', payload: longRun }),
      { status: 429 },
    ))
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    const limited = await tool.execute({ prompt: 'a fox' }, execContext(false).exec)
      .then(() => null, (error: unknown) => error as { code?: string; message?: string })
    expect(limited?.code).toBe('CODEX_IMAGE_RATE_LIMITED')
    expect(limited?.message).toContain('rate limited')
    // The excerpt names the failure without echoing the credential or a base64 blob.
    expect(limited?.message).not.toContain('sk-secret-token-value')
    expect(limited?.message).not.toContain(longRun)
    expect(limited?.message?.length).toBeLessThan(400)
    oauth.dispose()
  })

  it('names the parameters a 400 refused and does not retry without them', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'unsupported parameter combination', credential: 'Bearer sk-secret-token-value' }),
      { status: 400 },
    ))
    const { attachments, saveImage } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    const rejected = await tool.execute(
      {
        prompt: 'animate this photo',
        size: '1024x1024',
        transparentBackground: true,
        gif: { frameCount: 6, frameDurationMs: 100 },
        referenceImagePaths: [FILES.png],
      },
      execContext(false).exec,
    ).then(() => null, (error: unknown) => error as { code?: string; message?: string })

    expect(rejected?.code).toBe('CODEX_IMAGE_REQUEST_REJECTED')
    expect(rejected?.message).toContain('400')
    // Every stated parameter is named, including the two that are usually the
    // reason a combination is refused: the GIF frame fields and the references.
    expect(rejected?.message).toContain('size=1024x1024')
    expect(rejected?.message).toContain('transparentBackground=true')
    expect(rejected?.message).toContain('gif (frameCount=6, frameDurationMs=100)')
    expect(rejected?.message).toContain('referenceImagePaths (1 image)')
    // The upstream body still travels, redacted, and bounded.
    expect(rejected?.message).toContain('unsupported parameter combination')
    expect(rejected?.message).not.toContain('sk-secret-token-value')
    // Exactly ONE request: no field was dropped to make a retry succeed.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(saveImage).not.toHaveBeenCalled()
    oauth.dispose()
  })

  it('surfaces other upstream failures with the status', async () => {
    const oauth = await makeOAuth()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('boom', { status: 503 }))
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })

    await expect(tool.execute({ prompt: 'a fox' }, execContext(false).exec))
      .rejects.toMatchObject({ code: 'CODEX_IMAGE_FAILED' })
    oauth.dispose()
  })

  it('declares image/png and image/gif in its output schema', async () => {
    const oauth = await makeOAuth()
    const { attachments } = makeAttachments()
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: (async () => okPng()) as typeof fetch })
    const schema = JSON.stringify((tool as unknown as { output: { schema: unknown } }).output.schema)
    expect(schema).toContain('image/png')
    expect(schema).toContain('image/gif')
    oauth.dispose()
  })
})
