import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CODEX_IMAGE_EDIT_URL,
  CODEX_IMAGE_GENERATION_URL,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_TOOL_NAME,
} from '../compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from './common/llm-compat.ts'
import { OAuthService } from './oauth-service.ts'
import type { StoredOAuthCredentials } from './token-store.ts'
import { codexHeaders } from './wire-auth.ts'

type FetchLike = typeof fetch

/**
 * Output canvases the Codex image endpoint accepts in `size`.
 *
 * These are the official client's own three canvases plus the default `auto`,
 * which lets the service pick. A size outside this set is not negotiated: the
 * backend answers it with a 400, so the tool refuses it before the request.
 */
export const CODEX_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const

/** Render effort the endpoint accepts in `quality`; `auto` is the service's own default. */
export const CODEX_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const

/** Reference images one edit request may carry. */
export const MAX_CODEX_REFERENCE_IMAGES = 5

/** Frame budget of an animated GIF the endpoint accepts. */
const GIF_MIN_FRAMES = 2
const GIF_MAX_FRAMES = 16
const GIF_MIN_FRAME_MS = 20
const GIF_MAX_FRAME_MS = 2_000

/** How much of an upstream error body is quoted back to the caller. */
const MAX_UPSTREAM_EXCERPT_CHARS = 300

/** What a request produced, which fixes the attachment type and file extension. */
type OutputMediaType = 'image/png' | 'image/gif'

export interface CodexImageToolOptions {
  fetchFn?: FetchLike
}

