import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'

/**
 * Wire-level cover for the pasted-image path. Every other test mocks
 * `globalThis.fetch`; this one posts to a loopback server and reads the bytes
 * that actually left the process, so the request body is proven end to end
 * (attachment resolution, mapper, JSON serialization, SSE parsing) without
 * needing Google credentials or any external network.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ATTACHMENT = {
  attachmentId: 'sha256:wire-check',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
  name: 'pasted.png',
} as unknown as Parameters<AttachmentStore['readImage']>[0]

interface RecordedRequest {
  url: string
  body: any
}

describe('Antigravity image wire format', () => {
  const servers: Server[] = []
  const previousEndpoint = process.env.DSH_ANTIGRAVITY_ENDPOINT

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
    if (previousEndpoint === undefined) delete process.env.DSH_ANTIGRAVITY_ENDPOINT
    else process.env.DSH_ANTIGRAVITY_ENDPOINT = previousEndpoint
  })

  function recordingServer(record: RecordedRequest[]): Server {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        record.push({ url: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        const frame = {
          response: {
            candidates: [{ content: { parts: [{ text: '收到图片' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
          },
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify(frame)}\r\n\r\n`)
      })
    })
    servers.push(server)
    return server
  }

  it('posts the pasted attachment to the real socket as inlineData', async () => {
    const record: RecordedRequest[] = []
    const server = recordingServer(record)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    process.env.DSH_ANTIGRAVITY_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'wire-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })
    const readImage = vi.fn(async () => ({ ref: ATTACHMENT, data: PNG }))
    // The seam declares readImageRequest; this 1x1 image never needs scaling.
    const readImageRequest = vi.fn(async (_ref: Parameters<AttachmentStore['readImageRequest']>[0],
      _target: Parameters<AttachmentStore['readImageRequest']>[1]) => ({ attachment: ATTACHMENT,
      variantId: 'variant' as never, data: PNG, mediaType: 'image/png' as const, bytes: PNG.length,
      width: 1, height: 1, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false }))
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage, readImageRequest } })

    const texts: string[] = []
    for await (const chunk of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: ATTACHMENT }],
      }],
    } as unknown as GenerateOptions)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    expect(texts.join('')).toBe('收到图片')
    expect(record).toHaveLength(1)
    expect(record[0].url).toBe('/v1internal:streamGenerateContent?alt=sse')
    expect(record[0].body.request.contents).toEqual([{
      role: 'user',
      parts: [
        { text: '这是什么？' },
        { inlineData: { mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') } },
      ],
    }])
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  /**
   * Build the adapter against the loopback recorder. `readImageRequest` is the
   * attachment service's downscaled request version, which is what the wire must
   * carry for an oversized image.
   */
  async function wireFor(
    content: unknown[],
    attachments: Pick<AttachmentStore, 'readImage' | 'readImageRequest'>,
  ): Promise<RecordedRequest> {
    const record: RecordedRequest[] = []
    const server = recordingServer(record)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    process.env.DSH_ANTIGRAVITY_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'wire-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments })

    for await (const chunk of adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash', messages: [{ role: 'user', content }],
    } as unknown as GenerateOptions)) { void chunk }

    expect(record).toHaveLength(1)
    return record[0]!
  }

  /** A stored image and the smaller request version the harness derives from it. */
  function scalingReader(options: { width: number; height: number; stored: Uint8Array; scaled: Uint8Array }) {
    const ref = { ...ATTACHMENT, width: options.width, height: options.height, bytes: options.stored.length } as typeof ATTACHMENT
    const readImage = vi.fn(async () => ({ ref, data: options.stored }))
    const readImageRequest = vi.fn(async () => ({
      attachment: ref, variantId: 'variant', data: options.scaled, mediaType: 'image/png' as const,
      bytes: options.scaled.length, width: 1024, height: 640, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
    }))
    return { ref, reader: { readImage, readImageRequest } as never, readImage, readImageRequest }
  }

  it('scales an oversized image and sends the smaller request bytes on the socket', async () => {
    const stored = new Uint8Array(4000).fill(7)
    const scaled = new Uint8Array(400).fill(9)
    const { ref, reader, readImage, readImageRequest } = scalingReader({ width: 2880, height: 1800, stored, scaled })

    const record = await wireFor([{ type: 'image', attachment: ref }], reader)
    const parts = (record.body.request.contents as Array<{ parts: Array<{ inlineData?: { data: string } }> }>)[0]!.parts

    // The wire carries the request version, and it is genuinely smaller.
    expect(readImageRequest).toHaveBeenCalledTimes(1)
    expect(readImage).not.toHaveBeenCalled()
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: Buffer.from(scaled).toString('base64') } }])
    expect(parts[0]!.inlineData!.data.length).toBeLessThan(Buffer.from(stored).toString('base64').length)
  })

  it('keeps the image count steady for a set that only fits after scaling', async () => {
    // Ten screenshots whose STORED bytes are well over the 12 MB budget, so the
    // drop path would have replaced the oldest ones. Their scaled request
    // versions fit, and the count must therefore stay at ten.
    const stored = new Uint8Array(2 * 1024 * 1024).fill(7)
    const scaled = new Uint8Array(4096).fill(9)
    const images = Array.from({ length: 10 }, (_, index) => scalingReader({
      width: 2880, height: 1800, stored, scaled,
    }).ref)
    const readImage = vi.fn(async () => ({ ref: images[0]!, data: stored }))
    const readImageRequest = vi.fn(async (ref: Parameters<AttachmentStore['readImageRequest']>[0]) => ({
      attachment: ref, variantId: 'variant' as never, data: scaled, mediaType: 'image/png' as const,
      bytes: scaled.length, width: 1024, height: 640, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
    }))

    const record = await wireFor(images.map((attachment) => ({ type: 'image', attachment })),
      { readImage, readImageRequest })
    const parts = (record.body.request.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts

    expect(parts.filter((part) => 'inlineData' in part)).toHaveLength(10)
    expect(parts.some((part) => typeof part.text === 'string' && part.text.includes('image omitted'))).toBe(false)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('sends a small image byte-for-byte as stored', async () => {
    const small = { ...ATTACHMENT, width: 640, height: 480, bytes: PNG.length } as typeof ATTACHMENT
    const readImage = vi.fn(async () => ({ ref: small, data: PNG }))
    const readImageRequest = vi.fn()

    const record = await wireFor([{ type: 'image', attachment: small }], { readImage, readImageRequest } as never)
    const parts = (record.body.request.contents as Array<{ parts: Array<{ inlineData?: { data: string } }> }>)[0]!.parts

    // An image inside the ceiling is not rescaled at all: same bytes, no call.
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') } }])
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(readImageRequest).not.toHaveBeenCalled()
  })

  it('drops the oldest images only when scaling cannot bring the request under budget', async () => {
    // These images already sit inside the edge ceiling, so they have no scale
    // target and travel as stored: scaling cannot rescue the request, which is
    // exactly when replacing the oldest ones is the right last resort. Three of
    // 6 MiB are 8 MiB of base64 each against the 12 MB budget.
    const raw = 6 * 1024 * 1024
    const stored = new Uint8Array(raw)
    const images = Array.from({ length: 3 }, (_, index) => ({
      ...ATTACHMENT, attachmentId: `sha256:flat-${index}`, width: 800, height: 600, bytes: raw,
    })) as unknown as Array<typeof ATTACHMENT>
    const readImage = vi.fn(async (ref: Parameters<AttachmentStore['readImage']>[0]) => ({ ref, data: stored }))
    const readImageRequest = vi.fn(async (ref: Parameters<AttachmentStore['readImageRequest']>[0],
      target: Parameters<AttachmentStore['readImageRequest']>[1]) => ({
      attachment: ref, variantId: 'variant' as never, data: stored, mediaType: 'image/png' as const,
      bytes: stored.length, width: target.width, height: target.height,
      depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
    }))

    const record = await wireFor(images.map((attachment) => ({ type: 'image', attachment })),
      { readImage, readImageRequest })
    const parts = (record.body.request.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts

    const omitted = parts.filter((part) => typeof part.text === 'string' && part.text.includes('image omitted'))
    expect(omitted).toHaveLength(2)
    expect(parts.filter((part) => 'inlineData' in part)).toHaveLength(1)
    // The placeholder text is unchanged from before this change.
    expect(String(omitted[0]!.text)).toBe('[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]')
    // The newest image survives, and nothing was rescaled on the way there.
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(readImage.mock.calls[0]?.[0]).toBe(images[2])
    expect(readImageRequest).not.toHaveBeenCalled()
  })
})
