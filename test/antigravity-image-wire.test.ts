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
    const adapter = new AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage } })

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
})