interface ImageOutput {
  prompt: string
  model: string
  image: {
    attachmentId: string
    mediaType: OutputMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/** One validated local reference image, bytes still in memory for the request. */
interface ReferenceImage {
  mediaType: ImageMediaType
  data: Uint8Array
}

/** Frame options for an animated GIF; both members are optional and independent. */
interface GifOptions {
  frameCount?: number
  frameDurationMs?: number
}

/** Everything one request body is built from. */
interface ImageRequestBody {
  prompt: string
  size: string
  quality: string
  transparentBackground?: boolean
  gif?: GifOptions
  references: ReferenceImage[]
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/**
 * Magic-byte checks per media type.
 *
 * An extension is a claim about a file's name; the bytes are the claim the file
 * itself makes. Both are checked, because sending a file whose declared type the
 * service cannot decode returns a plain upstream error rather than an image.
 */
const SIGNATURES: Record<ImageMediaType, (bytes: Uint8Array) => boolean> = {
  'image/png': bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': bytes => bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50,
  'image/gif': bytes => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46,
}

/**
 * Extensions a reference image may carry.
 *
 * Deliberately narrower than {@link SIGNATURES}: an edit accepts stills only.
 * Animated GIF input is not part of the edit wire contract, so it is refused
 * here instead of being sent to an endpoint that does not take it.
 */
const REFERENCE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export function createCodexImageTool(
  oauth: OAuthService,
  attachments: AttachmentStore,
  options: CodexImageToolOptions = {},
) {
  const fetchFn = options.fetchFn ?? fetch
  return defineTool({
    name: CODEX_IMAGE_TOOL_NAME,
    description: 'Generate or edit a PNG or GIF image with the signed-in ChatGPT subscription-backed Codex image endpoint. '
      + 'Describe the subject, style, composition and any text to render in the prompt; '
      + 'pass referenceImagePaths to edit local PNG/JPEG/WebP images, and gif to animate the result. '
      + 'Scheduling: call this tool yourself for a single generation, an edit, or a retry - never create a subagent just to '
      + 'generate one image. Delegate only when the creative task needs several candidate images or is large enough to be '
      + 'a multi-step task of its own.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed image generation prompt.',
      },
      size: {
        type: 'string',
        enum: CODEX_IMAGE_SIZES,
        description: 'Output canvas. Omit or pass auto to let the service choose. '
          + '1024x1024 is square, 1536x1024 landscape and 1024x1536 portrait.',
      },
      quality: {
        type: 'string',
        enum: CODEX_IMAGE_QUALITIES,
        description: 'Render effort. Omit or pass auto for the service default; low is fastest and high is most detailed.',
      },
      transparentBackground: {
        type: 'boolean',
        description: 'true for a transparent background (PNG or GIF alpha), false for an explicitly opaque one. '
          + 'Omit it to leave the background decision to the service.',
      },
      referenceImagePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 local PNG, JPEG or WebP files to edit. Absolute paths recommended. '
          + 'The request becomes an edit against those images; nothing else on disk is read.',
      },
      gif: {
        type: 'object',
        additionalProperties: false,
        description: 'Ask for an animated GIF. An empty object is allowed and lets the service choose the frames.',
        properties: {
          frameCount: {
            type: 'integer',
            description: 'Number of frames, 2 to 16.',
          },
          frameDurationMs: {
            type: 'integer',
            description: 'Milliseconds each frame is shown, 20 to 2000.',
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          model: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/gif'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as ImageOutput
        return [
          { type: 'text', text: `Generated image for: ${output.prompt}` },
          { type: 'image', attachment: output.image as unknown as ImageAttachmentRef },
        ]
      },
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      kind: 'other',
      title: 'Generate image',
      rawInput: args,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Image generation failed' : 'Generated image',
      content: result.content,
    }),
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt === '') throw new HarnessError('Image prompt cannot be empty.', 'CODEX_IMAGE_INVALID_PROMPT')
      // Each new option is validated before anything leaves this process, so a
      // refused parameter never becomes an upstream 400 that costs a request.
      const gif = readGifOptions(args.gif)
      const references = await readReferenceImages(args.referenceImagePaths ?? [], attachments)
      // A requested GIF fixes the output type. Refusing it here matters: the
      // deployment's attachment policy is what decides whether a GIF can be
      // stored at all, and discovering that after a paid generation wastes it.
      const outputType: OutputMediaType = gif === undefined ? 'image/png' : 'image/gif'
      assertOutputTypeSupported(attachments, outputType)
      const body = buildImageBody({
        prompt,
        size: args.size ?? 'auto',
        quality: args.quality ?? 'auto',
        ...(args.transparentBackground !== undefined ? { transparentBackground: args.transparentBackground } : {}),
        ...(gif !== undefined ? { gif } : {}),
        references,
      })
      // Reference images switch the route: generations create, edits modify.
      const url = references.length > 0 ? CODEX_IMAGE_EDIT_URL : CODEX_IMAGE_GENERATION_URL
      const turnId = String(exec.callId)
      let credentials = await imageCredentials(oauth)
      let response = await requestImage(fetchFn, credentials, url, body, turnId, exec.signal)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        credentials = await imageCredentials(oauth, true)
        // The refused request is replayed EXACTLY as sent: no field is dropped
        // to make a retry pass, because a silently degraded retry would return
        // an image that is not the one that was asked for.
        response = await requestImage(fetchFn, credentials, url, body, turnId, exec.signal)
      }
      if (response.status === 429) {
        const detail = upstreamExcerpt(await response.text().catch(() => ''))
        throw new HarnessError(
          `Codex image generation was rate limited (429).${detail === '' ? '' : ` ${detail}`}`,
          'CODEX_IMAGE_RATE_LIMITED',
        )
      }
      if (response.status === 400) {
        const detail = upstreamExcerpt(await response.text().catch(() => ''))
        // The upstream body usually says only that the request was invalid, so
        // the message names the parameters THIS call stated - the caller can then
        // change the right one. Nothing is retried with a parameter removed: a
        // silently degraded retry would return an image that was not asked for.
        throw new HarnessError(
          'Codex rejected the image request (400). The parameters this call stated were: '
          + `${statedParameterSummary(args, gif, references.length)}. `
          + 'One of them is not accepted as given, and no field was dropped to retry.'
          + (detail === '' ? '' : ` Upstream said: ${detail}`),
          'CODEX_IMAGE_REQUEST_REJECTED',
        )
      }
      if (!response.ok) {
        const detail = upstreamExcerpt(await response.text().catch(() => ''))
        throw new HarnessError(
          `Codex image generation failed (${response.status}).${detail === '' ? '' : ` ${detail}`}`,
          'CODEX_IMAGE_FAILED',
        )
      }
      const data = await response.json() as unknown
      const decoded = decodeImageBytes(readBase64Image(data), maxGeneratedImageBytes(attachments))
      // A GIF was asked for, so a still image is not a smaller success - it is a
      // different result. Saving it would hand back a PNG labelled as the answer
      // to an animation request, which the caller cannot tell from a good run.
      if (gif !== undefined && decoded.mediaType !== 'image/gif') {
        throw new HarnessError(
          `Codex was asked for an animated GIF but returned ${decoded.mediaType}. Nothing was saved: `
          + 'the answer is not the animation that was requested. Omit the gif parameter to accept a still image.',
          'CODEX_IMAGE_RESPONSE_INVALID',
        )
      }
      if (!attachments.imageLimits.mediaTypes.includes(decoded.mediaType)) {
        throw new HarnessError(
          `Codex returned ${decoded.mediaType} but this DSH environment does not accept that attachment type.`,
          'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED',
        )
      }
      const image = await attachments.saveImage({
        data: decoded.data,
        mediaType: decoded.mediaType,
        name: `codex-generated-image.${decoded.mediaType === 'image/gif' ? 'gif' : 'png'}`,
      })
      const output: ImageOutput = {
        prompt,
        model: CODEX_IMAGE_MODEL,
        image: {
          attachmentId: image.attachmentId,
          mediaType: decoded.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...(image.name !== undefined ? { name: image.name } : {}),
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'image', attachment: image }],
          source: {
            kind: PLUGIN_MESSAGE_SOURCE_KIND,
            form: 'notice',
            summary: 'Generated image from Codex image tool.',
          },
        }))
      }
      return output
    },
  })
}

