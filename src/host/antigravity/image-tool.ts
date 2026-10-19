import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ANTIGRAVITY_IMAGE_MODEL, ANTIGRAVITY_IMAGE_TOOL_NAME } from '../../compat.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'
import { AccountPoolStore } from './account-pool.ts'
import { retryDelayMs, upstreamBodyExcerpt } from './adapter.ts'
import { antigravityHeaders, endpointCandidates } from './client.ts'
import { ensureApiKey } from './oauth.ts'
import { FileCredentialStore } from './token-store.ts'

type FetchLike = typeof fetch

/**
 * Aspect ratios Gemini image models accept in `imageConfig.aspectRatio`.
 * Omitted, the model picks one itself, which is what the request then does.
 */
export const ANTIGRAVITY_IMAGE_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const

/** Images one call keeps; the model normally returns one. */
const MAX_IMAGES_PER_CALL = 4

export interface AntigravityImageToolOptions {
  fetchFn?: FetchLike
  /** Whether the Antigravity line is switched on; a switched-off line serves no images. */
  isEnabled?: () => boolean
}

interface GeneratedImageRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

interface ImageOutput {
  prompt: string
  model: string
  text?: string
  images: GeneratedImageRef[]
}

/** One image part the model returned, still base64. */
export interface InlineImage {
  mimeType: string
  data: string
}

/** What one image response carried, gathered across every SSE frame. */
export interface ImageResponse {
  images: InlineImage[]
  text: string
  finishReason?: string
  finishMessage?: string
}

/**
 * The `v1internal` envelope for one image generation.
 *
 * Deliberately bare next to the chat request: no system instruction, no tools
 * and no thinking config. An image runtime has nothing to do with the coding
 * agent persona or tool declarations, and `responseModalities` is what asks it
 * for pixels at all. `requestType: 'image_gen'` follows what community
 * Antigravity clients send for image runtimes; it has not been captured from
 * the official client.
 */
export function buildImageRequest(
  prompt: string,
  projectId: string,
  aspectRatio?: string,
): Record<string, unknown> {
  return {
    project: projectId,
    model: ANTIGRAVITY_IMAGE_MODEL,
    request: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
      },
    },
    requestType: 'image_gen',
    userAgent: 'antigravity',
    requestId: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Collect the images and visible text of one SSE image response.
 *
 * Parts marked `thought: true` are skipped, images included: an image model can
 * stream interim drafts as thoughts, and only the final picture is the answer.
 *
 * @throws HarnessError when a frame carries an upstream error.
 */
export function parseImageResponse(body: string): ImageResponse {
  const result: ImageResponse = { images: [], text: '' }
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const json = trimmed.slice(5).trim()
    if (json === '' || json === '[DONE]') continue
    let frame: unknown
    try { frame = JSON.parse(json) } catch { continue }
    const root = record(frame)
    const response = record(root?.response) ?? root
    const error = record(root?.error) ?? record(response?.error)
    if (error) {
      throw new HarnessError(
        `Antigravity image generation failed: ${string(error.message) ?? 'unknown error'}`,
        'ANTIGRAVITY_IMAGE_FAILED',
      )
    }
    const candidate = record(Array.isArray(response?.candidates) ? response!.candidates[0] : undefined)
    const parts = Array.isArray(record(candidate?.content)?.parts) ? record(candidate?.content)!.parts as unknown[] : []
    for (const raw of parts) {
      const part = record(raw)
      if (!part || part.thought === true) continue
      const inline = record(part.inlineData) ?? record(part.inline_data)
      const data = string(inline?.data)
      if (inline && data) {
        result.images.push({ mimeType: string(inline.mimeType) ?? string(inline.mime_type) ?? 'image/png', data })
        continue
      }
      if (typeof part.text === 'string') result.text += part.text
    }
    const blockReason = string(record(response?.promptFeedback)?.blockReason)
    result.finishReason = string(candidate?.finishReason) ?? (blockReason ? `PROMPT_BLOCKED:${blockReason}` : result.finishReason)
    result.finishMessage = string(candidate?.finishMessage) ?? result.finishMessage
  }
  result.text = result.text.trim()
  return result
}

const SIGNATURES: Record<ImageMediaType, (bytes: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
}

const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

/**
 * Decode one returned image after checking it is the type it claims and fits
 * the attachment limits. A claim the bytes contradict is refused rather than
 * stored under the wrong type.
 */
