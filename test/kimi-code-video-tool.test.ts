// @vitest-environment node
/**
 * Tests for the Kimi video ingress: the local store behind it, and the tool
 * that ingests a local path or an http(s) URL.
 *
 * The tool is the only producer of a video block in this plugin, so these
 * tests cover the whole path a video takes before the request mapper sees it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_VIDEO_FILE_BYTES,
  mediaTypeForPath,
  readVideoBytes,
  saveVideo,
  storedPathFor,
  VideoIngestError,
} from '../src/host/kimi-code/video-store.ts'
import { createKimiVideoTool } from '../src/host/kimi-code/video-tool.ts'

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])

let home: string
let work: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kimi-video-home-'))
  work = await mkdtemp(path.join(tmpdir(), 'kimi-video-work-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

describe('media type detection', () => {
  it('maps the documented containers and refuses an unknown extension', () => {
    expect(mediaTypeForPath('/a/b.mp4')).toBe('video/mp4')
    expect(mediaTypeForPath('/a/b.MOV')).toBe('video/quicktime')
    expect(mediaTypeForPath('/a/b.webm')).toBe('video/webm')
    expect(mediaTypeForPath('/a/b.txt')).toBeUndefined()
    expect(mediaTypeForPath('/a/b')).toBeUndefined()
  })
})

describe('video store', () => {
  it('commits bytes and returns a content-addressed reference', async () => {
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'clip.mp4' })
    expect(ref.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ref.mediaType).toBe('video/mp4')
    expect(ref.bytes).toBe(MP4.byteLength)
    expect(ref.name).toBe('clip.mp4')
  })

  it('round-trips the exact bytes', async () => {
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'clip.mp4' })
    expect(Array.from(await readVideoBytes(ref))).toEqual(Array.from(MP4))
  })

  it('is idempotent for identical bytes', async () => {
    const a = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'one.mp4' })
    const b = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'two.mp4' })
    expect(a.attachmentId).toBe(b.attachmentId)
  })

  it('refuses an unsupported container', async () => {
    await expect(saveVideo({ data: MP4, declaredType: 'application/zip', name: 'x.mp4' }))
      .rejects.toBeInstanceOf(VideoIngestError)
  })

  it('refuses empty bytes', async () => {
    await expect(saveVideo({ data: new Uint8Array(), declaredType: 'video/mp4', name: 'x.mp4' }))
      .rejects.toThrow(/empty/)
  })

  it('refuses an oversized payload without buffering it', async () => {
    await expect(saveVideo({
      data: MP4,
      declaredType: 'video/mp4',
      name: 'x.mp4',
      declaredBytes: MAX_VIDEO_FILE_BYTES + 1,
    })).rejects.toThrow(/above the/)
  })

  it('refuses a reference it did not issue', async () => {
    await expect(readVideoBytes({ attachmentId: 'not-a-digest', mediaType: 'video/mp4', bytes: 1 }))
      .rejects.toThrow(/not one this store issued/)
  })

  it('refuses bytes that no longer match their digest', async () => {
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'clip.mp4' })
    await writeFile(storedPathFor(ref)!, new Uint8Array([9, 9, 9, 9]))
    await expect(readVideoBytes(ref)).rejects.toThrow(/integrity check/)
  })

  it('refuses a stored object that has gone missing', async () => {
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'clip.mp4' })
    await rm(storedPathFor(ref)!)
    await expect(readVideoBytes(ref)).rejects.toThrow(/missing/)
  })
})

describe('the attach tool', () => {
  function context(modelInputs: string[] | undefined) {
    return {
      get: (name: string) => (name === 'llm'
        ? { resolveModelInfo: async () => ({ provider: 'kimi-code', id: 'k3', name: 'K3', inputModalities: modelInputs }) }
        : undefined),
    }
  }

  function execution(provider = 'kimi-code', model = 'k3') {
    const deferred: unknown[] = []
    const exec = {
      signal: undefined,
      callId: 'call-1',
      agent: { session: { requestHeader: () => ({ config: { provider, model } }) }, options: {} },
      deferContext: (message: unknown) => { deferred.push(message) },
    }
    return { deferred, exec }
  }

  type Executable = { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> }

  function tool(inputs: string[] | undefined, fetchFn?: unknown) {
    return createKimiVideoTool(
      context(inputs) as never,
      fetchFn === undefined ? {} : { fetchFn: fetchFn as never },
    ) as never as Executable
  }

  async function writeVideo(name = 'demo.mp4'): Promise<string> {
    const file = path.join(work, name)
    await writeFile(file, MP4)
    return file
  }

  it('reads a local file and injects the video block', async () => {
    const file = await writeVideo()
    const { deferred, exec } = execution()
    const result = await tool(['text', 'image', 'video']).execute({ source: file }, exec)
    expect(result.mediaType).toBe('video/mp4')
    expect(result.bytes).toBe(MP4.byteLength)
    expect(deferred).toHaveLength(1)
    const content = (deferred[0] as { content: Array<{ type: string }> }).content
    expect(content[0]?.type).toBe('video')
  })

  it('carries the question alongside the video', async () => {
    const file = await writeVideo()
    const { deferred, exec } = execution()
    await tool(['text', 'video']).execute({ source: file, question: 'what happens?' }, exec)
    const content = (deferred[0] as { content: Array<{ type: string; text?: string }> }).content
    expect(content.map((block) => block.type)).toEqual(['video', 'text'])
    expect(content[1]?.text).toBe('what happens?')
  })

  it('refuses a relative path', async () => {
    const { exec } = execution()
    await expect(tool(['text', 'video']).execute({ source: 'demo.mp4' }, exec)).rejects.toThrow(/absolute/)
  })

  it('refuses an unsupported extension', async () => {
    const file = await writeVideo('notes.txt')
    const { exec } = execution()
    await expect(tool(['text', 'video']).execute({ source: file }, exec))
      .rejects.toThrow(/unsupported video extension/)
  })

  it('refuses a model that does not accept video', async () => {
    const file = await writeVideo()
    const { exec } = execution('kimi-code', 'k3-256k')
    await expect(tool(['text', 'image']).execute({ source: file }, exec))
      .rejects.toThrow(/does not accept video/)
  })

  it('refuses when another provider serves the session', async () => {
    // A video block is this plugin's own content extension; another adapter has
    // no case for it, so the tool must not inject one.
    const file = await writeVideo()
    const { exec } = execution('codex-chatgpt')
    await expect(tool(['text', 'image', 'video']).execute({ source: file }, exec))
      .rejects.toThrow(/only wired for the kimi-code provider/)
  })

  it('refuses a private-address URL before fetching it', async () => {
    // Without the address policy this tool would be an SSRF primitive.
    const fetchFn = vi.fn()
    const { exec } = execution()
    await expect(tool(['text', 'video'], fetchFn).execute({ source: 'http://127.0.0.1/video.mp4' }, exec))
      .rejects.toThrow(/not a public IP/)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
