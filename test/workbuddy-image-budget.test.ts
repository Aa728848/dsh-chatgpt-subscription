import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import { FileModelSettingsStore } from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'

/**
 * The image budget of this line, measured on the bytes that go on the wire.
 *
 * The route reuses the shared kernel: the request is budgeted against the
 * RESOLVED images, so a screenshot the harness scaled down is measured at the
 * size it is actually sent at. Budgeting before the resolution existed measured
 * the STORED picture instead, and the route's 1.5 MB ceiling then dropped a
 * 2 MB screenshot that reaches the wire as a few kilobytes.
 */

const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
]

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function makeStore(): Promise<ReturnType<typeof createWorkBuddyStore>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-image-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 3_600_000,
      domain: 'copilot.tencent.com',
    },
  }), 'utf8')
  return createWorkBuddyStore(dir)
}

/** One stored image and the smaller request version the harness derives from it. */
function attachment(id: string, stored: Uint8Array, width: number, height: number): ImageAttachmentRef {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: stored.length,
    width,
    height,
    name: `${id}.png`,
  } as unknown as ImageAttachmentRef
}

/** An attachment store that scales one stored picture down to `scaled`. */
function scalingReader(stored: Uint8Array, scaled: Uint8Array) {
  const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: stored }))
  const readImageRequest = vi.fn(async (ref: ImageAttachmentRef) => ({
    attachment: ref, variantId: 'variant' as never, data: scaled, mediaType: 'image/png' as const,
    bytes: scaled.length, width: 1024, height: 640, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
  }))
  return { readImage, readImageRequest }
}

/** Send one turn and return the JSON body that went on the wire. */
async function send(
  messages: unknown[],
  attachments?: Pick<AttachmentStore, 'readImage' | 'readImageRequest'>,
): Promise<any> {
  const store = await makeStore()
  const bodies: any[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    bodies.push(decodeBody(init))
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const adapter = new WorkBuddyAdapter(
    store,
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    undefined,
    {
      fetchFn,
      loadCatalog: async () => CATALOG,
      ...(attachments ? { attachments } : {}),
    },
  )

  for await (const _chunk of adapter.stream({
    provider: 'workbuddy-subscription',
    model: 'glm-5.3',
    messages,
  } as unknown as GenerateOptions)) { /* consume */ }

  expect(bodies).toHaveLength(1)
  return bodies[0]
}

/** The chat body is gzipped on the wire; the plain JSON form is read as it is. */
function decodeBody(init: { body?: BodyInit | null } | undefined): any {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) return JSON.parse(gunzipSync(body).toString('utf8'))
  if (body instanceof ArrayBuffer) return JSON.parse(gunzipSync(new Uint8Array(body)).toString('utf8'))
  throw new Error('unexpected request body shape')
}

/** Every `image_url` data URL the body carries, in request order. */
function imageUrls(body: any): string[] {
  const urls: string[] = []
  for (const message of body?.messages ?? []) {
    const parts = Array.isArray(message?.content) ? message.content : []
    for (const part of parts) {
      if (part?.type === 'image_url') urls.push(String(part.image_url?.url ?? ''))
    }
  }
  return urls
}

/**
 * The text the body carries, in request order.
 *
 * A message without an image is sent as a plain string, so both shapes are
 * read here: a placeholder can land in either.
 */
function texts(body: any): string[] {
  const out: string[] = []
  for (const message of body?.messages ?? []) {
    const content = message?.content
    if (typeof content === 'string') {
      if (content !== '') out.push(content)
      continue
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'text') out.push(String(part.text ?? ''))
    }
  }
  return out
}

describe('WorkBuddy request image budget', () => {
  it('keeps a scaled screenshot whose stored size alone would have exceeded the budget', async () => {
    // The stored picture is 2 MiB, the request version the harness derives is
    // 4 KiB, and the line's budget is 1.5 MB. Measured on the bytes that are
    // sent, the request is a few kilobytes; measured on the stored bytes it
    // looked 2.8 MB over the ceiling and the picture was dropped.
    const stored = new Uint8Array(2 * 1024 * 1024).fill(7)
    const scaled = new Uint8Array(4096).fill(9)
    const ref = attachment('sha256:shot', stored, 2880, 1800)

    const body = await send([{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
      scalingReader(stored, scaled))

    const urls = imageUrls(body)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(Buffer.from(scaled).toString('base64'))
    expect(texts(body).join(' ')).not.toContain('image omitted')
  })

  it('drops the oldest image first when the request really is over budget', async () => {
    // Two pictures of 1 MiB each, both inside the edge ceiling so neither is
    // scaled: 2 x ~1.4 MB of base64 against a 1.5 MB budget. The older one goes,
    // the newer one stays.
    const oldest = new Uint8Array(1024 * 1024).fill(1)
    const newest = new Uint8Array(1024 * 1024).fill(2)
    const oldestRef = attachment('sha256:oldest', oldest, 800, 600)
    const newestRef = attachment('sha256:newest', newest, 800, 600)
    const attachments = {
      readImage: vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: ref.attachmentId === 'sha256:oldest' ? oldest : newest })),
      readImageRequest: vi.fn(),
    }

    const body = await send(
      [{ role: 'user', content: [{ type: 'image', attachment: oldestRef }, { type: 'image', attachment: newestRef }] }],
      attachments as never,
    )

    const urls = imageUrls(body)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(Buffer.from(newest).toString('base64'))
    expect(texts(body).filter((text) => text.includes('image omitted'))).toHaveLength(1)
  })

  it('keeps an unreadable image visible instead of spending the budget on it', async () => {
    // An image the attachment service cannot read carries no bytes on the wire:
    // it is serialized as a short text marker. Counting its stored size would
    // spend the budget on a picture that is not there and replace it with a
    // second placeholder, so the model is told the picture is missing twice.
    const stored = new Uint8Array(2 * 1024 * 1024).fill(7)
    const ref = attachment('sha256:shot', stored, 2880, 1800)
    const attachments = {
      readImage: vi.fn(async () => { throw new Error('attachment store unavailable') }),
      readImageRequest: vi.fn(async () => { throw new Error('attachment store unavailable') }),
    }

    const body = await send([{ role: 'user', content: [{ type: 'image', attachment: ref }] }],
      attachments as never)

    expect(imageUrls(body)).toHaveLength(0)
    const spoken = texts(body).join(' ')
    expect(spoken).toContain('image unavailable')
    expect(spoken).not.toContain('image omitted')
  })

  it('measures an image that rides inside a tool result', async () => {
    // A screenshot tool hands its picture back inside the tool result, and the
    // route sends those pixels. A budget that stopped at the top level would
    // not see them, so the request would grow past the ceiling while the route
    // believed it was inside it.
    const oldest = new Uint8Array(1024 * 1024).fill(1)
    const newest = new Uint8Array(1024 * 1024).fill(2)
    const oldestRef = attachment('sha256:oldest', oldest, 800, 600)
    const newestRef = attachment('sha256:newest', newest, 800, 600)
    const attachments = {
      readImage: vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: ref.attachmentId === 'sha256:oldest' ? oldest : newest })),
      readImageRequest: vi.fn(),
    }

    const body = await send(
      [
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'image', attachment: oldestRef }] },
        { role: 'user', content: [{ type: 'image', attachment: newestRef }] },
      ],
      attachments as never,
    )

    const urls = imageUrls(body)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(Buffer.from(newest).toString('base64'))
    expect(texts(body).filter((text) => text.includes('image omitted'))).toHaveLength(1)
  })
})
