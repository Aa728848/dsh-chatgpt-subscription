import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ANTIGRAVITY_IMAGE_MODEL, ANTIGRAVITY_IMAGE_TOOL_NAME } from '../src/compat.ts'
import type { AccountPoolStore } from '../src/host/antigravity/account-pool.ts'
import {
  buildImageRequest,
  createAntigravityImageTool,
  decodeInlineImage,
  parseImageResponse,
} from '../src/host/antigravity/image-tool.ts'
import type { FileCredentialStore } from '../src/host/antigravity/token-store.ts'
import { toToolCallId } from '../src/host/common/brand-compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../src/host/common/llm-compat.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')

function sse(...frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function imageFrame(parts: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { response: { candidates: [{ content: { role: 'model', parts }, ...extra }] } }
}

function attachmentsMock(mediaTypes: string[] = ['image/png', 'image/jpeg']) {
  const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
    attachmentId: `image-${saveImage.mock.calls.length}` as ImageAttachmentRef['attachmentId'],
    mediaType: input.mediaType,
    bytes: input.data.length,
    width: 1,
    height: 1,
    name: input.name,
  }))
  const attachments = {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 1_000_000,
      maxImagePixels: 4_000_000,
      mediaTypes,
    },
    saveImage,
  } as unknown as AttachmentStore
  return { attachments, saveImage }
}

/** A pool with the given accounts; tokens are `token-<id>`, nothing touches disk. */
function poolMock(ids: string[]) {
  const cooling = new Set<string>()
  const pool = {
    getEffectiveAccountFor: vi.fn(async (_family: string, exclude?: ReadonlySet<string>) => {
      const id = ids.find((candidate) => !exclude?.has(candidate) && !cooling.has(candidate))
      if (id === undefined) throw new Error('no account')
      return { account: { id }, token: `token-${id}`, projectId: `project-${id}` }
    }),
    markFamilyCooldown: vi.fn((id: string) => { cooling.add(id) }),
    hasAnotherAvailableAccountFor: vi.fn(async (_family: string, tried: ReadonlySet<string>) =>
      ids.some((candidate) => !tried.has(candidate) && !cooling.has(candidate))),
    read: vi.fn(async () => ({ accounts: ids.map((id) => ({ id })) })),
  }
  return { pool: pool as unknown as AccountPoolStore, mock: pool }
}

function execContext(nested: boolean, deferred: unknown[] = []) {
  return {
    callId: toToolCallId('call-image'),
    rootCallId: toToolCallId('call-image'),
    name: ANTIGRAVITY_IMAGE_TOOL_NAME,
    arguments: {},
    signal: new AbortController().signal,
    parent: nested ? Symbol('parent') as never : undefined,
    token: Symbol('tool') as never,
    deferContext: (message: unknown) => { deferred.push(message) },
    concludeTurn: vi.fn(),
  } as never
}

const store = {} as FileCredentialStore

