/**
 * Tool that attaches a video for the next Kimi Code request.
 *
 * DSH's attachment service stores images only and no DSH surface can produce a
 * video block, so this route supplies its own ingress. The bytes are committed
 * to the plugin's video store and then injected into the conversation as a
 * plugin-sourced user message, which is the same mechanism this plugin already
 * uses to return a generated image to the model.
 *
 * Two sources are accepted:
 *
 * - an absolute local path, read straight from disk;
 * - an http(s) URL, fetched through the deployment's proxy-aware fetch and
 *   checked against the same public-address policy the search/fetch provider
 *   uses, so this cannot become an SSRF primitive against the local network.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertPublicFetchTarget, lookupHostAddresses } from '../fetch-address-policy.ts'
import { MAX_VIDEO_FILE_BYTES, mediaTypeForPath, saveVideo, VideoIngestError } from './video-store.ts'

export const KIMI_VIDEO_TOOL_NAME = 'kimi_attach_video'

type FetchLike = typeof fetch

export interface KimiVideoToolOptions {
  fetchFn?: FetchLike
}

/**
 * Provider route this tool attaches videos for.
 *
 * A video block is this plugin's own extension to DSH's content vocabulary, so
 * injecting one while a different provider serves the session would hand that
 * adapter a block it has no case for. The tool therefore refuses unless the
 * routed provider is this one, which is the same contract `read_image` states
 * for a modality the active model does not declare.
 */
const KIMI_CODE_PROVIDER = 'kimi-code'

/**
 * Refuse when the session's routed model cannot accept video.
 *
 * Mirrors `read_image`'s capability gate: the point is to fail here with a
 * remedy ("switch to k3") rather than send a block the route will reject or,
 * worse, silently drop.
 */
async function assertVideoCapableRoute(ctx: Context, exec: { signal?: AbortSignal } & Record<string, unknown>, source: string): Promise<void> {
  const agent = exec.agent as { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } } | undefined
  const routed = agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  if (provider === undefined || model === undefined) {
    throw new HarnessError(
      `cannot attach "${source}": the current model route could not be resolved`,
      'KIMI_VIDEO_ROUTE_UNRESOLVED',
    )
  }
  if (provider !== KIMI_CODE_PROVIDER) {
    throw new HarnessError(
      `cannot attach "${source}": video input is only wired for the ${KIMI_CODE_PROVIDER} provider, and this session is routed to "${provider}"`,
      'KIMI_VIDEO_WRONG_PROVIDER',
    )
  }
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new HarnessError(`cannot attach "${source}": the LLM service is unavailable`, 'KIMI_VIDEO_NO_LLM')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('video')) {
    throw new HarnessError(
      `cannot attach "${source}": model "${model}" does not accept video input; switch to k3 or kimi-for-coding`,
      'KIMI_VIDEO_MODEL_UNSUPPORTED',
    )
  }
}

function humanBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Read one local file, refusing anything that is not a regular file. */
async function readLocalFile(input: string): Promise<{ data: Uint8Array; name: string; type: string }> {
  if (!path.isAbsolute(input)) {
    throw new HarnessError(`video path must be absolute: ${input}`, 'KIMI_VIDEO_PATH_NOT_ABSOLUTE')
  }
  const stats = await fs.stat(input).catch(() => undefined)
  if (stats === undefined) {
    throw new HarnessError(`video file not found: ${input}`, 'KIMI_VIDEO_NOT_FOUND')
  }
  if (!stats.isFile()) {
    throw new HarnessError(`video path is not a regular file: ${input}`, 'KIMI_VIDEO_NOT_A_FILE')
  }
  // Checked before reading so an oversized file is never buffered.
  if (stats.size > MAX_VIDEO_FILE_BYTES) {
    throw new HarnessError(
      `video is ${humanBytes(stats.size)}, above the ${humanBytes(MAX_VIDEO_FILE_BYTES)} limit this route sends`,
      'KIMI_VIDEO_TOO_LARGE',
    )
  }
  const type = mediaTypeForPath(input)
  if (type === undefined) {
    throw new HarnessError(
      `unsupported video extension "${path.extname(input)}"; supported: .mp4 .m4v .webm .mov .avi .mpeg .mpg .flv .wmv .3gp`,
      'KIMI_VIDEO_TYPE_UNSUPPORTED',
    )
  }
  return { data: await fs.readFile(input), name: path.basename(input), type }
}