/**
 * Validate the frame options of a GIF request.
 *
 * An empty object is legal: it asks for an animation and leaves both numbers to
 * the service. A stated number is checked here rather than by the parameter
 * schema because the schema DSL carries no numeric bounds, and because
 * `execute` is reachable directly.
 */
function readGifOptions(gif: GifOptions | undefined): GifOptions | undefined {
  if (gif === undefined) return undefined
  const result: GifOptions = {}
  const frameCount = gif.frameCount
  if (frameCount !== undefined) {
    if (!Number.isInteger(frameCount) || frameCount < GIF_MIN_FRAMES || frameCount > GIF_MAX_FRAMES) {
      throw new HarnessError(
        `gif.frameCount must be a whole number from ${GIF_MIN_FRAMES} to ${GIF_MAX_FRAMES} (got ${String(frameCount)}).`,
        'CODEX_IMAGE_GIF_INVALID',
      )
    }
    result.frameCount = frameCount
  }
  const frameDurationMs = gif.frameDurationMs
  if (frameDurationMs !== undefined) {
    if (!Number.isInteger(frameDurationMs) || frameDurationMs < GIF_MIN_FRAME_MS || frameDurationMs > GIF_MAX_FRAME_MS) {
      throw new HarnessError(
        `gif.frameDurationMs must be a whole number of milliseconds from ${GIF_MIN_FRAME_MS} to ${GIF_MAX_FRAME_MS} (got ${String(frameDurationMs)}).`,
        'CODEX_IMAGE_GIF_INVALID',
      )
    }
    result.frameDurationMs = frameDurationMs
  }
  return result
}

/** Refuse an output type this deployment cannot store, before anything is requested. */
function assertOutputTypeSupported(attachments: AttachmentStore, outputType: OutputMediaType): void {
  if (attachments.imageLimits.mediaTypes.includes(outputType)) return
  throw new HarnessError(
    outputType === 'image/gif'
      ? 'GIF output was requested, but this DSH environment does not accept GIF attachments, so nothing was requested. '
        + 'Omit the gif parameter to generate a PNG instead.'
      : 'PNG image attachments are not enabled in this DSH environment.',
    'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED',
  )
}

/**
 * Build the wire body of one request.
 *
 * Field order and the defaults are deliberate: a call with no new options
 * produces exactly `prompt/background auto/model/quality auto/size auto`, which
 * is the body this tool has always sent. Every new field appears only when the
 * caller stated it, so an old call site keeps its old bytes on the wire.
 */
function buildImageBody(request: ImageRequestBody): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    background: request.transparentBackground === true
      ? 'transparent'
      : request.transparentBackground === false ? 'opaque' : 'auto',
    model: CODEX_IMAGE_MODEL,
    quality: request.quality,
    size: request.size,
  }
  if (request.gif !== undefined) {
    // The animated-GIF fields are TOP-LEVEL on the wire. A nested `output`
    // object is not what the endpoint reads, so a nested shape would silently
    // produce a still image.
    body.output_format = 'gif'
    if (request.gif.frameCount !== undefined) body.frame_count = request.gif.frameCount
    if (request.gif.frameDurationMs !== undefined) body.frame_duration_ms = request.gif.frameDurationMs
  }
  if (request.references.length > 0) {
    // An edit carries its inputs as inline data URLs in a JSON `images` array -
    // not as multipart form data, which this endpoint does not accept.
    body.images = request.references.map(image => ({
      image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
    }))
  }
  return body
}