describe('Antigravity image request', () => {
  it('asks the image runtime for text and image output, without chat-only fields', () => {
    const body = buildImageRequest('a red fox', 'project-1', '16:9')
    expect(body).toMatchObject({
      project: 'project-1',
      model: ANTIGRAVITY_IMAGE_MODEL,
      requestType: 'image_gen',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'a red fox' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } },
      },
    })
    const request = body.request as Record<string, unknown>
    expect(request.systemInstruction).toBeUndefined()
    expect(request.tools).toBeUndefined()
    expect((request.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
    expect(buildImageRequest('x', 'p').request).toMatchObject({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect((buildImageRequest('x', 'p').request as { generationConfig: Record<string, unknown> }).generationConfig.imageConfig).toBeUndefined()
  })

  it('collects final images and text, skipping thought drafts', () => {
    const parsed = parseImageResponse(sse(
      imageFrame([{ thought: true, text: 'planning' }, { thought: true, inlineData: { mimeType: 'image/png', data: 'draft' } }]),
      imageFrame([{ text: 'Here is ' }, { inline_data: { mime_type: 'image/png', data: PNG_1X1 } }]),
      imageFrame([{ text: 'your fox.' }], { finishReason: 'STOP' }),
    ))
    expect(parsed.images).toEqual([{ mimeType: 'image/png', data: PNG_1X1 }])
    expect(parsed.text).toBe('Here is your fox.')
    expect(parsed.finishReason).toBe('STOP')
  })

  it('reports a blocked prompt and surfaces upstream error frames', () => {
    expect(parseImageResponse(sse({ response: { promptFeedback: { blockReason: 'SAFETY' } } })).finishReason)
      .toBe('PROMPT_BLOCKED:SAFETY')
    expect(() => parseImageResponse(sse({ error: { message: 'boom' } })))
      .toThrow(expect.objectContaining({ code: 'ANTIGRAVITY_IMAGE_FAILED' }))
  })

  it('refuses bytes that contradict their declared type or the allowed types', () => {
    const { attachments } = attachmentsMock(['image/png'])
    expect(decodeInlineImage({ mimeType: 'image/png', data: PNG_1X1 }, attachments).mediaType).toBe('image/png')
    expect(() => decodeInlineImage({ mimeType: 'image/png', data: JPEG_HEAD }, attachments))
      .toThrow(expect.objectContaining({ code: 'ANTIGRAVITY_IMAGE_RESPONSE_INVALID' }))
    expect(() => decodeInlineImage({ mimeType: 'image/jpeg', data: JPEG_HEAD }, attachments))
      .toThrow(expect.objectContaining({ code: 'ANTIGRAVITY_IMAGE_ATTACHMENT_UNSUPPORTED' }))
    expect(() => decodeInlineImage({ mimeType: 'image/png', data: 'not base64!' }, attachments))
      .toThrow(expect.objectContaining({ code: 'ANTIGRAVITY_IMAGE_RESPONSE_INVALID' }))
  })
})

describe('Antigravity image tool', () => {
  it('saves the image as an attachment, renders it, and injects it for a nested call', async () => {
    const { pool, mock } = poolMock(['a'])
    const { attachments, saveImage } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(sse(
      imageFrame([{ text: 'A fox.' }, { inlineData: { mimeType: 'image/png', data: PNG_1X1 } }], { finishReason: 'STOP' }),
    )))
    const tool = createAntigravityImageTool(pool, store, attachments, { fetchFn })
    const deferred: unknown[] = []

    const value = await tool.execute({ prompt: '  a red fox  ', aspectRatio: '1:1' }, execContext(true, deferred))

    expect(mock.getEffectiveAccountFor).toHaveBeenCalledWith('gemini', expect.any(Set), fetchFn)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toMatch(/\/v1internal:streamGenerateContent\?alt=sse$/)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-a')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      project: 'project-a',
      model: ANTIGRAVITY_IMAGE_MODEL,
      request: { contents: [{ parts: [{ text: 'a red fox' }] }], generationConfig: { imageConfig: { aspectRatio: '1:1' } } },
    })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: 'antigravity-generated-image.png' }))
    expect(value).toMatchObject({
      prompt: 'a red fox',
      model: ANTIGRAVITY_IMAGE_MODEL,
      text: 'A fox.',
      images: [{ attachmentId: 'image-1', mediaType: 'image/png', width: 1, height: 1 }],
    })
    const rendered = tool.output.render({ prompt: 'a red fox' }, value as never)
    expect(rendered[0]).toEqual({ type: 'text', text: 'Generated image for: a red fox\nA fox.' })
    expect(rendered).toContainEqual({ type: 'image', attachment: expect.objectContaining({ attachmentId: 'image-1' }) })
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'image', attachment: expect.objectContaining({ attachmentId: 'image-1' }) }],
      source: { kind: PLUGIN_MESSAGE_SOURCE_KIND, form: 'notice' },
    })
  })

  it('does not inject a notice for a top-level call', async () => {
    const { pool } = poolMock(['a'])
    const { attachments } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(sse(imageFrame([{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }]))))
    const deferred: unknown[] = []
    await createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false, deferred))
    expect(deferred).toEqual([])
  })

  it('cools only the Gemini allowance of a 429 account and moves to the next account', async () => {
    const { pool, mock } = poolMock(['a', 'b'])
    const { attachments } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      if (auth === 'Bearer token-a') {
        return new Response(JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } }), { status: 429 })
      }
      return new Response(sse(imageFrame([{ inlineData: { mimeType: 'image/png', data: PNG_1X1 } }])))
    })
    const value = await createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false))
    // The upstream body travels with the cooldown it caused, so the next
    // attempt can report why the upstream refused.
    expect(mock.markFamilyCooldown).toHaveBeenCalledWith(
      'a', 'gemini', 30_000, '429 Rate Limit', expect.stringContaining('retryDelay'),
    )
    expect(fetchFn.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-b' })
    // One request per account: the 429 ends the endpoint chain, because a
    // verdict from one endpoint is not improved by asking a different one.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(value).toMatchObject({ images: [expect.objectContaining({ attachmentId: 'image-1' })] })
  })

  it('does not cool the Gemini allowance for a 429 that states no reset time', async () => {
    const { pool, mock } = poolMock(['a'])
    const { attachments } = attachmentsMock()
    // What the prod endpoint answers with: no details, no Retry-After.
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }),
      { status: 429 },
    ))
    await expect(createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false)))
      .rejects.toMatchObject({
        code: 'ANTIGRAVITY_IMAGE_RATE_LIMITED',
        message: expect.stringContaining('without a stated reset time'),
      })
    // The failure is reported, but it is not a claim about the account's
    // allowance, so the allowance is not cooled.
    expect(mock.markFamilyCooldown).not.toHaveBeenCalled()
    // One request: the 429 ends the endpoint chain.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('reports a rate limit when no other account remains', async () => {
    const { pool } = poolMock(['a'])
    const { attachments } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('quota exhausted', { status: 429 }))
    await expect(createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false)))
      .rejects.toMatchObject({ code: 'ANTIGRAVITY_IMAGE_RATE_LIMITED' })
  })

  it('explains an empty response with its finish reason and the model text', async () => {
    const { pool } = poolMock(['a'])
    const { attachments, saveImage } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(sse(imageFrame([{ text: 'I cannot draw that.' }], { finishReason: 'IMAGE_SAFETY' }))))
    await expect(createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false)))
      .rejects.toMatchObject({
        code: 'ANTIGRAVITY_IMAGE_EMPTY',
        message: expect.stringMatching(/finishReason: IMAGE_SAFETY.*I cannot draw that\./),
      })
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses to run while the Antigravity line is switched off, before any request', async () => {
    const { pool, mock } = poolMock(['a'])
    const { attachments } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>()
    await expect(createAntigravityImageTool(pool, store, attachments, { fetchFn, isEnabled: () => false })
      .execute({ prompt: 'fox' }, execContext(false)))
      .rejects.toMatchObject({ code: 'ANTIGRAVITY_IMAGE_DISABLED' })
    expect(mock.getEffectiveAccountFor).not.toHaveBeenCalled()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not store an image whose bytes contradict the declared type', async () => {
    const { pool } = poolMock(['a'])
    const { attachments, saveImage } = attachmentsMock()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(sse(imageFrame([{ inlineData: { mimeType: 'image/png', data: JPEG_HEAD } }]))))
    await expect(createAntigravityImageTool(pool, store, attachments, { fetchFn }).execute({ prompt: 'fox' }, execContext(false)))
      .rejects.toMatchObject({ code: 'ANTIGRAVITY_IMAGE_RESPONSE_INVALID' })
    expect(saveImage).not.toHaveBeenCalled()
  })
})
