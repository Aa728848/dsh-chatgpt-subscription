import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { flushCatalogSnapshots } from '../../../src/host/common/catalog-snapshot.ts'
import { RelayOneCatalogManager } from '../../../src/host/providers/relayone/catalog-manager.ts'
import { createRelayOneImageTool } from '../../../src/host/providers/relayone/image-tool.ts'
import { createRelayOneVideoTool } from '../../../src/host/providers/relayone/video-tool.ts'
import { defaultRelayOneSettings, type RelayOneCredentials, type RelayOneSettings } from '../../../src/host/providers/relayone/token-store.ts'
import type { RelayOneCredentialStore, RelayOneSettingsStore } from '../../../src/host/providers/relayone/token-store.ts'
import { RELAYONE_IMAGE_EDITS_URL, RELAYONE_IMAGES_URL, RELAYONE_TASKS_URL, RELAYONE_VIDEO_URL } from '../../../src/host/providers/relayone/types.ts'

vi.mock('../../../src/host/infra/network/fetch-address-policy.ts', () => ({
  lookupHostAddresses: vi.fn(async () => ['93.184.216.34']),
  assertPublicFetchTarget: vi.fn(),
}))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const listing = { data: [
  { id: 'image-one', supported_endpoint_types: ['openai', 'image-generation'] },
  { id: 'video-one', supported_endpoint_types: ['openai'] },
] }
const pricing = { data: [
  { model_name: 'image-one', enable_groups: ['【图片】'], supported_endpoint_types: ['openai', 'image-generation'] },
  { model_name: 'video-one', enable_groups: ['【视频分组】'], tags: 'model-type:video', supported_endpoint_types: ['openai'] },
] }
type Executable = {
  execute: (args: any, exec: any) => Promise<any>
  output: { render?: (args: unknown, value: unknown) => ContentBlock[]; presentationMeta?: (args: unknown, value: unknown) => unknown }
}
let home = ''
let workspace = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-media-home-'))
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-media-work-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  for (const directory of [path.join(home, 'storages'), path.join(workspace, 'relayone-videos')]) {
    const names = await fs.readdir(directory).catch(() => [] as string[])
    for (const name of names) {
      const target = path.join(directory, name)
      const stat = await fs.lstat(target).catch(() => undefined)
      if (stat?.isFile() || stat?.isSymbolicLink()) await fs.unlink(target)
    }
    await fs.rmdir(directory).catch(() => undefined)
  }
  await fs.unlink(path.join(workspace, 'reference.png')).catch(() => undefined)
  await fs.rmdir(home).catch(() => undefined)
  await fs.rmdir(workspace).catch(() => undefined)
})
function attachments() {
  const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef> => ({
    attachmentId: 'image-' + saveImage.mock.calls.length as ImageAttachmentRef['attachmentId'],
    mediaType: input.mediaType as ImageAttachmentRef['mediaType'], bytes: input.data.length, width: 1, height: 1, name: input.name,
  }))
  return {
    imageLimits: { maxImageBytes: 1_000_000, maxMessageImageBytes: 1_000_000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    saveImage,
  } as unknown as AttachmentStore
}
async function stores(fetchGeneration: (url: string, init?: RequestInit) => Promise<Response>, settingsValue: RelayOneSettings = defaultRelayOneSettings()) {
  let credentials: RelayOneCredentials | null = { apiKey: 'sk-media-test', authenticatedAt: 1 }
  const store = { read: async () => credentials } as unknown as RelayOneCredentialStore
  const settingsStore = { read: async () => settingsValue } as unknown as RelayOneSettingsStore
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/models')) return Response.json(listing)
    if (url.endsWith('/api/pricing')) return Response.json(pricing)
    return fetchGeneration(url, init)
  }) as unknown as typeof fetch
  const catalog = new RelayOneCatalogManager(store, { fetchFn })
  await catalog.refresh(true)
  return { stores: { store, settingsStore, catalog }, fetchFn }
}
const imageExec = () => ({ signal: new AbortController().signal, deferContext: vi.fn(), callId: 'call-image' })
const videoExec = () => ({ signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } }, callId: 'call-video' })