/** The optional arguments a 400 message has to name back to the caller. */
interface StatedParameters {
  size?: string
  quality?: string
  transparentBackground?: boolean
}

/**
 * The optional parameters one request actually stated, in words.
 *
 * A 400 says only that the request was invalid, which is useless on a tool with
 * seven parameters: the caller has to be told WHICH ones it sent, or it has no
 * way to know what to change. Only stated options are named - a default that the
 * tool has always sent cannot be the field to fix - and each GIF sub-field is
 * named separately, because `gif: {}` is a legal call that stated neither number.
 */
function statedParameterSummary(
  args: StatedParameters,
  gif: GifOptions | undefined,
  referenceCount: number,
): string {
  const stated: string[] = []
  if (args.size !== undefined) stated.push(`size=${args.size}`)
  if (args.quality !== undefined) stated.push(`quality=${args.quality}`)
  if (args.transparentBackground !== undefined) {
    stated.push(`transparentBackground=${String(args.transparentBackground)}`)
  }
  if (referenceCount > 0) {
    stated.push(`referenceImagePaths (${referenceCount} image${referenceCount === 1 ? '' : 's'})`)
  }
  if (gif !== undefined) {
    const frames: string[] = []
    if (gif.frameCount !== undefined) frames.push(`frameCount=${String(gif.frameCount)}`)
    if (gif.frameDurationMs !== undefined) frames.push(`frameDurationMs=${String(gif.frameDurationMs)}`)
    stated.push(frames.length === 0 ? 'gif (frame numbers left to the service)' : `gif (${frames.join(', ')})`)
  }
  return stated.length === 0 ? 'no optional parameter was stated' : stated.join(', ')
}

/**
 * Read and validate the reference images one edit request names.
 *
 * Every named file is checked as a local still image: the path must not be a
 * URL, the extension must be PNG/JPEG/WebP, the file must be a regular non-empty
 * file inside the attachment byte limits, and its leading bytes must match the
 * declared type. Nothing else on disk is read, and the returned bytes are the
 * ONLY image data that reaches the request.
 */
async function readReferenceImages(
  files: readonly string[],
  attachments: AttachmentStore,
): Promise<ReferenceImage[]> {
  if (files.length === 0) return []
  const limit = Math.min(MAX_CODEX_REFERENCE_IMAGES, attachments.imageLimits.maxImagesPerMessage)
  if (files.length > limit) {
    throw new HarnessError(
      `At most ${limit} reference images are accepted; ${files.length} were given.`,
      'CODEX_IMAGE_REFERENCE_LIMIT',
    )
  }
  const perImageBytes = attachments.imageLimits.maxImageBytes
  const totalBytes = attachments.imageLimits.maxMessageImageBytes
  const images: ReferenceImage[] = []
  let sentBytes = 0
  for (const [index, raw] of files.entries()) {
    const label = `referenceImagePaths[${index}]`
    const value = raw.trim()
    if (value === '') {
      throw new HarnessError(`${label} is empty; every reference image must name a local file.`, 'CODEX_IMAGE_REFERENCE_INVALID_PATH')
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) {
      throw new HarnessError(
        `${label} is a URL (${value}). Reference images must be local PNG, JPEG or WebP files; nothing is fetched.`,
        'CODEX_IMAGE_REFERENCE_INVALID_PATH',
      )
    }
    const extension = extname(value).toLowerCase()
    const mediaType = REFERENCE_EXTENSIONS[extension]
    if (mediaType === undefined) {
      throw new HarnessError(
        extension === '.gif'
          ? `${label} (${value}) is a GIF. Reference images must be still PNG, JPEG or WebP files; animated input is not part of the edit request.`
          : `${label} (${value}) is not a PNG, JPEG or WebP file (extension ${extension === '' ? '(none)' : `"${extension}"`}).`,
        'CODEX_IMAGE_REFERENCE_UNSUPPORTED',
      )
    }
    if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new HarnessError(
        `${label} is ${mediaType}, which this DSH environment does not accept as an attachment.`,
        'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED',
      )
    }
    const absolute = resolve(value)
    const stats = await stat(absolute).catch(() => undefined)
    if (stats === undefined) {
      throw new HarnessError(`${label} (${value}) does not exist or cannot be read.`, 'CODEX_IMAGE_REFERENCE_NOT_FOUND')
    }
    if (!stats.isFile()) {
      throw new HarnessError(
        `${label} (${value}) is not a regular file; pass a path to one PNG, JPEG or WebP file.`,
        'CODEX_IMAGE_REFERENCE_NOT_A_FILE',
      )
    }
    if (stats.size === 0) {
      throw new HarnessError(`${label} (${value}) is empty.`, 'CODEX_IMAGE_REFERENCE_EMPTY')
    }
    if (stats.size > perImageBytes) {
      // Checked against the stat, BEFORE the bytes are read: reading first and
      // comparing afterwards is the out-of-memory path this check prevents.
      throw new HarnessError(
        `${label} (${value}) is ${stats.size} bytes, above the ${perImageBytes} byte limit for one attachment.`,
        'CODEX_IMAGE_REFERENCE_TOO_LARGE',
      )
    }
    const data = new Uint8Array(await readFile(absolute))
    if (!SIGNATURES[mediaType](data)) {
      throw new HarnessError(
        `${label} (${value}) does not start like a ${mediaType} file, so its bytes contradict its extension.`,
        'CODEX_IMAGE_REFERENCE_INVALID_CONTENT',
      )
    }
    sentBytes += data.byteLength
    if (sentBytes > totalBytes) {
      throw new HarnessError(
        `The reference images total ${sentBytes} bytes, above the ${totalBytes} byte limit for one message.`,
        'CODEX_IMAGE_REFERENCE_TOO_LARGE',
      )
    }
    images.push({ mediaType, data })
  }
  return images
}

