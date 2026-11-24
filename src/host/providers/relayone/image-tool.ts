import fs from 'node:fs/promises'
import path from 'node:path'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RELAYONE_IMAGE_TOOL_NAME } from '../../../shared/relayone-contracts.ts'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../../common/llm-compat.ts'
import { assertPublicFetchTarget, lookupHostAddresses } from '../../infra/network/fetch-address-policy.ts'
import {
  relayOneMediaCredential,
  relayOneMediaError,
  relayOneMediaOptions,
  relayOneRecord,
  relayOneSleep,
  relayOneText,
  resolveRelayOneMediaModel,
  type RelayOneMediaStores,
} from './media-shared.ts'
import {
  RELAYONE_IMAGES_URL,
  RELAYONE_IMAGE_EDITS_URL,
  RELAYONE_TASKS_URL,
  relayOneHeaders,
  relayOneSafeDetail,
} from './types.ts'

const MAX_REFERENCES = 5
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_REMOTE_REDIRECTS = 3
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export interface RelayOneImageToolOptions {
  fetchFn?: typeof fetch
  pollIntervalMs?: number
  generationBudgetMs?: number
}
interface ImageReference { data: Uint8Array; mediaType: ImageMediaType; name: string }
interface GeneratedImageOutput { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }

function sniffImage(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && String.fromCharCode(...data.slice(0, 4)) === 'RIFF' && String.fromCharCode(...data.slice(8, 12)) === 'WEBP') return 'image/webp'
  if (data.length >= 6 && String.fromCharCode(...data.slice(0, 3)) === 'GIF') return 'image/gif'
  return undefined
}
function mediaTypeForReference(name: string): ImageMediaType | undefined {
  const ext = path.extname(name).toLowerCase()
  return ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : undefined
}
async function readReferences(inputs: unknown): Promise<ImageReference[]> {
  if (inputs === undefined) return []
  if (!Array.isArray(inputs) || inputs.some(value => typeof value !== 'string')) throw new HarnessError('referenceImagePaths must be an array of local paths.', 'RELAYONE_IMAGE_REFERENCES_INVALID')
  if (inputs.length > MAX_REFERENCES) throw new HarnessError('At most ' + MAX_REFERENCES + ' reference images are accepted.', 'RELAYONE_IMAGE_REFERENCES_TOO_MANY')
  const result: ImageReference[] = []
  for (const input of inputs as string[]) {
    const resolved = path.resolve(input.trim())
    const stat = await fs.stat(resolved).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) throw new HarnessError('Reference image is not a regular file: ' + input, 'RELAYONE_IMAGE_REFERENCE_NOT_FILE')
    if (stat.size > MAX_REFERENCE_BYTES) throw new HarnessError('Reference image exceeds the 10 MB limit: ' + input, 'RELAYONE_IMAGE_REFERENCE_TOO_LARGE')
    const declared = mediaTypeForReference(resolved)
    const data = await fs.readFile(resolved)
    const actual = sniffImage(data)
    if (declared === undefined || actual !== declared || actual === 'image/gif') throw new HarnessError('Reference images must be valid PNG, JPEG or WebP files: ' + input, 'RELAYONE_IMAGE_REFERENCE_TYPE')
    result.push({ data, mediaType: actual, name: path.basename(resolved) })
  }
  return result
}
function imageTaskId(payload: unknown, header: string | null): string | undefined {
  const root = relayOneRecord(payload)
  const data = relayOneRecord(root?.data)
  const rows = Array.isArray(root?.data) ? root.data : []
  const first = relayOneRecord(rows[0])
  return relayOneText(first?.task_id) ?? relayOneText(data?.task_id) ?? relayOneText(root?.task_id) ?? relayOneText(header) ?? undefined
}
function imageUrlsFromTask(payload: unknown): string[] {
  const root = relayOneRecord(payload)
  const data = relayOneRecord(root?.data) ?? root
  const result = relayOneRecord(data?.result)
  const resultData = relayOneRecord(result?.data)
  const candidates = [resultData?.image_urls, result?.image_urls, data?.image_urls]
  const urls = candidates.flatMap(value => Array.isArray(value) ? value : []).filter((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value))
  const grid = relayOneText(resultData?.grid_image_url) ?? relayOneText(result?.grid_image_url)
  if (urls.length === 0 && grid !== undefined) urls.push(grid)
  return [...new Set(urls)]
}
function taskState(payload: unknown): string {
  const root = relayOneRecord(payload)
  const data = relayOneRecord(root?.data) ?? root
  return (relayOneText(data?.status) ?? relayOneText(root?.status) ?? '').toLowerCase()
}
async function fetchPublicImage(url: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Uint8Array> {
  let current = new URL(url)
  for (let redirects = 0; redirects <= MAX_REMOTE_REDIRECTS; redirects += 1) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new HarnessError('Generated image URL must be HTTP(S).', 'RELAYONE_IMAGE_URL_INVALID')
    const addresses = await lookupHostAddresses(current.hostname).catch(() => [])
    assertPublicFetchTarget(current.hostname, addresses)
    const response = await fetchFn(current, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (location === null) throw new HarnessError('Generated image redirect omitted Location.', 'RELAYONE_IMAGE_REDIRECT_INVALID')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw await relayOneMediaError(response, 'image download')
    const declared = Number(response.headers.get('content-length') ?? '')
    const max = 25 * 1024 * 1024
    if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => undefined); throw new HarnessError('Generated image exceeds 25 MB.', 'RELAYONE_IMAGE_TOO_LARGE') }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength === 0 || data.byteLength > max) throw new HarnessError('Generated image is empty or exceeds 25 MB.', 'RELAYONE_IMAGE_TOO_LARGE')
    if (sniffImage(data) === undefined) throw new HarnessError('Generated image response is not a supported PNG/JPEG/WebP/GIF.', 'RELAYONE_IMAGE_RESPONSE_TYPE')
    return data
  }
  throw new HarnessError('Generated image exceeded the redirect limit.', 'RELAYONE_IMAGE_REDIRECT_LIMIT')
}
async function pollImageTask(
  taskId: string,
  apiKey: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  intervalMs: number,
  budgetMs: number,
): Promise<string[]> {
  const deadline = Date.now() + budgetMs
  while (Date.now() <= deadline) {
    const response = await fetchFn(RELAYONE_TASKS_URL + '/' + encodeURIComponent(taskId), { headers: relayOneHeaders(apiKey, false), signal })
    if (!response.ok) throw await relayOneMediaError(response, 'image task query', apiKey)
    const payload = await response.json() as unknown
    const state = taskState(payload)
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(state)) {
      const urls = imageUrlsFromTask(payload)
      if (urls.length === 0) throw new HarnessError('RelayOne image task completed without an image URL.', 'RELAYONE_IMAGE_TASK_EMPTY')
      return urls
    }
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(state)) {
      const root = relayOneRecord(payload)
      const data = relayOneRecord(root?.data) ?? root
      throw new HarnessError(relayOneSafeDetail(relayOneText(data?.error_message) ?? relayOneText(data?.error) ?? 'RelayOne image task failed.', apiKey), 'RELAYONE_IMAGE_TASK_FAILED')
    }
    if (Date.now() + intervalMs > deadline) break
    await relayOneSleep(intervalMs, signal)
  }
  throw new HarnessError('RelayOne image task did not finish before the local deadline; the task was not resubmitted.', 'RELAYONE_IMAGE_TASK_TIMEOUT')
}