describe('RelayOne image tool', () => {
  it('generates base64 images and renders native attachment blocks', async () => {
    const { stores: media, fetchFn } = await stores(async () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }))
    const tool = createRelayOneImageTool(attachments(), media, { fetchFn }) as unknown as Executable
    const value = await tool.execute({ prompt: 'a square', n: 1 }, imageExec())
    expect(value).toMatchObject({ model: 'image-one', images: [{ mediaType: 'image/png', width: 1, height: 1 }] })
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'image-one', prompt: 'a square' })
    expect(JSON.parse(String(init.body))).not.toHaveProperty('response_format')
    expect(tool.output.render?.({}, value).some(block => block.type === 'image')).toBe(true)
  })
  it('uses multipart edits with verified local reference images', async () => {
    const reference = path.join(workspace, 'reference.png')
    await fs.writeFile(reference, PNG)
    const { stores: media, fetchFn } = await stores(async () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }))
    const tool = createRelayOneImageTool(attachments(), media, { fetchFn }) as unknown as Executable
    await tool.execute({ prompt: 'edit', referenceImagePaths: [reference] }, imageExec())
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    const last = calls.at(-1)!
    expect(String(last[0])).toBe(RELAYONE_IMAGE_EDITS_URL)
    expect(last[1].body).toBeInstanceOf(FormData)
    expect((last[1].body as FormData).get('model')).toBe('image-one')
  })
  it('polls a submitted image task and downloads its public result', async () => {
    const urls: string[] = []
    const { stores: media, fetchFn } = await stores(async url => {
      urls.push(url)
      if (url === RELAYONE_IMAGES_URL) return Response.json({ code: 200, data: [{ status: 'submitted', task_id: 'task-image' }] })
      if (url === RELAYONE_TASKS_URL + '/task-image') return Response.json({ data: { status: 'completed', result: { data: { image_urls: ['https://example.com/result.png'] } } } })
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const tool = createRelayOneImageTool(attachments(), media, { fetchFn, pollIntervalMs: 1 }) as unknown as Executable
    const value = await tool.execute({ prompt: 'async' }, imageExec())
    expect(value.images).toHaveLength(1)
    expect(urls).toEqual([RELAYONE_IMAGES_URL, RELAYONE_TASKS_URL + '/task-image', 'https://example.com/result.png'])
  })
  it('rejects reserved option overrides before spending a generation request', async () => {
    const generation = vi.fn(async () => Response.json({ data: [] }))
    const { stores: media, fetchFn } = await stores(generation)
    const tool = createRelayOneImageTool(attachments(), media, { fetchFn }) as unknown as Executable
    await expect(tool.execute({ prompt: 'x', options: { model: 'other' } }, imageExec())).rejects.toThrow(/cannot override/)
    expect(generation).not.toHaveBeenCalled()
  })
})

describe('RelayOne video tool', () => {
  it('submits once, polls, downloads, stores and exposes compatible presentationMeta', async () => {
    const urls: string[] = []
    const { stores: media, fetchFn } = await stores(async url => {
      urls.push(url)
      if (url === RELAYONE_VIDEO_URL) return Response.json({ data: { task_id: 'task-video', status: 'pending' } })
      if (url === RELAYONE_VIDEO_URL + '/task-video') return Response.json({ data: { status: 'completed', result: { video_url: 'https://example.com/result.mp4' } } })
      return new Response(Buffer.from('video-bytes'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    })
    const ctx = { get: () => undefined } as unknown as Context
    const tool = createRelayOneVideoTool(ctx, media, { fetchFn, pollIntervalMs: 1, now: () => 1_700_000_000_000 }) as unknown as Executable
    const value = await tool.execute({ prompt: 'a cat', durationSeconds: 5 }, videoExec())
    expect(value).toMatchObject({ videoPath: /^relayone-videos\/.*\.mp4$/, mediaType: 'video/mp4', model: 'video-one', taskId: 'task-video' })
    expect(await fs.readFile(path.join(workspace, value.videoPath), 'utf8')).toBe('video-bytes')
    expect(tool.output.presentationMeta?.({}, value)).toMatchObject({ videoPath: value.videoPath, mediaType: 'video/mp4', taskId: 'task-video' })
    expect(urls).toEqual([RELAYONE_VIDEO_URL, RELAYONE_VIDEO_URL + '/task-video', 'https://example.com/result.mp4'])
  })
  it('does not resubmit a failed billable task', async () => {
    const generation = vi.fn(async (url: string) => {
      if (url === RELAYONE_VIDEO_URL) return Response.json({ data: { task_id: 'failed-task', status: 'pending' } })
      return Response.json({ data: { status: 'failed', error_message: 'upstream refused' } })
    })
    const { stores: media, fetchFn } = await stores(generation)
    const tool = createRelayOneVideoTool({ get: () => undefined } as unknown as Context, media, { fetchFn, pollIntervalMs: 1 }) as unknown as Executable
    await expect(tool.execute({ prompt: 'x' }, videoExec())).rejects.toThrow(/upstream refused/)
    expect(generation).toHaveBeenCalledTimes(2)
    expect(generation.mock.calls.filter(call => call[0] === RELAYONE_VIDEO_URL)).toHaveLength(1)
  })
})