async function imageCredentials(oauth: OAuthService, force = false): Promise<StoredOAuthCredentials> {
  try {
    // A tool purpose: image generation is not metered against the Codex
    // rate-limit window, so an account cooling down after a chat 429 still
    // serves it. Asking as a request made a spent chat window disable the
    // image tool with a "credentials are required" message.
    return await oauth.credentials(force, { purpose: 'tool' })
  } catch (error) {
    const reason = error instanceof Error && error.message !== '' ? ` (${error.message})` : ''
    throw new HarnessError(
      `ChatGPT subscription credentials are required for Codex image generation.${reason}`,
      'CODEX_IMAGE_CREDENTIAL_MISSING',
      { cause: error },
    )
  }
}

function requestImage(
  fetchFn: FetchLike,
  credentials: StoredOAuthCredentials,
  url: string,
  body: Record<string, unknown>,
  turnId: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: {
      ...codexHeaders(credentials),
      accept: 'application/json',
      'content-type': 'application/json',
      'x-codex-image-turn-id': turnId,
    },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * The upstream error body, short enough to read in a message and stripped of
 * anything that must never be echoed: bearer credentials, base64 image payloads
 * and any long base64-shaped run.
 */
function upstreamExcerpt(text: string): string {
  const collapsed = text
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*/gi, 'data:<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
  return collapsed.length > MAX_UPSTREAM_EXCERPT_CHARS
    ? `${collapsed.slice(0, MAX_UPSTREAM_EXCERPT_CHARS)}…`
    : collapsed
}

function readBase64Image(value: unknown): string {
  const root = record(value)
  const data = Array.isArray(root?.data) ? root.data[0] : null
  const image = string(record(data)?.b64_json)
    ?? string(record(data)?.image_base64)
    ?? string(root?.b64_json)
    ?? string(root?.image)
  if (image === null) throw new HarnessError('Codex image response did not include image data.', 'CODEX_IMAGE_RESPONSE_INVALID')
  return image
}

/**
 * Decode one returned image and identify it by its own magic bytes.
 *
 * The endpoint answers a requested GIF with GIF bytes in the same `b64_json`
 * field it uses for PNG, and states nothing about which one it produced, so the
 * bytes are the only reliable source for the media type – and storing a GIF
 * under `image/png` would fail at save time or, worse, mislabel the file.
 */
function decodeImageBytes(base64: string, maxBytes: number): { mediaType: OutputMediaType; data: Uint8Array } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new HarnessError('Codex image response was not valid base64.', 'CODEX_IMAGE_RESPONSE_INVALID')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > maxBytes) throw new HarnessError('Generated image exceeds the configured attachment size limit.', 'CODEX_IMAGE_TOO_LARGE')
  if (SIGNATURES['image/gif'](buffer)) return { mediaType: 'image/gif', data: buffer }
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[index] !== byte) throw new HarnessError('Codex image response was neither PNG nor GIF image data.', 'CODEX_IMAGE_RESPONSE_INVALID')
  }
  return { mediaType: 'image/png', data: buffer }
}

function maxGeneratedImageBytes(attachments: AttachmentStore): number {
  return Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}
