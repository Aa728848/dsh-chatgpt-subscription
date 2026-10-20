// @vitest-environment node
/**
 * Tests for the two MiniMax Code video tools.
 *
 * No request leaves this process: every one is a mock fetch. What is pinned
 * here is the contract the client and the user depend on - the two paths
 * through video understanding, the whole submit/poll/download/write chain of
 * generation, the workspace path the file lands at, the meta field names the
 * card reads, and the route gate.
 */
import fsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_INLINE_VIDEO_BYTES,
  MAX_REFERENCE_AUDIOS,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_MEDIA_TOTAL,
  MAX_REFERENCE_VIDEOS,
  MAX_UPLOAD_VIDEO_BYTES,
  MINIMAX_CDN_HOST,
  MINIMAX_GENERATE_VIDEO_TOOL_NAME,
  MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS,
  MINIMAX_UNDERSTAND_VIDEO_TOOL_NAME,
  MINIMAX_UPLOAD_CATEGORY,
  MINIMAX_VIDEO_MODEL_RULES,
  createMinimaxGenerateVideoTool,
  createMinimaxUnderstandVideoTool,
  assertVideoDuration,
  assertVideoModel,
  assertVideoResolution,
  declaresNoVideoViewed,
  inlineSourceBytes,
  inlineVideoByteBudget,
  minimaxModelSupportsReferenceMedia,
  prepareAudioInput,
  prepareGenerationMedia,
  prepareImageInput,
  prepareVideoInput,
  reconcileReferenceVideoDurationSeconds,
  sniffVideoContainer,
} from '../src/host/minimax-code/video-tool.ts'
import { readIsoBmffDurationSeconds } from '../src/host/minimax-code/iso-bmff-duration.ts'
import { MAX_GENERATED_VIDEO_BYTES, GENERATED_VIDEO_DIR } from '../src/host/minimax-code/media-store.ts'
import { DEFAULT_MAX_MESSAGE_BODY_BYTES } from '../src/host/minimax-code/types.ts'

/**
 * A clip with a real ISO BMFF header.
 *
 * The head is the one the probes measured coming back from a live CDN -
 * `000000206674797069736f6d` ("ftypisom", docs/minimax-video-upload-probe.md
 * section 1) - so the container sniff accepts it for the reason it exists.
 */
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
])

/** A WebM/Matroska file: EBML magic, then filler. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84])

/** An AVI file: a RIFF container whose form type is 'AVI '. */
const AVI = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x41, 0x56, 0x49, 0x20, 0x4c, 0x49, 0x53, 0x54,
])

/** An MPEG program stream: the pack header start code. */
const MPEG_PS = new Uint8Array([0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x03])

/**
 * The bytes from the fatal case: 1 MiB of `0x11`.
 *
 * This is MEASURED input, not a hypothetical. Sending exactly this to
 * videos_understand came back `success: true` with a detailed description of a
 * tabby cat (docs/minimax-video-free-checks.md section 4.4): no decoder can read
 * a picture out of it.
 */
function fillerBytes(size = 1024 * 1024): Uint8Array {
  return new Uint8Array(size).fill(0x11)
}

/** One recorded fetch call. */
interface Recorded {
  url: string
  init: RequestInit | undefined
}

/** A queue-driven mock fetch: each call consumes the next planned answer. */
function queuedFetch(plan: Array<{ status: number; body: unknown; headers?: Record<string, string> }>): {
  fetchFn: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const queue = [...plan]
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    if (next === undefined) throw new Error('mock fetch ran out of planned answers for ' + String(url))
    // A media download answers BYTES; every JSON answer is a string or an object.
    const payload: BodyInit = next.body instanceof Uint8Array
      ? next.body
      : typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(payload, {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

/**
 * A MiniMax-CDN clip URL, the only host the `url` key is measured to accept.
 *
 * Carried as a constant because almost every understand test needs a URL that
 * reaches the service: after the third-party gate, `https://cdn.example.com/...`
 * is refused locally and would turn a transport assertion into a URL assertion.
 */
const CDN_CLIP = 'https://' + MINIMAX_CDN_HOST + '/cdn-yingshi-ai-com/mcp/u1/general/1_2.mp4'

/**
 * A videos_understand answer in the measured shape (probe §3.2, U3).
 *
 * `source` defaults to the inline receipt for the bytes of {@link MP4}, which is
 * what a healthy inline answer carries. It matters: a count that DISAGREES with
 * what was sent is now a failure of its own, so a fixture hardcoding
 * `inline:12865B` would describe the wrong clip every time.
 *
 * A URL source must pass the URL it cites, because the service echoes the URL
 * back rather than a count - passing the default there would look like a zero.
 */
function answered(
  description: string,
  success = true,
  source = 'inline:' + MP4.byteLength + 'B',
): Record<string, unknown> {
  return {
    code: 0,
    message: 'ok',
    results: [{ success, description, error: '', source }],
    base_resp: { status_code: 0, status_msg: 'success' },
  }
}

/* ------------------------------------------------------------------------- *
 * Generation media: the first/last frame, the reference collections, and the
 * container-read reference-video length.
 *
 * EVERY ONE OF THESE RUNS WITHOUT A REAL REQUEST. The upload channel is the same
 * mock-fetch sequence the understanding tests use, so what is pinned here is the
 * payload SHAPE and the order of the refusal checks, not the network.
 * ------------------------------------------------------------------------- */

/**
 * Build one ISO BMFF box: a 32-bit size, a four-letter type, then the payload.
 *
 * Constructing the containers by hand is what makes the reader arithmetic
 * checkable - a real clip would only tell us the number it happened to contain.
 */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = Uint8Array.from(payload.flatMap(part => Array.from(part)))
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, 8 + body.byteLength)
  for (let index = 0; index < 4; index += 1) head[4 + index] = type.charCodeAt(index)
  return Uint8Array.from([...head, ...body])
}

/**
 * An mvhd payload.
 *
 * The offsets the reader reads are the ones this builder writes, and they are
 * the ones the format defines: version 0 puts a 32-bit timescale at payload
 * offset 12 and the 32-bit duration at 16; version 1 moves them to 20 and 24,
 * with the duration 64 bits wide. Everything before them (version+flags,
 * creation and modification times) is zero here and ignored by the reader; every
 * field after the duration (rate, volume, the matrix, the next track id) is
 * deliberately absent - a reader that needed it would be doing more than
 * reading a length.
 */
function mvhd(version: 0 | 1, timescale: number, duration: number): Uint8Array {
  if (version === 0) {
    // 4 version+flags, 4 creation time, 4 modification time, then timescale at
    // 12 and duration at 16 - the offsets the reader must find them at.
    const payload = new Uint8Array(20)
    const view = new DataView(payload.buffer)
    view.setUint32(12, timescale)
    view.setUint32(16, duration)
    return payload
  }
  // Version 1 widens both times to 64 bits, so the timescale moves to 20 and the
  // 64-bit duration to 24.
  const payload = new Uint8Array(32)
  const view = new DataView(payload.buffer)
  payload[0] = 0x01
  view.setUint32(20, timescale)
  view.setBigUint64(24, BigInt(duration))
  return payload
}

/** A plausible ftyp payload (brand "isom", minor version 0x200, compatible "mp42"). */
const FTYP_PAYLOAD = new Uint8Array([
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x6d, 0x70, 0x34, 0x32,
])

/** A moov holding one version 0 mvhd of 5 seconds at timescale 1000. */
function moovV0(timescale: number, duration: number): Uint8Array {
  return box('moov', box('mvhd', mvhd(0, timescale, duration)))
}

/** A moov holding one version 1 mvhd, whose fields are 64 bits wide. */
function moovV1(timescale: number, duration: number): Uint8Array {
  return box('moov', box('mvhd', mvhd(1, timescale, duration)))
}

/** Media data filler. Its CONTENT is irrelevant; only its declared size matters. */
function mdat(size: number): Uint8Array {
  return box('mdat', new Uint8Array(size))
}

/** Write one byte sequence into the temp workspace and return its absolute path. */
async function writeMedia(name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(work, name)
  await writeFile(file, bytes)
  return file
}

/** The JSON body of one recorded call. */
function uploadBodyOf(call: Recorded | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body)) as Record<string, unknown>
}

/** The credential the standalone prepare calls present. */
const CREDENTIAL = { accessToken: 'tok-abc', region: 'cn' as const }

/** The context every standalone prepare call needs. */
function mediaContext(overrides: {
  model?: 'MiniMax-H3' | 'MiniMax-H3-Max' | 'MiniMax-Hailuo-2.3'
  fetchFn: typeof fetch
}): {
  credential: typeof CREDENTIAL
  fetchFn: typeof fetch
  sleepFn: (ms: number) => Promise<void>
  backoffMs: number
  model?: 'MiniMax-H3' | 'MiniMax-H3-Max' | 'MiniMax-Hailuo-2.3'
} {
  return {
    credential: CREDENTIAL,
    fetchFn: overrides.fetchFn,
    sleepFn: async () => undefined,
    backoffMs: 0,
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
  }
}

/** A broker answer granting a presigned PUT and a citable cdn_url. */
function uploadGranted(name: string, mimeType: string): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      code: 0,
      put_url: 'https://upload.example.com/put/' + name,
      cdn_url: 'https://' + MINIMAX_CDN_HOST + '/tmp/' + name,
      content_type: mimeType,
      expires_in: 600,
      base_resp: { status_code: 0 },
    },
  }
}

/** The two calls one successful local upload costs. */
function uploadPair(name: string, mimeType: string): Array<{ status: number; body: unknown }> {
  return [uploadGranted(name, mimeType), { status: 200, body: '' }]
}

/** Run a promise expected to fail, and hand back the HarnessError it threw. */
async function refusalOf(promise: Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  return promise.then(() => undefined, (error: { code?: string; message?: string }) => error)
}