export function createRelayOneImageTool(attachments: AttachmentStore, stores: RelayOneMediaStores, options: RelayOneImageToolOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch
  return defineTool({
    name: RELAYONE_IMAGE_TOOL_NAME,
    description: 'Generate or edit images through the configured RelayOne key. Use the accessible default image model or name another from the RelayOne settings. Supports PNG/JPEG/WebP reference images, URL/base64 results and asynchronous image tasks. Do not create a subagent for a bare image generation call.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed image prompt or edit instruction.' },
      model: { type: 'string', description: 'Optional accessible RelayOne image model; defaults to the line setting.' },
      size: { type: 'string', description: 'Output size or aspect ratio accepted by the selected model, for example 1024x1024 or 16:9.' },
      quality: { type: 'string', description: 'Optional model-specific quality string; sent verbatim.' },
      n: { type: 'integer', description: 'Number of images, from 1 through 4. Midjourney may still return its fixed four-image grid.' },
      referenceImagePaths: { type: 'array', items: { type: 'string' }, description: 'Up to 5 local PNG/JPEG/WebP files to edit. Their presence switches to /v1/images/edits.' },
      options: { type: 'object', additionalProperties: true, description: 'Additional model-specific JSON fields; dedicated arguments cannot be overridden.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        prompt: { type: 'string', required: true }, model: { type: 'string', required: true },
        images: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
        } } },
      } },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as { prompt: string; images: GeneratedImageOutput[] }
        return [
          { type: 'text', text: 'Generated ' + output.images.length + ' image(s) with RelayOne for: ' + output.prompt },
          ...output.images.map(image => ({ type: 'image', attachment: image as unknown as ImageAttachmentRef } as ContentBlock)),
        ]
      },
    },
    timeoutMs: 15 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'other', title: 'Generate image with RelayOne', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'RelayOne image generation failed' : 'RelayOne image generated', content: result.content }),
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new HarnessError('Image prompt cannot be empty.', 'RELAYONE_IMAGE_PROMPT_EMPTY')
      const apiKey = await relayOneMediaCredential(stores)
      const model = await resolveRelayOneMediaModel(stores, 'image', typeof args.model === 'string' ? args.model : undefined)
      const references = await readReferences(args.referenceImagePaths)
      const n = args.n === undefined ? 1 : args.n
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new HarnessError('n must be an integer from 1 through 4.', 'RELAYONE_IMAGE_N_INVALID')
      const extra = relayOneMediaOptions(args.options, ['model', 'prompt', 'size', 'quality', 'n', 'image'])
      const body: Record<string, unknown> = {
        ...extra, model: model.id, prompt, n,
        ...(typeof args.size === 'string' && args.size.trim() ? { size: args.size.trim() } : {}),
        ...(typeof args.quality === 'string' && args.quality.trim() ? { quality: args.quality.trim() } : {}),
      }
      let response: Response
      if (references.length > 0) {
        const form = new FormData()
        for (const [key, value] of Object.entries(body)) form.append(key, ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : JSON.stringify(value))
        for (const reference of references) form.append('image', new Blob([reference.data], { type: reference.mediaType }), reference.name)
        response = await fetchFn(RELAYONE_IMAGE_EDITS_URL, { method: 'POST', headers: relayOneHeaders(apiKey, false), body: form, signal: exec.signal })
      } else {
        response = await fetchFn(RELAYONE_IMAGES_URL, { method: 'POST', headers: relayOneHeaders(apiKey), body: JSON.stringify(body), signal: exec.signal })
      }
      if (!response.ok) throw await relayOneMediaError(response, references.length > 0 ? 'image edit' : 'image generation', apiKey)
      const payload = await response.json() as unknown
      const taskId = imageTaskId(payload, response.headers.get('x-newapi-task-id'))
      const root = relayOneRecord(payload)
      const rows = Array.isArray(root?.data) ? root.data : []
      const rawImages: Uint8Array[] = []
      const remoteUrls: string[] = []
      for (const raw of rows) {
        const item = relayOneRecord(raw)
        const base64 = relayOneText(item?.b64_json)
        if (base64 !== undefined) {
          const data = new Uint8Array(Buffer.from(base64, 'base64'))
          if (sniffImage(data) === undefined) throw new HarnessError('RelayOne returned invalid base64 image data.', 'RELAYONE_IMAGE_RESPONSE_TYPE')
          rawImages.push(data)
        }
        const url = relayOneText(item?.url)
        if (url !== undefined) remoteUrls.push(url)
      }
      if (taskId !== undefined && rawImages.length === 0 && remoteUrls.length === 0) {
        remoteUrls.push(...await pollImageTask(taskId, apiKey, fetchFn, exec.signal, options.pollIntervalMs ?? 3000, options.generationBudgetMs ?? 600_000))
      }
      for (const url of remoteUrls) rawImages.push(await fetchPublicImage(url, fetchFn, exec.signal))
      if (rawImages.length === 0) throw new HarnessError('RelayOne returned neither image data nor an asynchronous task id.', 'RELAYONE_IMAGE_RESPONSE_EMPTY')
      const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const images: GeneratedImageOutput[] = []
      for (const data of rawImages) {
        if (data.byteLength > maxBytes) throw new HarnessError('Generated image exceeds this DSH attachment budget.', 'RELAYONE_IMAGE_TOO_LARGE')
        const mediaType = sniffImage(data)!
        if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new HarnessError('This DSH environment does not accept ' + mediaType + ' attachments.', 'RELAYONE_IMAGE_ATTACHMENT_UNSUPPORTED')
        const saved = await attachments.saveImage({ data, mediaType, name: 'relayone-generated.' + (mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1]) })
        images.push({ attachmentId: saved.attachmentId, mediaType, bytes: saved.bytes, width: saved.width, height: saved.height, ...(saved.name ? { name: saved.name } : {}) })
      }
      if (exec.parent !== undefined) exec.deferContext(createUserMessage({
        content: images.map(image => ({ type: 'image', attachment: image as unknown as ImageAttachmentRef } as ContentBlock)),
        source: { kind: PLUGIN_MESSAGE_SOURCE_KIND, form: 'notice', summary: 'Generated images from RelayOne.' },
      }))
      return { prompt, model: model.id, images }
    },
  })
}