export function decodeInlineImage(
  image: InlineImage,
  attachments: Pick<AttachmentStore, 'imageLimits'>,
): { mediaType: ImageMediaType; data: Uint8Array } {
  const mediaType = image.mimeType.toLowerCase() as ImageMediaType
  if (!(mediaType in SIGNATURES) || !attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new HarnessError(`Antigravity returned an image type this DSH environment does not accept (${image.mimeType}).`, 'ANTIGRAVITY_IMAGE_ATTACHMENT_UNSUPPORTED')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
    throw new HarnessError('Antigravity image response was not valid base64.', 'ANTIGRAVITY_IMAGE_RESPONSE_INVALID')
  }
  const data = Buffer.from(image.data, 'base64')
  const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  if (data.length > maxBytes) {
    throw new HarnessError('Generated image exceeds the configured attachment size limit.', 'ANTIGRAVITY_IMAGE_TOO_LARGE')
  }
  if (!SIGNATURES[mediaType](data)) {
    throw new HarnessError(`Antigravity image bytes do not match their declared type (${mediaType}).`, 'ANTIGRAVITY_IMAGE_RESPONSE_INVALID')
  }
  return { mediaType, data }
}

/** Why a response with no image produced none, in words the model can relay. */
function noImageMessage(response: ImageResponse): string {
  const reason = response.finishReason ? ` (finishReason: ${response.finishReason})` : ''
  const detail = response.finishMessage ?? response.text
  return `Antigravity returned no image${reason}.${detail ? ` Model said: ${detail}` : ''}`
}

/**
 * Generate an image through the signed-in Antigravity account pool.
 *
 * Shares the chat route's account rotation: the call draws on the Gemini
 * allowance, so an account whose Gemini allowance is cooling down is skipped and
 * a 429 cools that allowance alone (see AccountPoolStore.markFamilyCooldown).
 */
export function createAntigravityImageTool(
  accountPool: AccountPoolStore,
  store: FileCredentialStore,
  attachments: AttachmentStore,
  options: AntigravityImageToolOptions = {},
) {
  const fetchFn = options.fetchFn ?? fetch
  return defineTool({
    name: ANTIGRAVITY_IMAGE_TOOL_NAME,
    description: 'Generate an image with Gemini image generation through the signed-in Antigravity account. '
      + 'Describe the subject, style, composition and any text to render in the prompt.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed image generation prompt.',
      },
      aspectRatio: {
        type: 'string',
        enum: ANTIGRAVITY_IMAGE_ASPECT_RATIOS,
        description: 'Optional aspect ratio. Omit it to let the model choose.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          model: { type: 'string', required: true },
          text: { type: 'string' },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as ImageOutput
        return [
          { type: 'text', text: `Generated image for: ${output.prompt}${output.text ? `\n${output.text}` : ''}` },
          ...output.images.map((image) => ({ type: 'image', attachment: image as unknown as ImageAttachmentRef }) as ContentBlock),
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
      if (prompt === '') throw new HarnessError('Image prompt cannot be empty.', 'ANTIGRAVITY_IMAGE_INVALID_PROMPT')
      if (options.isEnabled?.() === false) {
        throw new HarnessError('The Antigravity line is switched off; enable it in Settings → Antigravity to generate images.', 'ANTIGRAVITY_IMAGE_DISABLED')
      }

      const response = await requestImage(accountPool, store, fetchFn, prompt, args.aspectRatio, exec.signal)
      if (response.images.length === 0) throw new HarnessError(noImageMessage(response), 'ANTIGRAVITY_IMAGE_EMPTY')

      const keep = Math.min(MAX_IMAGES_PER_CALL, attachments.imageLimits.maxImagesPerMessage, response.images.length)
      const saved: ImageAttachmentRef[] = []
      for (const [index, image] of response.images.slice(0, keep).entries()) {
        const { mediaType, data } = decodeInlineImage(image, attachments)
        const suffix = keep > 1 ? `-${index + 1}` : ''
        saved.push(await attachments.saveImage({
          data,
          mediaType,
          name: `antigravity-generated-image${suffix}.${EXTENSIONS[mediaType]}`,
        }))
      }

      const output: ImageOutput = {
        prompt,
        model: ANTIGRAVITY_IMAGE_MODEL,
        ...(response.text ? { text: response.text } : {}),
        images: saved.map((image) => ({
          attachmentId: String(image.attachmentId),
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...(image.name !== undefined ? { name: image.name } : {}),
        })),
      }
      // Same as the Codex image tool: a nested call is the only one whose image
      // reaches the next request, so it is injected as a notice.
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: saved.map((attachment) => ({ type: 'image', attachment }) as ContentBlock),
          source: {
            kind: PLUGIN_MESSAGE_SOURCE_KIND,
            form: 'notice',
            summary: 'Generated image from Antigravity image tool.',
          },
        }))
      }
      return output as unknown as never
    },
  })
}

