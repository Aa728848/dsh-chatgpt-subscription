import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CODEX_ENHANCED_ORIGINATOR,
  CODEX_IMAGE_GENERATION_URL,
  CODEX_IMAGE_MODEL,
  CODEX_IMAGE_TOOL_NAME,
} from '../compat.ts'
import { OAuthService } from './oauth-service.ts'
import type { StoredOAuthCredentials } from './token-store.ts'
import { codexHeaders } from './wire-auth.ts'

type FetchLike = typeof fetch

export interface CodexImageToolOptions {
  fetchFn?: FetchLike
}

interface ImageOutput {
  prompt: string
  model: string
  image: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

export function createCodexImageTool(
  oauth: OAuthService,
  attachments: AttachmentStore,
  options: CodexImageToolOptions = {},
) {
  const fetchFn = options.fetchFn ?? fetch
  return defineTool({
    name: CODEX_IMAGE_TOOL_NAME,
    description: 'Generate a PNG image using the signed-in ChatGPT subscription-backed Codex image endpoint.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed image generation prompt.',
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
              mediaType: { type: 'string', enum: ['image/png'], required: true },
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
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new HarnessError('PNG image attachments are not enabled in this DSH environment.', 'CODEX_IMAGE_ATTACHMENT_UNSUPPORTED')
      }
      let credentials = await imageCredentials(oauth)
      let response = await requestImage(fetchFn, credentials, prompt, String(exec.callId), exec.signal)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        credentials = await imageCredentials(oauth, true)
        response = await requestImage(fetchFn, credentials, prompt, String(exec.callId), exec.signal)
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined)
        throw new HarnessError('Codex image generation was rate limited.', 'CODEX_IMAGE_RATE_LIMITED')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new HarnessError(`Codex image generation failed (${response.status}).`, 'CODEX_IMAGE_FAILED')
      }
      const data = await response.json() as unknown
      const bytes = decodeImageBytes(readBase64Image(data), maxGeneratedImageBytes(attachments))
      const image = await attachments.saveImage({
        data: bytes,
        mediaType: 'image/png',
        name: 'codex-generated-image.png',
      })
      const output = {
        prompt,
        model: CODEX_IMAGE_MODEL,
        image: {
          attachmentId: image.attachmentId,
          mediaType: 'image/png' as const,
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
            kind: 'plugin',
            plugin: 'dsh-chatgpt-subscription',
            form: 'notice',
            summary: 'Generated image from Codex image tool.',
          },
        }))
      }
      return output
    },
  })
}

async function imageCredentials(oauth: OAuthService, force = false): Promise<StoredOAuthCredentials> {
  try {
    return await oauth.credentials(force)
  } catch (error) {
    throw new HarnessError('ChatGPT subscription credentials are required for Codex image generation.', 'CODEX_IMAGE_CREDENTIAL_MISSING', { cause: error })
  }
}

function requestImage(
  fetchFn: FetchLike,
  credentials: StoredOAuthCredentials,
  prompt: string,
  turnId: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetchFn(CODEX_IMAGE_GENERATION_URL, {
    method: 'POST',
    headers: {
      ...codexHeaders(credentials),
      originator: CODEX_ENHANCED_ORIGINATOR,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-codex-image-turn-id': turnId,
    },
    body: JSON.stringify({
      prompt,
      background: 'auto',
      model: CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    }),
    signal,
  })
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

function decodeImageBytes(base64: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new HarnessError('Codex image response was not valid base64.', 'CODEX_IMAGE_RESPONSE_INVALID')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > maxBytes) throw new HarnessError('Generated image exceeds the configured attachment size limit.', 'CODEX_IMAGE_TOO_LARGE')
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[index] !== byte) throw new HarnessError('Codex image response was not a PNG image.', 'CODEX_IMAGE_RESPONSE_INVALID')
  }
  return buffer
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