describe('readIsoBmffDurationSeconds', () => {
  it('reads a version 0 mvhd: duration divided by timescale', async () => {
    // 5000 / 1000 = 5 s.
    const file = await writeMedia('v0.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV0(1000, 5000)]))
    expect(await readIsoBmffDurationSeconds(file)).toBe(5)
  })

  it('reads a version 1 mvhd, whose timescale and duration are 64 bits wide', async () => {
    // 7200 / 600 = 12 s. Read with version 0 offsets this payload would yield a
    // different number, which is why the version byte is checked, not assumed.
    const file = await writeMedia('v1.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV1(600, 7200)]))
    expect(await readIsoBmffDurationSeconds(file)).toBe(12)
  })

  it('finds the moov when it comes FIRST (faststart layout)', async () => {
    const file = await writeMedia('faststart.mp4', Uint8Array.from([
      ...box('ftyp', FTYP_PAYLOAD),
      ...moovV0(1000, 4000),
      ...mdat(4096),
    ]))
    expect(await readIsoBmffDurationSeconds(file)).toBe(4)
  })

  it('finds the moov when it comes LAST, after the media data (ordinary layout)', async () => {
    // The layout that breaks a naive "read the head" reader: the mvhd sits past a
    // 64 KiB mdat, so the seek is the whole point of the implementation.
    const file = await writeMedia('moov-last.mp4', Uint8Array.from([
      ...box('ftyp', FTYP_PAYLOAD),
      ...mdat(64 * 1024),
      ...moovV0(90000, 900000),
    ]))
    expect(await readIsoBmffDurationSeconds(file)).toBe(10)
  })

  it('skips a trak inside the moov rather than assuming mvhd comes first', async () => {
    const file = await writeMedia('trak-first.mp4', Uint8Array.from([
      ...box('ftyp', FTYP_PAYLOAD),
      ...box('moov', box('trak', new Uint8Array(200)), box('mvhd', mvhd(0, 100, 250))),
    ]))
    expect(await readIsoBmffDurationSeconds(file)).toBe(2.5)
  })

  it('refuses a file that is not ISO BMFF at all, instead of returning undefined', async () => {
    // A WebM head: a real video, but no boxes anywhere in it.
    const file = await writeMedia('clip.webm', WEBM)
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_NOT_ISO_BMFF')
    expect(failure?.message).toContain('not an ISO BMFF')
  })

  it('refuses bytes that merely happen to start with a plausible size', async () => {
    const file = await writeMedia('notes.mp4', new Uint8Array([0, 0, 0, 8, 0x68, 0x65, 0x6c, 0x6c]))
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_NOT_ISO_BMFF')
    expect(failure?.message).toContain('"hell"')
  })

  it('refuses a container with no moov box', async () => {
    const file = await writeMedia('no-moov.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...mdat(64)]))
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_DURATION_UNREADABLE')
    expect(failure?.message).toContain('no moov box')
  })

  it('refuses a moov with no mvhd child', async () => {
    const file = await writeMedia('no-mvhd.mp4', Uint8Array.from([
      ...box('ftyp', FTYP_PAYLOAD),
      ...box('moov', box('trak', new Uint8Array(16))),
    ]))
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_DURATION_UNREADABLE')
    expect(failure?.message).toContain('no mvhd child')
  })

  it('refuses an mvhd whose timescale is zero, which has no seconds to answer with', async () => {
    const file = await writeMedia('zero-timescale.mp4', Uint8Array.from([
      ...box('ftyp', FTYP_PAYLOAD),
      ...box('moov', box('mvhd', mvhd(0, 0, 5000))),
    ]))
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_DURATION_UNREADABLE')
    expect(failure?.message).toContain('timescale of 0')
  })

  it('refuses a truncated container rather than walking past the end', async () => {
    const complete = Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV0(1000, 5000)])
    const file = await writeMedia('truncated.mp4', complete.subarray(0, complete.byteLength - 8))
    const failure = await refusalOf(readIsoBmffDurationSeconds(file))
    expect(failure?.code).toBe('MINIMAX_VIDEO_NOT_ISO_BMFF')
    expect(failure?.message).toContain('truncated')
  })

  it('refuses a missing file instead of reporting a duration of NaN', async () => {
    const failure = await refusalOf(readIsoBmffDurationSeconds(path.join(work, 'does-not-exist.mp4')))
    expect(failure?.code).toBe('MINIMAX_VIDEO_MEDIA_NOT_FOUND')
  })
})

describe('prepareImageInput / prepareVideoInput / prepareAudioInput', () => {
  it('uploads a local image and cites the cdn_url, sending the measured upload body', async () => {
    const file = await writeMedia('frame.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const { fetchFn, calls } = queuedFetch(uploadPair('frame.png', 'image/png'))
    const payload = await prepareImageInput(file, 'inputImagePath', mediaContext({ fetchFn }))

    expect(payload).toEqual({
      url: 'https://' + MINIMAX_CDN_HOST + '/tmp/frame.png',
      mime_type: 'image/png',
    })
    expect(uploadBodyOf(calls[0])).toEqual({
      filename: 'frame.png',
      mime_type: 'image/png',
      size_bytes: 4,
      category: MINIMAX_UPLOAD_CATEGORY,
    })
    // The bytes go to put_url; the cdn_url is only ever CITED.
    expect(calls[1]?.url).toBe('https://upload.example.com/put/frame.png')
    expect(calls[2]).toBeUndefined()
  })

  it('uploads a local audio file with its own media type', async () => {
    const file = await writeMedia('voice.mp3', new Uint8Array([0x49, 0x44, 0x33]))
    const { fetchFn, calls } = queuedFetch(uploadPair('voice.mp3', 'audio/mpeg'))
    const payload = await prepareAudioInput(file, 'referenceAudioPaths[0]', mediaContext({ fetchFn }))
    expect(payload.mime_type).toBe('audio/mpeg')
    expect(uploadBodyOf(calls[0]).mime_type).toBe('audio/mpeg')
  })

  it('passes a MiniMax CDN URL through WITHOUT sending an upload request', async () => {
    const url = 'https://' + MINIMAX_CDN_HOST + '/tmp/already-there.png'
    const { fetchFn, calls } = queuedFetch([])
    const payload = await prepareImageInput(url, 'referenceImagePaths[0]', mediaContext({ fetchFn }))
    expect(payload).toEqual({ url, mime_type: 'image/png' })
    // Not one request: the URL is already somewhere the service can read.
    expect(calls).toHaveLength(0)
  })

  it('keeps a cdn URL exactly as given, query string and all', async () => {
    // Only the EXTENSION is read from the path; the cited URL is not rewritten.
    const url = 'https://' + MINIMAX_CDN_HOST + '/tmp/x.mp4?x-oss-signature=abc'
    const { fetchFn, calls } = queuedFetch([])
    const payload = await prepareVideoInput(url, 'referenceVideoPaths[0]', 4, mediaContext({ fetchFn }))
    expect(payload.url).toBe(url)
    expect(payload.duration_seconds).toBe(4)
    expect(calls).toHaveLength(0)
  })

  it('refuses a third-party public URL locally, naming the argument and sending nothing', async () => {
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareImageInput('https://example.com/cat.png', 'lastFrameImagePath', mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN')
    // The ARGUMENT is named: thirteen media arguments could be the one.
    expect(failure?.message).toContain('lastFrameImagePath')
    expect(calls).toHaveLength(0)
  })

  it('refuses an extension outside the image whitelist, without a single request', async () => {
    const file = await writeMedia('frame.gif', new Uint8Array([0x47, 0x49, 0x46]))
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareImageInput(file, 'inputImagePath', mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_MEDIA_TYPE_UNSUPPORTED')
    expect(failure?.message).toContain('.gif')
    expect(failure?.message).toContain('inputImagePath')
    expect(calls).toHaveLength(0)
  })

  it('refuses a .mkv reference video: a video, but not one of the two extensions this route sends', async () => {
    const file = await writeMedia('clip.mkv', new Uint8Array(16))
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareVideoInput(file, 'referenceVideoPaths[0]', undefined, mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_MEDIA_TYPE_UNSUPPORTED')
    expect(failure?.message).toContain('.mp4 .mov')
    expect(calls).toHaveLength(0)
  })

  it('refuses an image above 30 MiB after the stat and before reading it', async () => {
    const file = path.join(work, 'huge.png')
    await writeFile(file, Buffer.alloc(0))
    await truncate(file, 30 * 1024 * 1024 + 1)
    const readSpy = vi.spyOn(fsPromises, 'readFile')
    try {
      const { fetchFn, calls } = queuedFetch([])
      const failure = await refusalOf(prepareImageInput(file, 'inputImagePath', mediaContext({ fetchFn })))
      expect(failure?.code).toBe('MINIMAX_VIDEO_MEDIA_TOO_LARGE')
      expect(failure?.message).toContain('30.0 MB')
      expect(readSpy).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('applies each kind its own ceiling: 50 MiB for a video, 15 MiB for audio', async () => {
    const video = path.join(work, 'big.mp4')
    await writeFile(video, Buffer.alloc(0))
    await truncate(video, 50 * 1024 * 1024 + 1)
    const audio = path.join(work, 'big.wav')
    await writeFile(audio, Buffer.alloc(0))
    await truncate(audio, 15 * 1024 * 1024 + 1)

    const { fetchFn, calls } = queuedFetch([])
    const videoFailure = await refusalOf(prepareVideoInput(video, 'referenceVideoPaths[0]', undefined, mediaContext({ fetchFn })))
    const audioFailure = await refusalOf(prepareAudioInput(audio, 'referenceAudioPaths[0]', mediaContext({ fetchFn })))
    expect(videoFailure?.code).toBe('MINIMAX_VIDEO_MEDIA_TOO_LARGE')
    expect(videoFailure?.message).toContain('50.0 MB')
    expect(audioFailure?.code).toBe('MINIMAX_VIDEO_MEDIA_TOO_LARGE')
    expect(audioFailure?.message).toContain('15.0 MB')
    expect(calls).toHaveLength(0)
  })
})

describe('reference video durations', () => {
  it('reads a local reference video length out of the container, with no argument from the caller', async () => {
    const file = await writeMedia('reference.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV0(1000, 7000)]))
    const { fetchFn, calls } = queuedFetch(uploadPair('reference.mp4', 'video/mp4'))
    const payload = await prepareVideoInput(file, 'referenceVideoPaths[0]', undefined, mediaContext({ fetchFn }))
    expect(payload.duration_seconds).toBe(7)
    expect(calls).toHaveLength(2)
  })

  it('refuses a public reference video with no stated length, because a URL cannot be measured', async () => {
    const url = 'https://' + MINIMAX_CDN_HOST + '/tmp/ref.mp4'
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareVideoInput(url, 'referenceVideoPaths[1]', undefined, mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCE_DURATION_REQUIRED')
    expect(failure?.message).toContain('referenceVideoDurationSeconds')
    expect(calls).toHaveLength(0)
  })

  it('lets the caller override the measured length when the two agree within a second', async () => {
    const file = await writeMedia('trimmed.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV0(1000, 10000)]))
    const { fetchFn } = queuedFetch(uploadPair('trimmed.mp4', 'video/mp4'))
    const payload = await prepareVideoInput(file, 'referenceVideoPaths[0]', 10.4, mediaContext({ fetchFn }))
    // The caller number is what travels, not the container one.
    expect(payload.duration_seconds).toBe(10.4)
    expect(reconcileReferenceVideoDurationSeconds('x', 10, 10.9)).toBe(10.9)
    expect(MINIMAX_REFERENCE_DURATION_TOLERANCE_SECONDS).toBe(1)
  })

  it('refuses a stated length that contradicts the container, naming BOTH values', async () => {
    const file = await writeMedia('mismatch.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...moovV0(1000, 12000)]))
    const { fetchFn } = queuedFetch(uploadPair('mismatch.mp4', 'video/mp4'))
    const failure = await refusalOf(prepareVideoInput(file, 'referenceVideoPaths[0]', 5, mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCE_DURATION_MISMATCH')
    // Both numbers, or the caller cannot tell which side is wrong.
    expect(failure?.message).toContain('given as 5 s')
    expect(failure?.message).toContain('says 12 s')
  })

  it('reports a container it cannot measure with the reader own error code, before uploading it', async () => {
    // A real ftyp, then media data and no moov: the length simply is not there.
    // The ORDER is the assertion as much as the code - measuring first means
    // this costs no upload request at all.
    const file = await writeMedia('weird.mp4', Uint8Array.from([...box('ftyp', FTYP_PAYLOAD), ...mdat(32)]))
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareVideoInput(file, 'referenceVideoPaths[0]', undefined, mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_DURATION_UNREADABLE')
    expect(failure?.message).toContain('referenceVideoPaths[0]')
    expect(calls).toHaveLength(0)
  })
})

describe('prepareGenerationMedia', () => {
  it('keys the prepared media by the SERVICE field names, not by the parameter names', async () => {
    // THE FIELD-NAME TABLE FROM THE SPEC, section 0. Four of the five differ, and
    // a body built by destructuring the arguments gets all four wrong.
    const frame = await writeMedia('first.png', new Uint8Array([1, 2, 3]))
    const last = await writeMedia('last.png', new Uint8Array([4, 5, 6]))
    const { fetchFn } = queuedFetch([...uploadPair('first.png', 'image/png'), ...uploadPair('last.png', 'image/png')])
    const media = await prepareGenerationMedia(
      { inputImagePath: frame, lastFrameImagePath: last },
      'MiniMax-H3',
      mediaContext({ fetchFn }),
    )
    expect(Object.keys(media).sort()).toEqual([
      'hasKeyframes', 'hasReferences', 'input_image', 'last_frame_image',
    ])
    expect(media.input_image?.url).toBe('https://' + MINIMAX_CDN_HOST + '/tmp/first.png')
    expect(media.last_frame_image?.url).toBe('https://' + MINIMAX_CDN_HOST + '/tmp/last.png')
    expect(media).not.toHaveProperty('input_image_path')
    expect(media).not.toHaveProperty('last_frame_image_path')
    expect(media.hasKeyframes).toBe(true)
    expect(media.hasReferences).toBe(false)
  })

  it('reports hasReferences for a reference collection, and uploads every item in order', async () => {
    const one = await writeMedia('a.jpg', new Uint8Array([1]))
    const two = await writeMedia('b.jpg', new Uint8Array([2]))
    const { fetchFn, calls } = queuedFetch([...uploadPair('a.jpg', 'image/jpeg'), ...uploadPair('b.jpg', 'image/jpeg')])
    const media = await prepareGenerationMedia(
      { referenceImagePaths: [one, two] },
      'MiniMax-H3',
      mediaContext({ fetchFn }),
    )
    expect(media.reference_images?.map(entry => entry.url)).toEqual([
      'https://' + MINIMAX_CDN_HOST + '/tmp/a.jpg',
      'https://' + MINIMAX_CDN_HOST + '/tmp/b.jpg',
    ])
    expect(media.hasReferences).toBe(true)
    expect(media.hasKeyframes).toBe(false)
    expect(calls.filter(call => call.url.includes('get_upload_url'))).toHaveLength(2)
  })

  it('refuses more than 9 reference images, naming the set and the excess, with nothing sent', async () => {
    const paths = Array.from({ length: MAX_REFERENCE_IMAGES + 3 }, (_value, index) => path.join(work, 'i' + index + '.png'))
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareGenerationMedia({ referenceImagePaths: paths }, 'MiniMax-H3', mediaContext({ fetchFn })))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCE_LIMIT')
    expect(failure?.message).toContain('12 reference image(s)')
    expect(failure?.message).toContain('3 over the limit of 9')
    expect(calls).toHaveLength(0)
  })

  it('refuses more than 3 reference videos and more than 3 reference audios', async () => {
    const videos = Array.from({ length: MAX_REFERENCE_VIDEOS + 1 }, (_v, i) => 'https://' + MINIMAX_CDN_HOST + '/v' + i + '.mp4')
    const audios = Array.from({ length: MAX_REFERENCE_AUDIOS + 2 }, (_v, i) => 'https://' + MINIMAX_CDN_HOST + '/a' + i + '.mp3')
    const { fetchFn, calls } = queuedFetch([])
    const videoFailure = await refusalOf(prepareGenerationMedia({ referenceVideoPaths: videos }, 'MiniMax-H3', mediaContext({ fetchFn })))
    expect(videoFailure?.message).toContain('4 reference video(s)')
    expect(videoFailure?.message).toContain('1 over the limit of 3')

    const audioFailure = await refusalOf(prepareGenerationMedia({ referenceAudioPaths: audios }, 'MiniMax-H3', mediaContext({ fetchFn })))
    expect(audioFailure?.message).toContain('5 reference audio(s)')
    expect(audioFailure?.message).toContain('2 over the limit of 3')
    expect(calls).toHaveLength(0)
  })

  it('refuses more than 12 media items in TOTAL even when each set is inside its own limit', async () => {
    // 9 images + 3 videos + 1 audio = 13: every set is legal, the total is not.
    const images = Array.from({ length: MAX_REFERENCE_IMAGES }, (_v, i) => 'https://' + MINIMAX_CDN_HOST + '/i' + i + '.png')
    const videos = Array.from({ length: MAX_REFERENCE_VIDEOS }, (_v, i) => 'https://' + MINIMAX_CDN_HOST + '/v' + i + '.mp4')
    const audios = ['https://' + MINIMAX_CDN_HOST + '/a0.mp3']
    expect(images.length + videos.length + audios.length).toBe(MAX_REFERENCE_MEDIA_TOTAL + 1)
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareGenerationMedia(
      {
        referenceImagePaths: images,
        referenceVideoPaths: videos,
        referenceVideoDurationSeconds: [4, 4, 4],
        referenceAudioPaths: audios,
      },
      'MiniMax-H3',
      mediaContext({ fetchFn }),
    ))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCE_LIMIT')
    expect(failure?.message).toContain('13 reference media item(s)')
    expect(failure?.message).toContain('1 over the combined limit of 12')
    expect(calls).toHaveLength(0)
  })

  it('refuses a duration array whose length does not match the video list', async () => {
    const videos = ['https://' + MINIMAX_CDN_HOST + '/v0.mp4', 'https://' + MINIMAX_CDN_HOST + '/v1.mp4']
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareGenerationMedia(
      { referenceVideoPaths: videos, referenceVideoDurationSeconds: [4] },
      'MiniMax-H3',
      mediaContext({ fetchFn }),
    ))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCE_DURATION_INVALID')
    expect(failure?.message).toContain('POSITION')
    expect(calls).toHaveLength(0)
  })

  it('refuses reference media on MiniMax-Hailuo-2.3, naming the arguments to drop', async () => {
    expect(minimaxModelSupportsReferenceMedia('MiniMax-H3')).toBe(true)
    expect(minimaxModelSupportsReferenceMedia('MiniMax-H3-Max')).toBe(true)
    expect(minimaxModelSupportsReferenceMedia('MiniMax-Hailuo-2.3')).toBe(false)
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareGenerationMedia(
      { referenceImagePaths: ['https://' + MINIMAX_CDN_HOST + '/x.png'] },
      'MiniMax-Hailuo-2.3',
      mediaContext({ fetchFn }),
    ))
    expect(failure?.code).toBe('MINIMAX_VIDEO_REFERENCES_UNSUPPORTED')
    expect(failure?.message).toContain('referenceImagePaths')
    expect(failure?.message).toContain('1 reference image(s)')
    expect(calls).toHaveLength(0)
  })

  it('refuses a last frame on Hailuo, which supports first_frame and the legacy subject type only', async () => {
    const { fetchFn, calls } = queuedFetch([])
    const failure = await refusalOf(prepareGenerationMedia(
      {
        inputImagePath: 'https://' + MINIMAX_CDN_HOST + '/a.png',
        lastFrameImagePath: 'https://' + MINIMAX_CDN_HOST + '/b.png',
      },
      'MiniMax-Hailuo-2.3',
      mediaContext({ fetchFn }),
    ))
    expect(failure?.code).toBe('MINIMAX_VIDEO_LAST_FRAME_UNSUPPORTED')
    expect(failure?.message).toContain('lastFrameImagePath')
    expect(calls).toHaveLength(0)
  })

  it('allows a Hailuo first frame, which is the one media argument that model takes', async () => {
    const { fetchFn, calls } = queuedFetch([])
    const media = await prepareGenerationMedia(
      { inputImagePath: 'https://' + MINIMAX_CDN_HOST + '/a.jpg' },
      'MiniMax-Hailuo-2.3',
      mediaContext({ fetchFn }),
    )
    expect(media.input_image?.url).toBe('https://' + MINIMAX_CDN_HOST + '/a.jpg')
    expect(media.hasKeyframes).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('narrows the image extension set for Hailuo and keeps the wider set for H3', async () => {
    // .heic is legal for the route and NOT for Hailuo (spec section 2.3).
    const haultoFailure = await refusalOf(prepareGenerationMedia(
      { inputImagePath: 'https://' + MINIMAX_CDN_HOST + '/a.heic' },
      'MiniMax-Hailuo-2.3',
      mediaContext({ fetchFn: queuedFetch([]).fetchFn, model: 'MiniMax-Hailuo-2.3' }),
    ))
    expect(haultoFailure?.message).toContain('NARROWER set')

    const h3 = await prepareGenerationMedia(
      { inputImagePath: 'https://' + MINIMAX_CDN_HOST + '/a.heic' },
      'MiniMax-H3',
      mediaContext({ fetchFn: queuedFetch([]).fetchFn }),
    )
    expect(h3.input_image?.mime_type).toBe('image/heic')
  })

  it('returns no media keys at all for a plain text-to-video call', async () => {
    const { fetchFn, calls } = queuedFetch([])
    const media = await prepareGenerationMedia({}, 'MiniMax-H3', mediaContext({ fetchFn }))
    expect(media).toEqual({ hasKeyframes: false, hasReferences: false })
    expect(calls).toHaveLength(0)
  })
})

let work: string

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'minimax-video-'))
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

/** A context whose working-directory service answers the temp workspace. */
function context(root: string | undefined = work, serviceAvailable = true) {
  return {
    get: (name: string) => (name === 'workingDirectory' && serviceAvailable && root !== undefined
      ? { ensure: async () => root }
      : undefined),
  }
}

/** One execution, routed to the provider named. */
function execution(provider = 'minimax-code', headerCwd: string | undefined = undefined) {
  return {
    signal: undefined as AbortSignal | undefined,
    callId: 'call-1',
    agent: {
      session: {
        requestHeader: () => ({ config: { provider, model: 'MiniMax-M3' } }),
        ...(headerCwd === undefined ? {} : { header: { cwd: headerCwd } }),
      },
      options: {},
    },
  }
}

/** The pool stub: one account, one region. */
function pool(region: 'cn' | 'global' = 'cn') {
  return {
    getFreshCredential: vi.fn(async () => ({ accessToken: 'tok-abc', region })),
  }
}

type Executable = {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
  name: string
  output: { presentationMeta?: (args: unknown, value: unknown) => unknown }
}

function understandTool(fetchFn: typeof fetch, ctx: unknown = context(), poolStub = pool()): Executable {
  return createMinimaxUnderstandVideoTool(ctx as never, { fetchFn, pool: poolStub }) as never as Executable
}

function generateTool(
  fetchFn: typeof fetch,
  extra: { ctx?: unknown; pool?: ReturnType<typeof pool>; now?: () => number; budgetMs?: number } = {},
): Executable {
  return createMinimaxGenerateVideoTool(extra.ctx as never ?? context() as never, {
    fetchFn,
    pool: extra.pool ?? pool(),
    pollIntervalMs: 1,
    generationBudgetMs: extra.budgetMs ?? 60_000,
    // The real retry backoff is 1.5 s; a test asserting the retry HAPPENED does
    // not need to spend it.
    retryBackoffMs: 0,
    now: extra.now ?? (() => 1_700_000_000_000),
  }) as never as Executable
}

describe('tool names', () => {
  it('are the two names the design spec fixes', () => {
    expect(MINIMAX_UNDERSTAND_VIDEO_TOOL_NAME).toBe('minimax_understand_video')
    expect(MINIMAX_GENERATE_VIDEO_TOOL_NAME).toBe('minimax_generate_video')
    expect(understandTool(vi.fn() as never).name).toBe('minimax_understand_video')
    expect(generateTool(vi.fn() as never).name).toBe('minimax_generate_video')
  })
})

describe('the provider gate', () => {
  it('refuses video understanding on another provider and names the model to switch to', async () => {
    const { fetchFn, calls } = queuedFetch([])
    const exec = execution('codex-chatgpt')
    await expect(understandTool(fetchFn).execute({ source: 'https://example.com/a.mp4' }, exec))
      .rejects.toThrow(/only wired for the minimax-code provider/)
    // The remedy is part of the contract: a refusal with no way out is a dead end.
    await expect(understandTool(fetchFn).execute({ source: 'https://example.com/a.mp4' }, exec))
      .rejects.toThrow(/Switch this session to a minimax-code model/)
    expect(calls).toHaveLength(0)
  })

  it('refuses video generation on another provider before spending a generation', async () => {
    const { fetchFn, calls } = queuedFetch([])
    await expect(generateTool(fetchFn).execute({ prompt: 'a cat' }, execution('kimi-code')))
      .rejects.toThrow(/only wired for the minimax-code provider/)
    expect(calls).toHaveLength(0)
  })

  it('refuses when the route cannot be resolved at all', async () => {
    const { fetchFn } = queuedFetch([])
    const exec = { signal: undefined, callId: 'c', agent: { session: { requestHeader: () => undefined }, options: {} } }
    await expect(generateTool(fetchFn).execute({ prompt: 'a cat' }, exec))
      .rejects.toThrow(/route could not be resolved/)
  })
})

describe('minimax_understand_video', () => {
  /** Run one understanding call and return the error instead of throwing. */
  async function failureOf(
    args: Record<string, unknown>,
    fetchFn: typeof fetch,
  ): Promise<{ code?: string; message?: string }> {
    return understandTool(fetchFn)
      .execute(args, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
      .then(failure => failure ?? {})
  }

  /** The media entry of the one understand request a call made. */
  function mediaSent(call: Recorded | undefined): Record<string, unknown> {
    const sent = JSON.parse(String(call?.init?.body)) as { video_info: Array<Record<string, unknown>> }
    return sent.video_info[0] ?? {}
  }

  it('sends a local file as base64 under the data key, and nothing else', async () => {
    // PROBE U3, the only form that worked: {video_info:[{data,prompt}]} answered
    // success:true, while file_url (U1) and a signed url (U2) both answered
    // success:false over HTTP 200. This pins the ONE proven form.
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([{
      status: 200, body: answered('这段视频全程为纯黑屏画面'),
    }])
    const result = await understandTool(fetchFn).execute({ source: file }, execution())

    expect(result.analysis).toBe('这段视频全程为纯黑屏画面')
    expect(result.bytes).toBe(MP4.byteLength)
    expect(result.mediaType).toBe('video/mp4')
    // ONE request: the understand call. No upload step exists on this path.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand')

    const media = mediaSent(calls[0])
    expect(media).toEqual({ data: Buffer.from(MP4).toString('base64'), prompt: '描述这个视频的内容' })
    // The three keys that must never appear: file_url was U1's silent failure,
    // url is the key U2 proved cannot read a signed URL, and file names a path
    // on the SERVICE's machine rather than this one.
    expect(media).not.toHaveProperty('file_url')
    expect(media).not.toHaveProperty('url')
    expect(media).not.toHaveProperty('file')
  })

  it('passes a MiniMax CDN URL through under the url key', async () => {
    // The ONE shape measured to work through the url key: the cdn_url this
    // route's own upload returns, on cdn.hailuoai.com (upload probe section 4).
    const cdnUrl = 'https://' + MINIMAX_CDN_HOST + '/cdn-yingshi-ai-com/mcp/u1/general/1_2.mp4'
    const { fetchFn, calls } = queuedFetch([{
      // A URL source echoes the URL back, so there is no inline count to check.
      status: 200, body: answered('a red bicycle leans on a wall', true, cdnUrl),
    }])
    const result = await understandTool(fetchFn).execute(
      { source: cdnUrl, prompt: 'what is shown?' },
      execution(),
    )
    expect(result.analysis).toBe('a red bicycle leans on a wall')
    expect(result.mediaType).toBe('video/mp4')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand')
    expect(mediaSent(calls[0])).toEqual({ url: cdnUrl, prompt: 'what is shown?' })
    expect(mediaSent(calls[0])).not.toHaveProperty('data')
  })

  it('refuses a THIRD-PARTY public URL locally, without sending a request', async () => {
    // MEASURED: two of the three third-party URLs the probe used were confirmed
    // fetchable from this machine (HTTP 206, video/mp4, ftypmp42) and the
    // service refused all three with "video_info.url could not be used as a
    // media source" (docs/minimax-video-free-checks.md sections 5.2-5.3). So a
    // third-party address is refused here rather than spent on a request whose
    // answer is already known.
    const { fetchFn, calls } = queuedFetch([])
    const failure = await failureOf({ source: 'https://cdn.example.com/clip.mp4' }, fetchFn)
    expect(failure.code).toBe('MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN')
    // The message has to carry the remedy and the measured reason.
    expect(failure.message).toContain(MINIMAX_CDN_HOST)
    expect(failure.message).toContain('video_info.url could not be used as a media source')
    expect(failure.message).toContain('local path')
    expect(calls).toHaveLength(0)
  })

  it('exempts the upload path, whose own cdn_url is on the MiniMax CDN host', async () => {
    // The exemption is not a special case in the code: the host this route's
    // upload returns IS the allowed host, which is why transport "upload" never
    // trips the third-party check. Pinned so a future host change is visible.
    const cdnUrl = 'https://' + MINIMAX_CDN_HOST + '/cdn/mcp/u1/general/9_9.mp4'
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([
      {
        status: 200,
        body: {
          code: 0,
          put_url: 'https://upload.example.com/put/abc',
          cdn_url: cdnUrl,
          content_type: 'video/mp4',
          base_resp: { status_code: 0 },
        },
      },
      { status: 200, body: '' },
      { status: 200, body: answered('a hand waves', true, cdnUrl) },
    ])
    const result = await understandTool(fetchFn).execute({ source: file, transport: 'upload' }, execution())
    expect(result.analysis).toBe('a hand waves')
    expect(mediaSent(calls[2])).toEqual({ url: cdnUrl, prompt: '描述这个视频的内容' })
  })

  it('fails when results[0].success is false, carrying the description', async () => {
    // The exact defect: U1 answered HTTP 200 with base_resp.status_code 0 and
    // results[0].success FALSE. Reading only the description reports that
    // refusal as a successful analysis of nothing.
    const { fetchFn } = queuedFetch([{
      status: 200,
      body: {
        code: 0,
        message: 'ok',
        results: [{
          success: false,
          description: 'video_info.url could not be used as a media source',
          error: '',
          source: '',
        }],
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    }])
    const failure = await failureOf({ source: CDN_CLIP }, fetchFn)
    expect(failure.code).toBe('MINIMAX_VIDEO_UNDERSTAND_FAILED')
    expect(failure.message).toContain('video_info.url could not be used as a media source')
  })

  it('carries results[0].error into the failure too', async () => {
    const { fetchFn } = queuedFetch([{
      status: 200,
      body: {
        code: 0,
        message: 'ok',
        results: [{ success: false, description: '', error: 'video_info could not be read or decoded' }],
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    }])
    await expect(understandTool(fetchFn).execute({ source: CDN_CLIP }, execution()))
      .rejects.toThrow(/could not be read or decoded/)
  })

  it('returns results[0].description when success is true', async () => {
    // A URL source echoes the URL, not a byte count.
    const { fetchFn } = queuedFetch([{ status: 200, body: answered('a hand waves', true, CDN_CLIP) }])
    const result = await understandTool(fetchFn).execute({ source: CDN_CLIP }, execution())
    expect(result.analysis).toBe('a hand waves')
  })

  it('reserves a presigned URL with the measured field names and reads put_url and cdn_url', async () => {
    const file = path.join(work, 'clip.webm')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([
      {
        status: 200,
        body: {
          code: 0,
          put_url: 'https://upload.example.com/put/abc?x-oss-signature=1',
          cdn_url: 'https://' + MINIMAX_CDN_HOST + '/tmp/abc.webm',
          oss_key: 'cdn/mcp/u123/general/1_2.bin',
          content_type: 'video/webm',
          expires_in: 600,
          base_resp: { status_code: 0 },
        },
      },
      { status: 200, body: '' },
      { status: 200, body: answered('a hand waves') },
    ])
    const result = await understandTool(fetchFn).execute({ source: file, transport: 'upload' }, execution())
    expect(result.analysis).toBe('a hand waves')
    expect(result.mediaType).toBe('video/webm')

    expect(calls).toHaveLength(3)
    expect(calls[0]?.url).toBe('https://agent.minimax.cn/mavis/api/v1/mcp/get_upload_url')
    // The three field names the service spelled out in its own error (probe
    // §5). file_name / content_type / file_size were wrong on all three.
    //
    // `category` is the FOURTH field, and it is the one this body was missing:
    // upstream's measured upload body carries it and names the temporary bucket
    // the object lands in (docs/minimax-video-extended-spec.md section 2.1). It
    // is asserted by exact equality rather than by `toMatchObject` on purpose -
    // the point is that the body IS the measured shape, not a superset of it.
    const granted = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(granted).toEqual({
      filename: 'clip.webm',
      mime_type: 'video/webm',
      size_bytes: MP4.byteLength,
      category: MINIMAX_UPLOAD_CATEGORY,
    })
    expect(MINIMAX_UPLOAD_CATEGORY).toBe('user_file_upload_tmp')
    expect(granted).not.toHaveProperty('file_name')
    expect(granted).not.toHaveProperty('content_type')
    expect(granted).not.toHaveProperty('file_size')

    // The bytes go to put_url, not to cdn_url - they are different fields.
    expect(calls[1]?.url).toBe('https://upload.example.com/put/abc?x-oss-signature=1')
    expect(calls[1]?.init?.method).toBe('PUT')

    // The understand call cites cdn_url, because put_url is a write target.
    expect(mediaSent(calls[2])).toEqual({
      url: 'https://' + MINIMAX_CDN_HOST + '/tmp/abc.webm',
      prompt: '描述这个视频的内容',
    })
  })

  it('fails explicitly when the broker answers without put_url and cdn_url', async () => {
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([{
      status: 200, body: { code: 0, base_resp: { status_code: 0 }, something_else: 'x' },
    }])
    const failure = await understandTool(fetchFn)
      .execute({ source: file, transport: 'upload' }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_UPLOAD_FAILED')
    // The measured field names are the remedy, so the message names them.
    expect(failure?.message).toContain('put_url')
    expect(failure?.message).toContain('cdn_url')
    // It stops there rather than sending an undefined URL upstream.
    expect(calls).toHaveLength(1)
  })

  it('never attempts an upload by default, because inline is the proven path', async () => {
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([{ status: 200, body: answered('ok') }])
    await understandTool(fetchFn).execute({ source: file }, execution())
    expect(calls.filter(call => call.url.includes('get_upload_url'))).toHaveLength(0)
  })

  it('refuses a file above the inline budget WITHOUT sending anything', async () => {
    // Base64 grows the bytes by 4/3 against the body cap, so an oversized clip
    // must be refused here rather than by an opaque transport error after the
    // bytes were encoded and sent.
    const budget = inlineVideoByteBudget()
    expect(budget).toBe(MAX_INLINE_VIDEO_BYTES)
    const file = path.join(work, 'huge.mp4')
    // A sparse file of the right SIZE: nothing is read, only stat'd.
    await writeFile(file, Buffer.alloc(0))
    await truncate(file, budget + 1)

    const { fetchFn, calls } = queuedFetch([])
    const failure = await understandTool(fetchFn)
      .execute({ source: file }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_TOO_LARGE')
    // The remedy is named, not implied.
    expect(failure?.message).toContain('transport: "upload"')
    expect(calls).toHaveLength(0)
  })

  it('caps the UPLOAD path too, and refuses before a byte is read or a request is sent', async () => {
    // Without this cap the upload path had NO ceiling at all: 2 GB would be
    // read into memory and PUT as one object. The check must land on stats.size
    // - reading the file first and comparing data.byteLength afterwards is the
    // out-of-memory path this test exists to forbid.
    expect(MAX_UPLOAD_VIDEO_BYTES).toBe(MAX_GENERATED_VIDEO_BYTES)
    const file = path.join(work, 'huge-upload.mp4')
    // A sparse file of the right SIZE: nothing is read, only stat'd.
    await writeFile(file, Buffer.alloc(0))
    await truncate(file, MAX_UPLOAD_VIDEO_BYTES + 1)

    const { fetchFn, calls } = queuedFetch([])
    const failure = await understandTool(fetchFn)
      .execute({ source: file, transport: 'upload' }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_TOO_LARGE')
    // get_upload_url is a request too: an oversized file must not even reserve
    // a target, so the call count is the assertion, not just "no PUT".
    expect(calls).toHaveLength(0)
    // The message reports the numbers and that nothing left this process.
    expect(failure?.message).toContain('Nothing was uploaded and no request was made')
    // The numbers are in the sentence: the size, and the cap it broke.
    expect(failure?.message).toMatch(/video is .*above the 200(\.0)? MB this route can upload/)
  })

  it('checks the upload cap after the stat and BEFORE anything is read into memory', async () => {
    // The order is the point, not just the verdict: a `fs.readFile` followed by
    // `data.byteLength > limit` would report the same error having already
    // pulled the whole oversized file into memory - the exact failure this cap
    // exists to prevent. A readFile spy makes that regression visible.
    const file = path.join(work, 'huge-unread.mp4')
    await writeFile(file, Buffer.alloc(0))
    await truncate(file, MAX_UPLOAD_VIDEO_BYTES + 1)
    const readSpy = vi.spyOn(fsPromises, 'readFile')
    try {
      const { fetchFn, calls } = queuedFetch([])
      await expect(understandTool(fetchFn).execute({ source: file, transport: 'upload' }, execution()))
        .rejects.toThrow(/this route can upload/)
      expect(readSpy).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('uploads a file that fits the upload cap, end to end', async () => {
    // The other side of the boundary: a file under the cap must reach all three
    // steps rather than being caught by the new check.
    expect(MP4.byteLength).toBeLessThan(MAX_UPLOAD_VIDEO_BYTES)
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([
      {
        status: 200,
        body: {
          code: 0,
          put_url: 'https://upload.example.com/put/fits',
          cdn_url: 'https://cdn.hailuoai.com/tmp/fits.mp4',
          oss_key: 'cdn/mcp/u123/general/fits.mp4',
          content_type: 'video/mp4',
          expires_in: 600,
          base_resp: { status_code: 0 },
        },
      },
      // A real OSS write answers 200 with an empty body, never 204 - the mock
      // keeps the measured shape so a '=== 204' regression fails here.
      { status: 200, body: '' },
      { status: 200, body: answered('a hand waves') },
    ])
    const result = await understandTool(fetchFn).execute({ source: file, transport: 'upload' }, execution())
    expect(result.analysis).toBe('a hand waves')
    expect(result.bytes).toBe(MP4.byteLength)
    expect(calls).toHaveLength(3)
    expect(calls.map(call => call.url)).toEqual([
      'https://agent.minimax.cn/mavis/api/v1/mcp/get_upload_url',
      'https://upload.example.com/put/fits',
      'https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand',
    ])
  })

  it('states in the tool description that upload is measured and that a description can misdescribe the clip', () => {
    // The prose is part of the contract: the upload path is no longer an
    // unproven opt-in, and fidelity is the caveat a caller must still see.
    const tool = understandTool(vi.fn() as never) as unknown as {
      description: string
      parameters: { properties: { transport: { description: string } } }
    }
    const prose = tool.description + ' ' + tool.parameters.properties.transport.description
    expect(prose).not.toContain('UNVERIFIED')
    expect(prose).not.toContain('unverified')
    expect(prose).toContain('measured end to end')
    // fidelity: a successful call is not a faithful description.
    expect(prose).toContain('NOT that the account of it is accurate')
    // The upload ceiling is discoverable from the parameter help.
    expect(tool.parameters.properties.transport.description).toContain('200 MB')
  })

  it('shrinks the inline budget when the deployment pins a smaller body cap', () => {
    // A deployment can lower the body ceiling with
    // DSH_MINIMAX_CODE_MAX_BODY_BYTES; a fixed 40 MB would then still overflow.
    const small = inlineVideoByteBudget(8 * 1024 * 1024)
    expect(small).toBeLessThan(MAX_INLINE_VIDEO_BYTES)
    expect(small).toBeLessThanOrEqual(Math.floor((8 * 1024 * 1024 * 3) / 4))
    expect(inlineVideoByteBudget(DEFAULT_MAX_MESSAGE_BODY_BYTES)).toBe(MAX_INLINE_VIDEO_BYTES)
  })

  it('uses the default prompt when none is given', async () => {
    const { fetchFn, calls } = queuedFetch([{ status: 200, body: answered('ok', true, CDN_CLIP) }])
    await understandTool(fetchFn).execute({ source: CDN_CLIP }, execution())
    expect(mediaSent(calls[0])?.prompt).toBe('描述这个视频的内容')
  })

  it('refuses a relative path', async () => {
    const { fetchFn } = queuedFetch([])
    await expect(understandTool(fetchFn).execute({ source: 'clip.mp4' }, execution()))
      .rejects.toThrow(/absolute/)
  })

  it('refuses a missing file', async () => {
    const { fetchFn } = queuedFetch([])
    await expect(understandTool(fetchFn).execute({ source: path.join(work, 'nope.mp4') }, execution()))
      .rejects.toThrow(/not found/)
  })

  it('refuses an unsupported container', async () => {
    const file = path.join(work, 'notes.txt')
    await writeFile(file, MP4)
    const { fetchFn } = queuedFetch([])
    await expect(understandTool(fetchFn).execute({ source: file }, execution()))
      .rejects.toThrow(/unsupported video extension/)
  })

  it('refuses a private-address URL before fetching it', async () => {
    // A loopback literal is refused by the address policy. The CDN gate runs
    // first and would refuse it too (127.0.0.1 is not the CDN host), so the test
    // pins the OUTCOME both gates agree on: no request is made.
    const { fetchFn, calls } = queuedFetch([])
    const failure = await failureOf({ source: 'http://127.0.0.1/a.mp4' }, fetchFn)
    expect(['MINIMAX_VIDEO_URL_NOT_MINIMAX_CDN', 'MINIMAX_VIDEO_BLOCKED_URL']).toContain(failure.code)
    expect(calls).toHaveLength(0)
  })

  it('fails when the answer carries no results at all', async () => {
    const { fetchFn } = queuedFetch([{ status: 200, body: { base_resp: { status_code: 0 } } }])
    await expect(understandTool(fetchFn).execute({ source: CDN_CLIP }, execution()))
      .rejects.toThrow(/without a description/)
  })

  it('fails when results[0] reports success but carries no description', async () => {
    const { fetchFn } = queuedFetch([{ status: 200, body: answered('', true, CDN_CLIP) }])
    await expect(understandTool(fetchFn).execute({ source: CDN_CLIP }, execution()))
      .rejects.toThrow(/without a description/)
  })

  it('fails when the service received FEWER bytes than this route sent', async () => {
    // MEASURED: on the inline path results[0].source echoes the byte count the
    // service actually kept - a 1 048 576-byte request came back as
    // "inline:1048576B" (docs/minimax-video-free-checks.md section 4.3). So a
    // disagreeing count is proof the clip did not arrive whole, and any
    // description beside it describes truncated bytes.
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn, calls } = queuedFetch([{
      // One byte short of what was sent, with a success and a description.
      status: 200, body: answered('a tabby cat licks its paw', true, 'inline:' + (MP4.byteLength - 1) + 'B'),
    }])
    const failure = await failureOf({ source: file }, fetchFn)
    expect(failure.code).toBe('MINIMAX_VIDEO_BYTES_MISMATCH')
    // Both numbers are in the sentence: what was sent, and what arrived.
    expect(failure.message).toContain(String(MP4.byteLength))
    expect(failure.message).toContain(String(MP4.byteLength - 1))
    // The request WAS made - this is a post-response check - but it was not retried.
    expect(calls).toHaveLength(1)
  })

  it('fails when the service received MORE bytes than this route sent', async () => {
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn } = queuedFetch([{
      status: 200, body: answered('a tabby cat', true, 'inline:' + (MP4.byteLength + 5) + 'B'),
    }])
    const failure = await failureOf({ source: file }, fetchFn)
    expect(failure.code).toBe('MINIMAX_VIDEO_BYTES_MISMATCH')
  })

  it('SKIPS the byte check when the source is not an inline count', async () => {
    // The upload path cites a cdn_url and the service echoes the URL back, so
    // there is no count to compare. Failing that shape would break the one path
    // that is measured to work end to end.
    const cdnUrl = 'https://' + MINIMAX_CDN_HOST + '/cdn/mcp/u1/general/7_7.mp4'
    const { fetchFn } = queuedFetch([{
      status: 200, body: answered('a hand waves', true, cdnUrl),
    }])
    const result = await understandTool(fetchFn).execute({ source: cdnUrl }, execution())
    expect(result.analysis).toBe('a hand waves')
    // And a body carrying NO source at all is skipped too, not failed.
    const bare = queuedFetch([{
      status: 200,
      body: { code: 0, results: [{ success: true, description: 'a hand waves', error: '' }] },
    }])
    const bareResult = await understandTool(bare.fetchFn).execute({ source: CDN_CLIP }, execution())
    expect(bareResult.analysis).toBe('a hand waves')
  })

  it('fails when the model says it never saw a video', async () => {
    // MEASURED: for bytes it could not read, the service returned (in the very
    // same run that invented an alley chase) "您似乎没有上传或附上任何视频" - "it
    // looks like you did not upload or attach any video"
    // (docs/minimax-video-free-checks.md section 4.4). That is the service
    // stating nothing reached it; returning it as an analysis would tell the
    // user the model looked at their file.
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    // Every phrase here is matched by the regex the probe fixed, so a fixture
    // that quietly falls outside it would be testing the wrong thing.
    for (const description of [
      '您似乎没有上传或附上任何视频',
      'I did not see a video in the request',
      'No video was attached, so there is nothing to describe.',
      'no content provided',
    ]) {
      const { fetchFn } = queuedFetch([{ status: 200, body: answered(description, true) }])
      const failure = await failureOf({ source: file }, fetchFn)
      expect(failure.code).toBe('MINIMAX_VIDEO_NOT_DECODED')
      // The sentence the service used travels into the message, so the caller
      // can see WHICH "no video" wording came back.
      expect(failure.message).toContain('did not see a video')
    }
  })

  it('detects "no video" in results[0].error as well as the description', async () => {
    const file = path.join(work, 'clip.mp4')
    await writeFile(file, MP4)
    const { fetchFn } = queuedFetch([{
      status: 200,
      body: {
        code: 0,
        results: [{ success: true, description: '', error: 'no video content was provided', source: 'inline:' + MP4.byteLength + 'B' }],
      },
    }])
    const failure = await failureOf({ source: file }, fetchFn)
    expect(failure.code).toBe('MINIMAX_VIDEO_NOT_DECODED')
  })
})

describe('local container validation', () => {
  it('recognises the four container magics the accepted extensions map to', () => {
    // The sniff is the gate that stops a non-video from being described, so the
    // magics themselves are pinned rather than only exercised indirectly.
    expect(sniffVideoContainer(MP4)).toBe('iso-bmff')
    expect(sniffVideoContainer(WEBM)).toBe('matroska')
    expect(sniffVideoContainer(AVI)).toBe('avi')
    expect(sniffVideoContainer(MPEG_PS)).toBe('mpeg-ps')
    // Every non-container shape is undefined.
    expect(sniffVideoContainer(fillerBytes(64))).toBeUndefined()
    expect(sniffVideoContainer(new Uint8Array(32))).toBeUndefined()
    // 'RIFF' alone is not enough: the form type at offset 8 must be 'AVI '.
    expect(sniffVideoContainer(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]))).toBeUndefined()
    // An empty file, and one shorter than the ftyp offset, are not containers.
    expect(sniffVideoContainer(new Uint8Array(0))).toBeUndefined()
    expect(sniffVideoContainer(new Uint8Array([0x66, 0x74, 0x79, 0x70]))).toBeUndefined()
  })

  it('refuses 0x11 filler with NOT_A_CONTAINER and sends NOTHING', async () => {
    // THE fatal case, measured: 1 MiB of 0x11 was answered with
    // results[0].success: true and a confident description of a tabby cat
    // (docs/minimax-video-free-checks.md section 4.4). The file is a .mp4 by
    // name, so only the bytes can catch it - and catching it HERE is what keeps
    // the fabricated description from ever reaching the user.
    const file = path.join(work, 'filler.mp4')
    await writeFile(file, fillerBytes())
    const { fetchFn, calls } = queuedFetch([])
    const failure = await understandTool(fetchFn)
      .execute({ source: file }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_NOT_A_CONTAINER')
    // The message has to say the file was NOT sent, or the user will assume the
    // model described it and got it wrong.
    expect(failure?.message).toContain('NOTHING WAS SENT')
    expect(failure?.message).toContain('invented description')
    expect(calls).toHaveLength(0)
  })

  it('refuses a non-container on the UPLOAD path too, before reserving a URL', async () => {
    const file = path.join(work, 'filler.webm')
    await writeFile(file, fillerBytes())
    const { fetchFn, calls } = queuedFetch([])
    const failure = await understandTool(fetchFn)
      .execute({ source: file, transport: 'upload' }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_NOT_A_CONTAINER')
    // get_upload_url is a request: the refusal must precede even that.
    expect(calls).toHaveLength(0)
  })

  it('sniffs a SMALL head rather than reading the whole file', async () => {
    // The gate must not become the out-of-memory path the size check exists to
    // prevent: reading a large file's every byte only to refuse it would undo
    // the point. A readFile spy on a maximal upload-sized file makes the
    // regression visible.
    const file = path.join(work, 'big-ok.mp4')
    await writeFile(file, MP4)
    await truncate(file, 8 * 1024 * 1024)
    const readSpy = vi.spyOn(fsPromises, 'readFile')
    try {
      const { fetchFn } = queuedFetch([{
        status: 200, body: answered('ok', true, 'inline:' + (8 * 1024 * 1024) + 'B'),
      }])
      await understandTool(fetchFn).execute({ source: file, transport: 'upload' }, execution())
        .catch(() => undefined)
      // Exactly one readFile call - the one AFTER the sniff accepted the head.
      expect(readSpy).toHaveBeenCalledTimes(1)
    } finally {
      readSpy.mockRestore()
    }
  })

  it('accepts mp4, webm, avi and mpeg files by their bytes, not their extension', async () => {
    const cases: Array<{ name: string; bytes: Uint8Array; mediaType: string }> = [
      { name: 'a.mp4', bytes: MP4, mediaType: 'video/mp4' },
      { name: 'b.webm', bytes: WEBM, mediaType: 'video/webm' },
      { name: 'c.avi', bytes: AVI, mediaType: 'video/x-msvideo' },
      { name: 'd.mpg', bytes: MPEG_PS, mediaType: 'video/mpg' },
    ]
    for (const { name, bytes, mediaType } of cases) {
      const file = path.join(work, name)
      await writeFile(file, bytes)
      const { fetchFn, calls } = queuedFetch([{
        status: 200, body: answered('a clip', true, 'inline:' + bytes.byteLength + 'B'),
      }])
      const result = await understandTool(fetchFn).execute({ source: file }, execution())
      expect(result.analysis).toBe('a clip')
      expect(result.mediaType).toBe(mediaType)
      expect(calls).toHaveLength(1)
    }
  })
})

/** One planned mock answer. */
type PlannedAnswer = { status: number; body: unknown; headers?: Record<string, string> }

/** The four answers one successful generation consumes. */
function successPlan(videoUrl = 'https://cdn.example.com/out.mp4'): PlannedAnswer[] {
  return [
    { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-42' } },
    { status: 200, body: { base_resp: { status_code: 0 }, status: 'running' } },
    { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: videoUrl, duration: 6 } },
    { status: 200, body: MP4, headers: { 'content-type': 'video/mp4' } },
  ]
}

describe('minimax_generate_video', () => {

  it('runs submit, poll, download and write, and returns the workspace path', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    const result = await generateTool(fetchFn).execute({ prompt: 'a cat on a piano' }, execution())

    // The four steps, in order.
    expect(calls.map(c => c.url)).toEqual([
      'https://agent.minimax.cn/mavis/api/v1/mcp/submit_video_generation',
      'https://agent.minimax.cn/mavis/api/v1/mcp/query_video_generation',
      'https://agent.minimax.cn/mavis/api/v1/mcp/query_video_generation',
      'https://cdn.example.com/out.mp4',
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: 'MiniMax-H3', prompt: 'a cat on a piano',
    })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ task_id: 'task-42', model: 'MiniMax-H3' })

    // The file really exists, at the workspace-relative path returned.
    expect(result.videoPath).toMatch(/^minimax-videos\/minimax-.+-task-42\.mp4$/)
    const onDisk = await readFile(path.join(work, String(result.videoPath)))
    expect(Array.from(onDisk)).toEqual(Array.from(MP4))
    expect(result.bytes).toBe(MP4.byteLength)
    expect(result.mediaType).toBe('video/mp4')
    expect(result.taskId).toBe('task-42')
    expect(result.durationSeconds).toBe(6)
  })

  it('writes into the session workspace, not a plugin-private directory', async () => {
    const { fetchFn } = queuedFetch(successPlan())
    const result = await generateTool(fetchFn).execute({ prompt: 'x' }, execution())
    expect(String(result.videoPath).startsWith(GENERATED_VIDEO_DIR + '/')).toBe(true)
    await expect(readFile(path.join(work, String(result.videoPath)))).resolves.toBeDefined()
  })

  it('exposes the presentation meta with the field names the client reads', async () => {
    const { fetchFn } = queuedFetch(successPlan())
    const tool = generateTool(fetchFn)
    const value = await tool.execute({ prompt: 'a cat' }, execution())
    const meta = tool.output.presentationMeta?.({ prompt: 'a cat' }, value) as Record<string, unknown>
    expect(meta).toBeDefined()
    expect(Object.keys(meta ?? {}).sort())
      .toEqual(['bytes', 'durationSeconds', 'mediaType', 'model', 'taskId', 'videoPath'])
    expect(meta?.videoPath).toBe(value.videoPath)
    expect(meta?.taskId).toBe('task-42')
    expect(meta?.model).toBe('MiniMax-H3')
    expect(meta?.mediaType).toBe('video/mp4')
    expect(meta?.bytes).toBe(MP4.byteLength)
    expect(meta?.durationSeconds).toBe(6)
  })

  it('omits durationSeconds when the service did not report one', async () => {
    const plan = successPlan()
    plan[2] = { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'https://cdn.example.com/out.mp4' } }
    const { fetchFn } = queuedFetch(plan)
    const tool = generateTool(fetchFn)
    const value = await tool.execute({ prompt: 'a cat' }, execution())
    const meta = tool.output.presentationMeta?.({ prompt: 'a cat' }, value) as Record<string, unknown>
    expect(meta).not.toHaveProperty('durationSeconds')
    expect(Object.keys(meta ?? {}).sort()).toEqual(['bytes', 'mediaType', 'model', 'taskId', 'videoPath'])
  })

  it('passes resolution and duration through when given', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await generateTool(fetchFn).execute(
      // Hailuo's own legal pair: 1080P is legal HERE (and illegal on H3), and 10
      // is one of the two durations this model accepts.
      { prompt: 'a cat', model: 'MiniMax-Hailuo-2.3', resolution: '1080P', durationSeconds: 10 },
      execution(),
    )
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: 'MiniMax-Hailuo-2.3', prompt: 'a cat', resolution: '1080P', duration: 10,
    })
  })

  it('times out once the generation budget is spent', async () => {
    let clock = 1_700_000_000_000
    const { fetchFn } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-slow' } },
      ...Array.from({ length: 12 }, () => ({
        status: 200, body: { base_resp: { status_code: 0 }, status: 'running' },
      })),
    ])
    const tool = createMinimaxGenerateVideoTool(context() as never, {
      fetchFn,
      pool: pool(),
      pollIntervalMs: 1,
      generationBudgetMs: 10,
      // A clock that advances past the budget after the first poll.
      now: () => { clock += 100; return clock },
    }) as never as Executable
    await expect(tool.execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/did not finish within/)
  })

  it('reports a task the service marked failed', async () => {
    const { fetchFn } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-bad' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'failed', message: 'prompt rejected' } },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/prompt rejected/)
  })

  it('refuses a download the address policy blocks, without writing a file', async () => {
    // The URL comes from the SERVICE, which is exactly why the gate has to run:
    // a compromised or buggy answer must not become a reader of this machine.
    const { fetchFn, calls } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-ssrf' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'http://127.0.0.1/secret.mp4' } },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/not a public IP/)
    // Three calls: submit, query, and nothing else - the download never ran.
    expect(calls).toHaveLength(2)
  })

  it('refuses to generate when the session has no workspace to write into', async () => {
    // Refused BEFORE the submit, so a billed generation is not spent on a file
    // that could not be stored.
    const { fetchFn, calls } = queuedFetch([])
    const noWorkspace = { get: () => undefined }
    await expect(generateTool(fetchFn, { ctx: noWorkspace }).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/no working directory/)
    expect(calls).toHaveLength(0)
  })

  it('falls back to the session header cwd when no working-directory service exists', async () => {
    const { fetchFn } = queuedFetch(successPlan())
    const result = await generateTool(fetchFn, { ctx: { get: () => undefined } })
      .execute({ prompt: 'x' }, execution('minimax-code', work))
    expect(String(result.videoPath).startsWith('minimax-videos/')).toBe(true)
    await expect(readFile(path.join(work, String(result.videoPath)))).resolves.toBeDefined()
  })

  it('does NOT retry a failed submit, because a second attempt is a second charge', async () => {
    // The exact defect this pins: submit used to ride callWithRetry, so one
    // transient 500 became three submits - three billed generations for a turn
    // that then threw anyway. Upstream states the rule ("A submit attempt is
    // terminal for that exact request in the current turn"), so the ONLY
    // possible count is one.
    const { fetchFn, calls } = queuedFetch([
      { status: 500, body: { message: 'upstream busy' } },
      // Everything below is what a retry loop would have consumed.
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-second-charge' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'https://cdn.example.com/out.mp4' } },
      { status: 200, body: MP4, headers: { 'content-type': 'video/mp4' } },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/upstream busy|HTTP 500|SERVER/)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('submit_video_generation')
  })

  it('does not retry a submit that fails at the transport level either', async () => {
    // A retryable VERDICT is not the discriminator - the endpoint is. A transport
    // failure is classified retryable, and it must still not be retried here.
    let attempts = 0
    const fetchFn = (async () => {
      attempts += 1
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/could not reach|fetch failed/)
    expect(attempts).toBe(1)
  })

  it('accepts ONLY succeeded as the terminal status, and does not accept "success"', async () => {
    // MEASURED: a real generation went running -> succeeded. The probe never saw
    // "success", so the branch that accepted it was a guess; a body carrying it
    // must now be treated as an UNKNOWN status and run into the budget, not as
    // a finished task with no URL (which would throw the misleading "no
    // video_url" instead of naming the spelling it kept seeing).
    const { fetchFn } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-guess' } },
      ...Array.from({ length: 12 }, () => ({
        status: 200,
        body: { base_resp: { status_code: 0 }, status: 'success', video_url: 'https://cdn.example.com/out.mp4' },
      })),
    ])
    const tool = createMinimaxGenerateVideoTool(context() as never, {
      fetchFn,
      pool: pool(),
      pollIntervalMs: 1,
      generationBudgetMs: 10,
      now: (() => { let clock = 1_700_000_000_000; return () => { clock += 100; return clock } })(),
    }) as never as Executable
    const failure = await tool.execute({ prompt: 'x' }, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    expect(failure?.code).toBe('MINIMAX_VIDEO_TIMEOUT')
    // The status it kept seeing is named, so an upstream respelling is visible.
    expect(failure?.message).toContain('success')
  })

  it('still retries a transient 5xx on the read-only query, which is not billed', async () => {
    const { fetchFn, calls } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-ok' } },
      { status: 503, body: { message: 'upstream busy' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'https://cdn.example.com/out.mp4' } },
      { status: 200, body: MP4, headers: { 'content-type': 'video/mp4' } },
    ])
    const result = await generateTool(fetchFn).execute({ prompt: 'x' }, execution())
    expect(result.taskId).toBe('task-ok')
    // submit, query, query again, download.
    expect(calls).toHaveLength(4)
    expect(calls[0]?.url).toContain('submit_video_generation')
    expect(calls[1]?.url).toContain('query_video_generation')
    expect(calls[2]?.url).toContain('query_video_generation')
    expect(calls[3]?.url).toBe('https://cdn.example.com/out.mp4')
  })

  it('does not retry a terminal business refusal', async () => {
    const { fetchFn, calls } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 2013, status_msg: 'invalid params' } } },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/2013/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a submit answer with no task id', async () => {
    const { fetchFn } = queuedFetch([{ status: 200, body: { base_resp: { status_code: 0 } } }])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/no task id/)
  })

  it('refuses an empty prompt', async () => {
    const { fetchFn } = queuedFetch([])
    await expect(generateTool(fetchFn).execute({ prompt: '   ' }, execution()))
      .rejects.toThrow(/prompt cannot be empty/)
  })

  /**
   * Run one generation and return the error instead of throwing.
   *
   * TWO TRAPS LIVE HERE, and both were paid for once:
   *
   * 1. THE MESSAGE MUST BE READ OFF THE ERROR, NOT SPREAD OUT OF IT. An Error's
   *    `message` is a non-enumerable own property (`Object.keys(new Error('x'))`
   *    is `[]`; `{ ...error }` really does drop it), so the old
   *    `{ ...failure }` return handed every caller `message: undefined`. That is
   *    not a silent wrong answer - `expect(undefined).toContain('x')` and
   *    `expect(undefined).not.toContain('x')` BOTH throw under Vitest rather
   *    than passing, so a message assertion through this helper showed up as a
   *    confusing "invalid combination of arguments" failure rather than as an
   *    honest one. Read the two fields explicitly; do not spread the error.
   *
   * 2. THE ERROR IS OPTIONAL, THE CALL COUNT IS NOT. `execute` resolving means
   *    no error was thrown, so `failure` is legitimately undefined there - the
   *    `calls` count is the whole result in that case, which is why both fields
   *    stay optional in the return type.
   *
   * A caller-supplied `model` outside the tool argument schema's enum is
   * refused by the argument layer BEFORE `execute` runs, so that path reports
   * `INVALID_ARGS`. A model that gets PAST the schema still reaches
   * {@link assertVideoModel}, and the test below covers both layers.
   */
  async function generateFailureOf(
    args: Record<string, unknown>,
    fetchFn: typeof fetch,
  ): Promise<{ code?: string; message?: string; calls: number }> {
    let count = 0
    const counting = (async (...rest: Parameters<typeof fetch>) => {
      count += 1
      return (fetchFn as unknown as (...a: Parameters<typeof fetch>) => Promise<Response>)(...rest)
    }) as unknown as typeof fetch
    const failure = await generateTool(counting)
      .execute(args, execution())
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string })
    return { code: failure?.code, message: failure?.message, calls: count }
  }

  /** Run one validator call and return the error instead of throwing. */
  function errorOf(run: () => unknown): { code?: string; message?: string } {
    try {
      run()
      return {}
    } catch (error) {
      return error as { code?: string; message?: string }
    }
  }

  it('enforces the duration window PER MODEL, naming that model\'s own values', () => {
    // MEASURED, verbatim from the service: "use 4-15 seconds for MiniMax-H3,
    // 5-15 seconds for MiniMax-H3-Max, or 6/10 seconds for Hailuo 2.3"
    // (docs/minimax-video-free-checks.md section 2.1). One shared 4-15 window was
    // wrong for two of the three models, in both directions.
    //
    // H3: 3 is below its window, and the message must name H3's 4-15.
    const h3 = errorOf(() => assertVideoDuration(3, 'MiniMax-H3'))
    expect(h3.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
    expect(h3.message).toContain('4 to 15 seconds')
    expect(h3.message).toContain('MiniMax-H3')

    // H3-Max: 4 is INSIDE the old shared window and ILLEGAL for this model.
    const max = errorOf(() => assertVideoDuration(4, 'MiniMax-H3-Max'))
    expect(max.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
    expect(max.message).toContain('5 to 15 seconds')
    expect(max.message).toContain('MiniMax-H3-Max')

    // Hailuo: a CLOSED SET, not a window. 7 is inside 4-15 and still refused.
    const hailuo = errorOf(() => assertVideoDuration(7, 'MiniMax-Hailuo-2.3'))
    expect(hailuo.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
    expect(hailuo.message).toContain('6 or 10 seconds')
    expect(hailuo.message).toContain('MiniMax-Hailuo-2.3')
  })

  it('accepts Hailuo\'s two discrete durations and nothing between them', async () => {
    for (const durationSeconds of [6, 10]) {
      const { fetchFn, calls } = queuedFetch(successPlan())
      await generateTool(fetchFn).execute(
        { prompt: 'x', model: 'MiniMax-Hailuo-2.3', durationSeconds },
        execution(),
      )
      expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ duration: durationSeconds })
    }
    // The neighbours of the accepted set are refused, and the message names
    // "6 or 10" rather than a range.
    for (const durationSeconds of [5, 7, 9, 11, 15]) {
      const failure = errorOf(() => assertVideoDuration(durationSeconds, 'MiniMax-Hailuo-2.3'))
      expect(failure.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
      expect(failure.message).toContain('6 or 10')
    }
  })

  it('treats duration 0 as MISSING, not as out of range', () => {
    // MEASURED: asked for duration 0 the service answers "duration is required
    // for MiniMax-H3" (docs/minimax-video-free-checks.md section 2.2), so 0 is
    // the same class of error as omitting it. Reporting it as "out of range"
    // would point the caller at the wrong fix and imply 0 was a legal-looking
    // number that fell outside the window.
    for (const model of ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3'] as const) {
      const failure = errorOf(() => assertVideoDuration(0, model))
      expect(failure.code).toBe('MINIMAX_VIDEO_DURATION_REQUIRED')
      expect(failure.message).toContain('must be specified')
      expect(failure.message).not.toContain('out of range')
      // The model's legal values are still named, so the remedy is actionable.
      expect(failure.message).toContain(model)
    }
  })

  it('accepts both ends of each model\'s duration window', async () => {
    const windows: Array<{ model: string; durations: number[] }> = [
      { model: 'MiniMax-H3', durations: [4, 15] },
      { model: 'MiniMax-H3-Max', durations: [5, 15] },
      { model: 'MiniMax-Hailuo-2.3', durations: [6, 10] },
    ]
    for (const { model, durations } of windows) {
      for (const durationSeconds of durations) {
        const { fetchFn, calls } = queuedFetch(successPlan())
        await generateTool(fetchFn).execute({ prompt: 'x', model, durationSeconds }, execution())
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ duration: durationSeconds })
      }
    }
  })

  it('refuses a non-integer duration before a request is spent', async () => {
    for (const durationSeconds of [4.5, 'abc']) {
      const { fetchFn, calls } = queuedFetch([])
      await expect(generateTool(fetchFn).execute({ prompt: 'x', durationSeconds: durationSeconds as never }, execution()))
        .rejects.toThrow(/"durationSeconds" must be an integer/)
      expect(calls).toHaveLength(0)
    }
  })

  it('refuses resolutions that are not spellings at all, without sending anything', async () => {
    // Two layers again. A value outside the parameter enum (4K, 720p, 2k, 1080,
    // '') is refused by the tool argument layer before execute - which is already
    // free and already correct - and the per-model validator covers everything
    // that reaches it.
    for (const resolution of ['4K', '720p', '2k', '1080', '']) {
      const { fetchFn, calls } = queuedFetch([])
      await expect(generateTool(fetchFn).execute({ prompt: 'x', resolution }, execution()))
        .rejects.toThrow(/resolution/)
      expect(calls).toHaveLength(0)
      // The same values are refused by the validator too, naming this model.
      const failure = errorOf(() => assertVideoResolution(resolution, 'MiniMax-H3'))
      expect(failure.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(failure.message).toContain('for MiniMax-H3')
    }
  })

  it('refuses 1080P on MiniMax-H3, naming 768P and 2K', async () => {
    // MEASURED, verbatim: "model resolution for MiniMax-H3 must be 768P or 2K"
    // (docs/minimax-video-free-checks.md section 2.3). 1080P is a real
    // resolution, and it is ILLEGAL for this model - so the old union check let
    // it through to a billed refusal.
    const failure = errorOf(() => assertVideoResolution('1080P', 'MiniMax-H3'))
    expect(failure.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
    expect(failure.message).toContain('768P')
    expect(failure.message).toContain('2K')
    // 1080P is not OFFERED for this model: the listed options are exactly two.
    // (The message still echoes what was received in its "got ..." tail, which
    // is how the caller sees what it sent; what must not happen is 1080P
    // appearing among the accepted values.)
    const offered = /resolution must be one of ([^,]+(?:, [^,]+)*) for MiniMax-H3/.exec(failure.message ?? '')
    expect(offered?.[1]).toBe('"768P", "2K"')
    expect(failure.message).toContain('got "1080P"')
  })

  it('is case-sensitive: a lowercase 768p is refused', () => {
    // MEASURED: "720p" and "4K" came back with the IDENTICAL refusal sentence,
    // so the match cannot be case-insensitive (section 2.3).
    for (const model of ['MiniMax-H3', 'MiniMax-Hailuo-2.3'] as const) {
      const failure = errorOf(() => assertVideoResolution('768p', model))
      expect(failure.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(failure.message).toContain('768P')
      expect(failure.message).toContain('case-sensitive')
    }
  })

  it('accepts each resolution the model allows, per model', async () => {
    const allowed: Array<{ model: string; resolutions: string[] }> = [
      { model: 'MiniMax-H3', resolutions: ['768P', '2K'] },
      { model: 'MiniMax-Hailuo-2.3', resolutions: ['768P', '1080P'] },
    ]
    for (const { model, resolutions } of allowed) {
      for (const resolution of resolutions) {
        const { fetchFn, calls } = queuedFetch(successPlan())
        await generateTool(fetchFn).execute({ prompt: 'x', model, resolution }, execution())
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ resolution })
      }
    }
  })

  it('accepts 1080P on Hailuo but refuses it on H3', async () => {
    // The pair that proves the check really is per model rather than a union:
    // one value, two models, opposite verdicts.
    const hailuo = queuedFetch(successPlan())
    await generateTool(hailuo.fetchFn).execute(
      { prompt: 'x', model: 'MiniMax-Hailuo-2.3', resolution: '1080P' },
      execution(),
    )
    expect(JSON.parse(String(hailuo.calls[0]?.init?.body))).toMatchObject({ resolution: '1080P' })

    const h3 = await generateFailureOf(
      { prompt: 'x', model: 'MiniMax-H3', resolution: '1080P' },
      queuedFetch([]).fetchFn,
    )
    expect(h3.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
    // The message, not only the code: the refusal has to name the model and the
    // set that IS legal for it, or the caller cannot tell which value to use.
    expect(h3.message).toContain('resolution must be one of "768P", "2K" for MiniMax-H3')
    expect(h3.message).toContain('got "1080P"')
  })

  it('refuses a model id this build has no rules for', async () => {
    // Two layers, and BOTH matter. The tool argument schema lists the three ids,
    // so a caller bypassing its own schema is stopped there (INVALID_ARGS, no
    // request). assertVideoModel is the second layer, for any path that reaches
    // execute without passing through that schema - a model with no rule cannot
    // have its duration or resolution checked, and an unchecked submit is billed
    // before the service refuses it.
    for (const model of ['MiniMax-H4', 'hailuo', 'MiniMax-h3']) {
      const failure = await generateFailureOf({ prompt: 'x', model }, queuedFetch([]).fetchFn)
      expect(failure.calls).toBe(0)
      expect(['INVALID_ARGS', 'MINIMAX_VIDEO_MODEL_INVALID']).toContain(failure.code)
      // Whichever layer refused it, the reason has to REACH THE CALLER, and this
      // is the assertion that proves the error's message survives the helper:
      // against the old spread copy `failure.message` was `undefined`, and
      // `toContain` on undefined throws rather than passing, so this could never
      // have gone green either way.
      //
      // Deliberately layer-agnostic: the schema layer says '"model" must be one
      // of [...]' and assertVideoModel says 'model must be one of [...], got
      // "MiniMax-H4"', so the shared, load-bearing content is the legal set -
      // not the quoting, and not whether the refused value is echoed back.
      expect(failure.message).toContain('must be one of')
      expect(failure.message).toContain('MiniMax-H3-Max')
    }
    const direct = errorOf(() => assertVideoModel('MiniMax-H4'))
    expect(direct.code).toBe('MINIMAX_VIDEO_MODEL_INVALID')
    expect(direct.message).toContain('MiniMax-H3-Max')
  })

  it('accepts every model this build lists, including MiniMax-H3-Max', async () => {
    // FACT: MiniMax-H3-Max exists. The service named it in its own duration rule
    // ("5-15 seconds for MiniMax-H3-Max"); it was simply missing from the list.
    for (const { model } of MINIMAX_VIDEO_MODEL_RULES) {
      const { fetchFn, calls } = queuedFetch(successPlan())
      await generateTool(fetchFn).execute({ prompt: 'x', model }, execution())
      expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ model })
    }
    const tool = generateTool(vi.fn() as never) as unknown as {
      parameters: { properties: { model: { enum: string[] } } }
    }
    expect(tool.parameters.properties.model.enum).toContain('MiniMax-H3-Max')
  })

  it('says in the description which parameters this route supports', () => {
    const tool = generateTool(vi.fn() as never) as unknown as { description: string }
    expect(tool.description).toContain('Supported parameters: prompt, model')
    // The limits are stated PER MODEL, because they differ per model.
    expect(tool.description).toContain('MiniMax-H3-Max')
    expect(tool.description).toContain('4-15 for MiniMax-H3')
    expect(tool.description).toContain('5-15 for MiniMax-H3-Max')
    expect(tool.description).toContain('exactly 6 or 10 for MiniMax-Hailuo-2.3')
    expect(tool.description).toContain('case-sensitive')
    // `ratio` and `aigcWatermark` ARE implemented now, so the description has to
    // describe the RULE rather than deny the feature. The old assertion pinned
    // the denial sentence and went stale the moment the linkage landed.
    expect(tool.description).toContain('ratio picks the shape of the clip')
    expect(tool.description).toContain('is REWRITTEN before it is sent')
    expect(tool.description).toContain('adaptive is not allowed for a text-only generation')
    expect(tool.description).toContain('aigcWatermark asks for the AIGC watermark')
    expect(tool.description).not.toContain('not implemented on this route yet')
    // The no-retry contract is stated where the model reads it, not only in code.
    expect(tool.description).toContain('A failed submit is NOT re-sent')
  })

  it('refuses a download larger than the store limit', async () => {
    const { fetchFn } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-big' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'https://cdn.example.com/big.mp4' } },
      {
        status: 200,
        body: '',
        headers: { 'content-length': String(MAX_GENERATED_VIDEO_BYTES + 1), 'content-type': 'video/mp4' },
      },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'x' }, execution()))
      .rejects.toThrow(/above the/)
  })

  /**
   * THE MEASURED RULE TABLE.
   *
   * Everything below is pinned to the service's own refusal sentences, quoted
   * verbatim in docs/minimax-video-model-rules.md. The point of the group is that
   * the three resolution sets are PAIRWISE DIFFERENT and none of them is the
   * union, so a shared list - the shape this table used to have - can only ever
   * be wrong for at least one model.
   */
  describe('the measured per-model rules', () => {
    /** The sentence the service answers when a resolution is wrong for a model. */
    function offeredResolutions(message: string | undefined, model: string): string | undefined {
      // The refusal reads: resolution must be one of "480P", "768P" for MiniMax-H3-Max, got ...
      // The model id is escaped because "MiniMax-Hailuo-2.3" contains a dot.
      const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp('resolution must be one of ([^,]+(?:, [^,]+)*) for ' + escaped).exec(message ?? '')?.[1]
    }

    // NOTE: this block used to carry its own `refusalOf` helper - a verbatim
    // copy of generateFailureOf whose only difference was that it read `message`
    // off the error explicitly instead of spreading it. That spread is fixed, so
    // the copy is gone and these cases use generateFailureOf like every other
    // case in the file: one helper, one place to get it wrong.

    it('pins the table to the measured sets, with every row marked measured', () => {
      // MEASURED, verbatim (docs/minimax-video-model-rules.md sections 1, 2.1 and 5):
      //   model resolution for `MiniMax-H3` must be `768P` or `2K`
      //   model resolution for `MiniMax-H3-Max` must be `480P` or `768P`
      //   model resolution for `MiniMax-Hailuo-2.3` must be `768P` or `1080P`
      const expected: Array<{ model: string; resolutions: string[] }> = [
        { model: 'MiniMax-H3', resolutions: ['768P', '2K'] },
        { model: 'MiniMax-H3-Max', resolutions: ['480P', '768P'] },
        { model: 'MiniMax-Hailuo-2.3', resolutions: ['768P', '1080P'] },
      ]
      for (const { model, resolutions } of expected) {
        const rule = MINIMAX_VIDEO_MODEL_RULES.find(entry => entry.model === model)
        expect(rule?.resolutions).toEqual(resolutions)
        // NOTHING IS LEFT UNVERIFIED. The previous build carried 'inferred' on
        // H3-Max (it had copied H3's pair) and 'documented' on Hailuo; both are
        // measured now, and a regression to either weaker marker would mean the
        // table is guessing again.
        expect(rule?.resolutionSource).toBe('measured')
      }
      expect(MINIMAX_VIDEO_MODEL_RULES).toHaveLength(3)
    })

    it('has three sets that are pairwise different, and the union is no model\'s set', () => {
      // The property that kills a shared whitelist outright: no model's set
      // equals another's, and no model accepts the union of all three.
      const sets = MINIMAX_VIDEO_MODEL_RULES.map(rule => ({ model: rule.model, set: [...rule.resolutions] as string[] }))
      const union = [...new Set(sets.flatMap(entry => entry.set))]
      expect(union.sort()).toEqual(['1080P', '2K', '480P', '768P'])
      for (const entry of sets) {
        expect(entry.set.sort()).not.toEqual(union.slice().sort())
      }
      for (let left = 0; left < sets.length; left += 1) {
        for (let right = left + 1; right < sets.length; right += 1) {
          expect(sets[left]?.set).not.toEqual(sets[right]?.set)
        }
      }
      // The three signatures that make the union unusable, each exclusive to ONE
      // model: 2K is H3's alone, 480P is H3-Max's alone, 1080P is Hailuo's alone.
      const holders = (resolution: string): string[] =>
        sets.filter(entry => entry.set.includes(resolution)).map(entry => entry.model)
      expect(holders('2K')).toEqual(['MiniMax-H3'])
      expect(holders('480P')).toEqual(['MiniMax-H3-Max'])
      expect(holders('1080P')).toEqual(['MiniMax-Hailuo-2.3'])
      expect(holders('768P').sort()).toEqual(['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3'])
    })

    it('refuses 2K on MiniMax-H3-Max and names 480P and 768P', async () => {
      // THE CORE REGRESSION OF THIS ROUND. The previous table listed 768P/2K for
      // H3-Max as an inference from H3, so this exact call was accepted locally
      // and then refused upstream - a billed submit that could never succeed.
      // MEASURED: "model resolution for MiniMax-H3-Max must be 480P or 768P".
      const validator = errorOf(() => assertVideoResolution('2K', 'MiniMax-H3-Max'))
      expect(validator.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(validator.message).toContain('480P')
      expect(validator.message).toContain('768P')
      expect(offeredResolutions(validator.message, 'MiniMax-H3-Max')).toBe('"480P", "768P"')
      expect(validator.message).toContain('got "2K"')

      // Through execute the same value must spend NO request: 2K is inside the
      // parameter enum (H3 accepts it), so the argument layer lets it through
      // and only the per-model check stops it.
      const failure = await generateFailureOf(
        { prompt: 'x', model: 'MiniMax-H3-Max', resolution: '2K' },
        queuedFetch([]).fetchFn,
      )
      expect(failure.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(failure.calls).toBe(0)
      expect(failure.message).toContain('480P')
      expect(failure.message).toContain('768P')
    })

    it('accepts 480P on MiniMax-H3-Max and refuses it on the other two models', async () => {
      // 480P is the spelling ONLY H3-Max has, so it is the sharpest test that the
      // check is per model rather than a union: accepted on one, refused on two.
      const { fetchFn, calls } = queuedFetch(successPlan())
      await generateTool(fetchFn).execute(
        { prompt: 'x', model: 'MiniMax-H3-Max', resolution: '480P', durationSeconds: 5 },
        execution(),
      )
      expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
        model: 'MiniMax-H3-Max', resolution: '480P', duration: 5,
      })

      for (const model of ['MiniMax-H3', 'MiniMax-Hailuo-2.3'] as const) {
        const refusal = errorOf(() => assertVideoResolution('480P', model))
        expect(refusal.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
        expect(refusal.message).toContain(model)
      }
      // H3's refusal names its own pair and never offers 480P as an option.
      expect(offeredResolutions(errorOf(() => assertVideoResolution('480P', 'MiniMax-H3')).message, 'MiniMax-H3'))
        .toBe('"768P", "2K"')
      // Hailuo's names its own pair for the same input.
      expect(offeredResolutions(
        errorOf(() => assertVideoResolution('480P', 'MiniMax-Hailuo-2.3')).message,
        'MiniMax-Hailuo-2.3',
      )).toBe('"768P", "1080P"')
    })

    it('refuses 2K on MiniMax-Hailuo-2.3 and names 768P and 1080P', async () => {
      // MEASURED: "model resolution for MiniMax-Hailuo-2.3 must be 768P or 1080P".
      const validator = errorOf(() => assertVideoResolution('2K', 'MiniMax-Hailuo-2.3'))
      expect(validator.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(offeredResolutions(validator.message, 'MiniMax-Hailuo-2.3')).toBe('"768P", "1080P"')

      const failure = await generateFailureOf(
        { prompt: 'x', model: 'MiniMax-Hailuo-2.3', resolution: '2K', durationSeconds: 6 },
        queuedFetch([]).fetchFn,
      )
      expect(failure.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(failure.calls).toBe(0)
      expect(failure.message).toContain('768P')
      expect(failure.message).toContain('1080P')
    })

    it('accepts 1080P on Hailuo and 768P/2K on H3, and refuses 1080P on H3', async () => {
      const accepted: Array<{ model: string; resolution: string; durationSeconds?: number }> = [
        { model: 'MiniMax-Hailuo-2.3', resolution: '1080P', durationSeconds: 10 },
        { model: 'MiniMax-H3', resolution: '2K' },
        { model: 'MiniMax-H3', resolution: '768P' },
        { model: 'MiniMax-H3-Max', resolution: '768P', durationSeconds: 5 },
      ]
      for (const args of accepted) {
        const { fetchFn, calls } = queuedFetch(successPlan())
        await generateTool(fetchFn).execute({ prompt: 'x', ...args }, execution())
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ resolution: args.resolution })
      }

      // 1080P stays refused on H3, and its message still names 768P/2K - the
      // sentence this build has pinned since the first measurement.
      const h3 = errorOf(() => assertVideoResolution('1080P', 'MiniMax-H3'))
      expect(h3.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
      expect(offeredResolutions(h3.message, 'MiniMax-H3')).toBe('"768P", "2K"')
    })

    it('checks duration BEFORE resolution, the order the service uses', async () => {
      // MEASURED ORDER: model -> duration -> resolution -> prompt -> ratio, each
      // check executed and short-circuiting (docs/minimax-video-model-rules.md
      // section 3.3). When one call breaks BOTH rules, the service answers about
      // the duration and never reaches the resolution - so a client that reports
      // the resolution first is showing the user an error the service would not
      // have produced.
      //
      // Hailuo with duration 7 (only 6 and 10 are legal) and resolution 2K (only
      // 768P and 1080P are legal): both wrong, and DURATION must win.
      const both = await generateFailureOf(
        { prompt: 'x', model: 'MiniMax-Hailuo-2.3', durationSeconds: 7, resolution: '2K' },
        queuedFetch([]).fetchFn,
      )
      expect(both.calls).toBe(0)
      expect(both.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
      expect(both.message).toContain('6 or 10 seconds')
      expect(both.message).not.toContain('resolution')

      // H3-Max with duration 4 (below its floor of 5) and resolution 2K (not in
      // its set): again the duration is the first rule broken upstream.
      const maxBoth = await generateFailureOf(
        { prompt: 'x', model: 'MiniMax-H3-Max', durationSeconds: 4, resolution: '2K' },
        queuedFetch([]).fetchFn,
      )
      expect(maxBoth.calls).toBe(0)
      expect(maxBoth.code).toBe('MINIMAX_VIDEO_DURATION_OUT_OF_RANGE')
      expect(maxBoth.message).toContain('5 to 15 seconds')
      expect(maxBoth.message).not.toContain('resolution')

      // And the converse, so the test cannot pass by always blaming duration: a
      // LEGAL duration with an illegal resolution reports the resolution.
      const resolutionOnly = await generateFailureOf(
        { prompt: 'x', model: 'MiniMax-H3-Max', durationSeconds: 5, resolution: '2K' },
        queuedFetch([]).fetchFn,
      )
      expect(resolutionOnly.calls).toBe(0)
      expect(resolutionOnly.code).toBe('MINIMAX_VIDEO_RESOLUTION_INVALID')
    })

    it('states each model\'s own set in the resolution parameter description', () => {
      const tool = generateTool(vi.fn() as never) as unknown as {
        parameters: { properties: { resolution: { enum: string[]; description: string } } }
      }
      const { enum: spellings, description } = tool.parameters.properties.resolution
      // The enum can only be one list, and it is the union - which is exactly why
      // the description has to carry the per-model pairs.
      expect([...spellings].sort()).toEqual(['1080P', '2K', '480P', '768P'])
      expect(description).toContain('MiniMax-H3: 768P or 2K')
      expect(description).toContain('MiniMax-H3-Max: 480P or 768P')
      expect(description).toContain('MiniMax-Hailuo-2.3: 768P or 1080P')
      expect(description).toContain('UNION')
      // The old wording presented H3-Max's resolutions as an inference; it must
      // not come back, because it named 2K - the value that model always refuses.
      expect(description).not.toContain('inference')
    })
  })
})

describe('the extended submit surface', () => {
  // These cover the wiring the two halves of the extended work meet in: the
  // argument names the model types, the field names the service reads, the
  // ratio the rules decide, and the one-submit guard that keeps a retry from
  // paying twice.

  it('sends the media under the SERVICE field names, not the argument names', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await generateTool(fetchFn).execute(
      {
        prompt: 'a cat',
        model: 'MiniMax-H3',
        durationSeconds: 4,
        inputImagePath: 'https://cdn.hailuoai.com/mcp/u1/general/a.png',
        referenceImagePaths: ['https://cdn.hailuoai.com/mcp/u1/general/b.png'],
      },
      execution(),
    )
    const body = JSON.parse(String(calls[0]?.init?.body))
    // The argument names are NOT the field names.
    expect(body).not.toHaveProperty('inputImagePath')
    expect(body).not.toHaveProperty('referenceImagePaths')
    expect(body.input_image).toEqual({ url: 'https://cdn.hailuoai.com/mcp/u1/general/a.png', mime_type: 'image/png' })
    expect(body.reference_images).toEqual([
      { url: 'https://cdn.hailuoai.com/mcp/u1/general/b.png', mime_type: 'image/png' },
    ])
    // A frame was given, so the service is told which reference type it is.
    expect(body.reference_type).toBe('first_frame')
  })

  it('forces adaptive when a frame is given, whatever the caller asked for', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await generateTool(fetchFn).execute(
      {
        prompt: 'a cat',
        model: 'MiniMax-H3',
        durationSeconds: 4,
        ratio: '16:9',
        inputImagePath: 'https://cdn.hailuoai.com/mcp/u1/general/a.png',
      },
      execution(),
    )
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.ratio).toBe('adaptive')
  })

  it('defaults a text-only generation to 16:9 and sends the 2K the H3 family wants', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await generateTool(fetchFn).execute({ prompt: 'a cat', model: 'MiniMax-H3', durationSeconds: 4 }, execution())
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.ratio).toBe('16:9')
    expect(body.resolution).toBe('2K')
  })

  it('refuses adaptive for a text-only generation, without sending anything', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await expect(generateTool(fetchFn).execute(
      { prompt: 'a cat', model: 'MiniMax-H3', durationSeconds: 4, ratio: 'adaptive' },
      execution(),
    )).rejects.toThrow(/adaptive/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a reference set on Hailuo, without sending anything', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    await expect(generateTool(fetchFn).execute(
      {
        prompt: 'a cat',
        model: 'MiniMax-Hailuo-2.3',
        durationSeconds: 6,
        referenceImagePaths: ['https://cdn.hailuoai.com/mcp/u1/general/b.png'],
      },
      execution(),
    )).rejects.toThrow(/reference/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a second identical submission in the same turn, without sending it', async () => {
    const { fetchFn, calls } = queuedFetch(successPlan())
    const tool = generateTool(fetchFn)
    // The guard needs a session identity to mean anything: without one the key
    // degrades to the body alone and two DIFFERENT generations would look
    // alike. So the guard is exercised with a session that HAS an id.
    const withSession = () => {
      const base = execution()
      return { ...base, agent: { ...base.agent, id: 'session-1' } }
    }
    await tool.execute({ prompt: 'a cat', model: 'MiniMax-H3', durationSeconds: 4 }, withSession())
    const before = calls.length
    await expect(tool.execute(
      { prompt: 'a cat', model: 'MiniMax-H3', durationSeconds: 4 },
      withSession(),
    )).rejects.toThrow(/already submitted/)
    expect(calls).toHaveLength(before)
  })

  it('does NOT refuse a second generation that differs, in the same session', async () => {
    // Two plans, so the second call has answers to consume: a DIFFERENT prompt
    // is a different intention and must be sent, not refused as a duplicate.
    const { fetchFn, calls } = queuedFetch([...successPlan(), ...successPlan()])
    const tool = generateTool(fetchFn)
    const withSession = () => {
      const base = execution()
      return { ...base, agent: { ...base.agent, id: 'session-2' } }
    }
    await tool.execute({ prompt: 'a cat', model: 'MiniMax-H3', durationSeconds: 4 }, withSession())
    const before = calls.length
    await tool.execute({ prompt: 'a dog', model: 'MiniMax-H3', durationSeconds: 4 }, withSession())
    expect(calls.length).toBeGreaterThan(before)
  })
})