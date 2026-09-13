import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'
import type { AntigravityAdapter as AdapterType } from '../src/host/antigravity/adapter.ts'

/**
 * The reported bug was observed on an installed npm package, so the fix has to be
 * proven in the artifact users install — \`lib/index.js\` — not only in \`src\`.
 * The bundle is committed output: when this test fails after a source edit, run
 * \`npm run build\`.
 */

const ROOT_DIR = path.resolve(__dirname, '..')
const BUNDLE_PATH = path.join(ROOT_DIR, 'lib', 'index.js')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ATTACHMENT = {
  attachmentId: 'sha256:bundle-check',
  mediaType: 'image/png',
  bytes: PNG.length,
  width: 1,
  height: 1,
  name: 'pasted.png',
} as unknown as Parameters<AttachmentStore['readImage']>[0]

describe.skipIf(!existsSync(BUNDLE_PATH))('Antigravity image wire format (built bundle)', () => {
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

  it('posts a pasted attachment as inlineData from lib/index.js', async () => {
    const bodies: any[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } } }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify(frame)}\r\n\r\n`)
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    process.env.DSH_ANTIGRAVITY_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // The bundle ships no declarations for a direct relative import; borrowing the
    // source module's type keeps the assertion surface fully typed.
    const bundle = await import(pathToFileURL(BUNDLE_PATH).href) as { AntigravityAdapter: typeof AdapterType }
    const store = new FileCredentialStore()
    vi.spyOn(store, 'read').mockResolvedValue({ access: 'bundle-token', expires: Date.now() + 3_600_000 })
    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({ enabledModelIds: ['gemini-3.8-flash'], catalogModels: [], defaultReasoningEffort: 'low' })
    const readImage = vi.fn(async () => ({ ref: ATTACHMENT, data: PNG }))
    const adapter = new bundle.AntigravityAdapter(store, modelSettings, undefined, { attachments: { readImage } })

    for await (const chunk of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: ATTACHMENT }] }],
    } as unknown as GenerateOptions)) { void chunk }

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].request.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: Buffer.from(PNG).toString('base64') } },
    ])
  })
})