/**
 * Fetch one http(s) video after proving the destination is public.
 *
 * The address policy is applied before the request, for the same reason the
 * search/fetch provider applies it: without it a URL argument would let a
 * caller reach loopback and private-range services through this tool.
 */
async function fetchRemoteVideo(
  url: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array; name: string; type: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HarnessError(`video URL is not a valid URL: ${url}`, 'KIMI_VIDEO_URL_INVALID')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HarnessError(
      `video URL must be http or https, got "${parsed.protocol}"`,
      'KIMI_VIDEO_URL_INVALID',
    )
  }
  // The shared resolver is reused rather than a local lookup, so a change to
  // how this deployment resolves names reaches every consumer at once.
  const addresses = await lookupHostAddresses(parsed.hostname).catch(() => [] as readonly string[])
  // Throws WebError WEB_BLOCKED_URL for a private destination, including a
  // name this machine resolves into private space.
  assertPublicFetchTarget(parsed.hostname, addresses)

  const response = await fetchFn(url, { redirect: 'error', signal })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError(`video download failed (${response.status})`, 'KIMI_VIDEO_FETCH_FAILED')
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_VIDEO_FILE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new HarnessError(
      `video is ${humanBytes(declared)}, above the ${humanBytes(MAX_VIDEO_FILE_BYTES)} limit this route sends`,
      'KIMI_VIDEO_TOO_LARGE',
    )
  }
  const data = new Uint8Array(await response.arrayBuffer())
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim()
  const type = headerType !== undefined && headerType.startsWith('video/')
    ? headerType
    : mediaTypeForPath(parsed.pathname)
  const name = decodeURIComponent(parsed.pathname.split('/').pop() ?? '') || 'video'
  return { data, name, type: type ?? '' }
}

export function createKimiVideoTool(ctx: Context, options: KimiVideoToolOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch
  return defineTool({
    name: KIMI_VIDEO_TOOL_NAME,
    description:
      'Attach a video to the conversation for models that accept video input (Kimi k3 and '
      + 'kimi-for-coding). Use this when the user asks about a video file or a video URL: pass an '
      + 'absolute local path or an http(s) URL. The video is sent to the model on the next request; '
      + 'it does not work on image-only models such as k3-256k.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Absolute local file path, or an http(s) URL, of the video to attach.',
      },
      question: {
        type: 'string',
        description: 'Optional question to ask about the video, answered on the next turn.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          attachmentId: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as { source: string; mediaType: string; bytes: number }
        return [{
          type: 'text',
          text: `Attached video ${output.source} (${output.mediaType}, ${humanBytes(output.bytes)}).`,
        }]
      },
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      kind: 'other',
      title: 'Attach video',
      rawInput: args,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Video attach failed' : 'Video attached',
      content: result.content,
    }),
    async execute(args, exec) {
      const source = args.source.trim()
      if (source === '') {
        throw new HarnessError('video source cannot be empty', 'KIMI_VIDEO_SOURCE_EMPTY')
      }
      // Refused before any bytes are read or fetched, so a wrong route costs
      // nothing and the caller is told the remedy.
      await assertVideoCapableRoute(ctx, exec as never, source)
      const isUrl = /^https?:\/\//i.test(source)
      const loaded = isUrl
        ? await fetchRemoteVideo(source, fetchFn, exec.signal)
        : await readLocalFile(source)

      let ref
      try {
        ref = await saveVideo({
          data: loaded.data,
          declaredType: loaded.type === '' ? undefined : loaded.type,
          name: loaded.name,
        })
      } catch (error) {
        if (error instanceof VideoIngestError) {
          throw new HarnessError(error.message, `KIMI_${error.code}`)
        }
        throw error
      }

      const question = typeof args.question === 'string' ? args.question.trim() : ''
      // The video rides as a plugin-sourced user message, which is how a
      // request receives content no user turn produced. The question is sent
      // alongside it so the model answers about the clip in the same turn.
      exec.deferContext(createUserMessage({
        content: [
          { type: 'video', attachment: ref } as unknown as ContentBlock,
          ...(question === '' ? [] : [{ type: 'text' as const, text: question }]),
        ],
        source: {
          kind: 'plugin',
          plugin: 'dsh-chatgpt-subscription',
          form: 'notice',
          summary: `Attached video ${loaded.name} for the next request.`,
        },
      }))

      return {
        source: loaded.name,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        attachmentId: ref.attachmentId,
      }
    },
  })
}
