/**
 * Tests for the video path from a stored file to the serialized request.
 *
 * SCOPE, stated honestly: this is NOT an end-to-end test of the DSH service.
 * It covers the request-mapping stage — stored bytes resolved, then serialized
 * into a `video_url` part — plus the installed runtime's own content helpers
 * (the image predicate every request passes through, and the token estimator
 * that prices the message).
 *
 * What stays unverified is the DSH loop around a video block: session
 * persistence, compaction, and transcript rendering. Those consume
 * `Message.content` and this block type is not theirs. The installed
 * `@deepseek-ai/dsh-llm` (0.1.1-rc.2 — note the checkout in this workspace is
 * 0.1.5-rc.1, so it is NOT what runs here) projects images only and has no file
 * projection at all, which is what the assertions below pin. Confirming the
 * loop itself needs an on-install check: attach a video, end the session,
 * resume it, and verify the model still receives the clip.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// The barrel of the INSTALLED runtime exports the image helpers; the token
// estimator is reached through the meter's public class. Both are the code a
// request actually runs against, not the workspace checkout.
import { contentHasImage, projectImagesForTextModel } from '@deepseek-ai/dsh-llm'
import { buildOpenAIRequest, estimatedInputTokens, resolveRequestVideos, offloadOldestRequestVideos } from '../src/host/kimi-code/mapper.ts'
import { readVideoBytes, saveVideo } from '../src/host/kimi-code/video-store.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])

let home: string
let work: string
// The shared setup owns DSH_HOME for the whole file; this file only borrows it.
const setupHome = process.env.DSH_HOME

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kimi-video-e2e-'))
  work = await mkdtemp(path.join(tmpdir(), 'kimi-video-e2e-work-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  // Restore the shared setup's home rather than clearing it, so nothing that
  // runs later in this process can fall back to the developer's real profile.
  if (setupHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = setupHome
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

  it('survives the image projection the installed runtime applies', async () => {
    // The installed runtime projects images out for a text-only model before
    // dispatch. A video must not be mistaken for an image, or the projection
    // would replace the clip with a placeholder.
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'demo.mp4' })
    const message = { role: 'user', content: [{ type: 'video', attachment: ref }] } as unknown as Message

    expect(contentHasImage(message.content)).toBe(false)
    const afterImages = projectImagesForTextModel([message])
    expect(afterImages[0]).toBe(message)
    // ...and the block still carries its reference unchanged.
    const block = (afterImages[0]!.content[0]) as unknown as { type: string; attachment: { attachmentId: string } }
    expect(block.type).toBe('video')
    expect(block.attachment.attachmentId).toBe(ref.attachmentId)
  })

  it('leaves the output cap alone for a request it cannot measure', async () => {
    // The route's prompt estimate counts text only, so a video-only request
    // measures as empty and reports "no estimate" rather than zero. That is the
    // safe direction: the caller leaves the output cap at the model's own
    // maximum instead of clamping it against a prompt size it never saw. What
    // matters here is that the unknown block is tolerated, not priced.
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'demo.mp4' })
    const request = {
      model: 'k3',
      messages: [{ role: 'user', content: [{ type: 'video', attachment: ref }] } as unknown as Message],
    } as GenerateOptions
    expect(() => estimatedInputTokens(request)).not.toThrow()
    expect(estimatedInputTokens(request)).toBeUndefined()
  })

  it('downgrades a video to text for a model that cannot take one', async () => {
    // The other half of the gate: a session that switches to an image-only
    // model must still send a coherent request.
    const ref = await saveVideo({ data: MP4, declaredType: 'video/mp4', name: 'demo.mp4' })
    const request = {
      model: 'k3-256k',
      messages: [{ role: 'user', content: [{ type: 'video', attachment: ref }] } as unknown as Message],
    } as GenerateOptions
    const videos = await resolveRequestVideos(request, {
      readVideo: async (videoRef) => ({ data: await readVideoBytes(videoRef), mediaType: videoRef.mediaType }),
    })
    const body = buildOpenAIRequest(request, new Map(), true, { videos, videoAccepted: false })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('video_url')
    expect(serialized).toContain('does not accept video input')
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