async function acquireAccount(
  accountPool: AccountPoolStore,
  store: FileCredentialStore,
  tried: ReadonlySet<string>,
  fetchFn: FetchLike,
): Promise<{ account: { id: string }; token: string; projectId?: string }> {
  try {
    return await accountPool.getEffectiveAccountFor('gemini', tried, fetchFn)
  } catch (error) {
    // The pre-pool single credential, exactly as the chat route falls back to it.
    const pool = await accountPool.read().catch(() => null)
    if (pool && pool.accounts.length > 0) throw error
    try {
      const { token, projectId } = await ensureApiKey(store, fetchFn)
      return { account: { id: 'legacy' }, token, projectId }
    } catch (credentialError) {
      const reason = credentialError instanceof Error && credentialError.message !== '' ? ` (${credentialError.message})` : ''
      throw new HarnessError(`Antigravity sign-in is required for image generation.${reason}`, 'ANTIGRAVITY_IMAGE_CREDENTIAL_MISSING', { cause: credentialError })
    }
  }
}

async function requestImage(
  accountPool: AccountPoolStore,
  store: FileCredentialStore,
  fetchFn: FetchLike,
  prompt: string,
  aspectRatio: string | undefined,
  signal: AbortSignal,
): Promise<ImageResponse> {
  const tried = new Set<string>()
  while (true) {
    const { account, token, projectId } = await acquireAccount(accountPool, store, tried, fetchFn)
    tried.add(account.id)
    const body = JSON.stringify(buildImageRequest(prompt, projectId || 'antigravity-default', aspectRatio))

    let response: Response | undefined
    // The response this attempt reports. The FIRST endpoint that answers owns
    // it: a later endpoint replaces it only when it serves the request (ok) or
    // answers 400/404, and a later 429 never replaces it.
    let firstResponse: Response | undefined
    for (const endpoint of endpointCandidates()) {
      try {
        response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: antigravityHeaders(token),
          body,
          signal,
        })
        if (firstResponse === undefined) firstResponse = response
        if (response.ok || response.status === 400 || response.status === 404) break
        if (response.status === 429) {
          // A quota verdict from one endpoint is not improved by asking a
          // different one, and the prod endpoint answers every Antigravity
          // request with a permanent bare 429 that says nothing about the
          // account's allowance. The chain ends here, and the first
          // endpoint's outcome is what gets reported.
          response = firstResponse
          break
        }
        // Any other status (a 5xx): the next endpoint may still serve the
        // request, but the reported outcome stays the first endpoint's.
        response = firstResponse
      } catch (error) {
        if (signal.aborted) throw error
      }
    }

    if (response?.ok) return parseImageResponse(await response.text())

    const status = response?.status
    const errorText = await response?.text().catch(() => '') ?? ''
    if (status === 429 && response) {
      const statedWaitMs = retryDelayMs(response.headers, errorText)
      if (statedWaitMs !== undefined) {
        // A 429 that states when the allowance resets IS a verdict about this
        // account: only its Gemini allowance is spent. The upstream body
        // travels with the cooldown, so the next attempt can say WHY the
        // upstream refused.
        accountPool.markFamilyCooldown(
          account.id, 'gemini', statedWaitMs, '429 Rate Limit', upstreamBodyExcerpt(errorText),
        )
        if (await accountPool.hasAnotherAvailableAccountFor('gemini', tried)) continue
        throw new HarnessError(`Antigravity image generation was rate limited. ${errorText}`.trim(), 'ANTIGRAVITY_IMAGE_RATE_LIMITED')
      }
      // A 429 that states no reset time is NOT a verdict: the prod endpoint
      // answers every Antigravity request with a bare 429, so a bare 429
      // carries no information about this account's Gemini allowance. A quota
      // verdict needs evidence, so the allowance is not cooled and no other
      // account is tried.
      throw new HarnessError(
        `Antigravity image generation was rate limited (429) without a stated reset time, so it is handled as a transient rate limit rather than a spent quota. ${upstreamBodyExcerpt(errorText)}`.trim(),
        'ANTIGRAVITY_IMAGE_RATE_LIMITED',
      )
    }
    throw new HarnessError(
      `Antigravity image generation failed (${status ?? 'no response'}).${errorText ? ` ${errorText}` : ''}`,
      'ANTIGRAVITY_IMAGE_FAILED',
    )
  }
}
