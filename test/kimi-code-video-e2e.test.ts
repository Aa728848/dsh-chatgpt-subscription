/**
 * End-to-end test for the video path: the tool ingests a file, and the block it
 * injects must survive request assembly to reach the wire.
 *
 * The pieces were each tested in isolation, but the risk they share lives in
 * the seam: DSH's request pipeline projects images and files, and this block is
 * neither, so it has to pass through untouched for the feature to work at all.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOpenAIRequest, resolveRequestVideos, offloadOldestRequestVideos } from '../src/host/kimi-code/mapper.ts'
import { readVideoBytes, saveVideo } from '../src/host/kimi-code/video-store.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])

let home: string
let work: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kimi-video-e2e-'))
  work = await mkdtemp(path.join(tmpdir(), 'kimi-video-e2e-work-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

describe('video reaches the wire from a stored file', () => {
  it('resolves stored bytes and serializes a video_url part', async () => {
    const file = path.join(work, 'demo.mp4')
    await writeFile(file, MP4)
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'demo.mp4' })

    // Exactly the message the tool injects via deferContext.
    const messages = [{
      role: 'user',
      content: [{ type: 'video', attachment: ref }],
    } as unknown as Message]
    const request = { model: 'k3', messages } as GenerateOptions

    // The adapter's reader seam, backed by the same store the tool wrote to.
    const videos = await resolveRequestVideos(request, {
      readVideo: async (videoRef) => ({ data: await readVideoBytes(videoRef), mediaType: videoRef.mediaType }),
    })
    expect(videos.get(ref.attachmentId)?.kind).toBe('inline')

    const body = buildOpenAIRequest(request, new Map(), true, { videos, videoAccepted: true })
    const serialized = JSON.stringify(body)
    expect(serialized).toContain('"video_url"')
    expect(serialized).toContain('data:video/mp4;base64,')
    // The base64 must be the file's bytes, not a placeholder.
    expect(serialized).toContain(Buffer.from(MP4).toString('base64'))
  })

  it('degrades to readable text when the stored bytes are gone', async () => {
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'demo.mp4' })
    const messages = [{ role: 'user', content: [{ type: 'video', attachment: ref }] } as unknown as Message]
    const request = { model: 'k3', messages } as GenerateOptions
    const videos = await resolveRequestVideos(request, {
      readVideo: async () => { throw new Error('gone') },
    })
    const body = buildOpenAIRequest(request, new Map(), true, { videos, videoAccepted: true })
    const parts = (body.messages as Array<Record<string, unknown>>)[0]?.content
    expect(typeof parts).toBe('string')
    expect(String(parts)).toContain('could not be read')
  })

  it('leaves a video-free request untouched', async () => {
    const request = {
      model: 'k3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as Message],
    } as GenerateOptions
    const bounded = offloadOldestRequestVideos(request)
    expect(bounded).toBe(request)
    expect((await resolveRequestVideos(request, undefined)).size).toBe(0)
  })
})
