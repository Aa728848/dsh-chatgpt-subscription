import fs from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RELAYONE_VIDEO_TOOL_NAME } from '../../shared/relayone-contracts.ts'
import { assertPublicFetchTarget, lookupHostAddresses } from '../fetch-address-policy.ts'
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
import { RELAYONE_VIDEO_URL, relayOneHeaders, relayOneSafeDetail } from './types.ts'

const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const MAX_REDIRECTS = 3
export interface RelayOneVideoToolOptions {
  fetchFn?: typeof fetch
  pollIntervalMs?: number
  generationBudgetMs?: number
  now?: () => number
}
interface VideoOutput {
  videoPath: string
  mediaType: string
  bytes: number
  model: string
  taskId: string
  durationSeconds?: number
}
function deepRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  const root = relayOneRecord(value)
  if (root === null || depth > 7) return []
  const result = [root]
  for (const [key, child] of Object.entries(root)) {
    if (!['data', 'result', 'output', 'task', 'artifact', 'video', 'response'].includes(key)) continue
    if (Array.isArray(child)) for (const item of child) result.push(...deepRecords(item, depth + 1))
    else result.push(...deepRecords(child, depth + 1))
  }
  if (Array.isArray(root?.artifacts) && depth < 7) for (const item of root.artifacts) result.push(...deepRecords(item, depth + 1))
  return result
}
function videoTaskId(payload: unknown, header: string | null): string | undefined {
  for (const record of deepRecords(payload)) {
    const id = relayOneText(record.task_id) ?? relayOneText(record.taskId)
    if (id !== undefined) return id
  }
  const root = relayOneRecord(payload)
  const data = relayOneRecord(root?.data)
  if (data !== null && relayOneText(data.status) !== undefined) return relayOneText(data.id)
  return relayOneText(header) ?? undefined
}
function videoUrl(payload: unknown): string | undefined {
  const records = deepRecords(payload)
  for (const key of ['video_url', 'videoUrl', 'download_url', 'downloadUrl']) {
    for (const record of records) {
      const value = relayOneText(record[key])
      if (value !== undefined && /^https?:\/\//.test(value)) return value
    }
  }
  for (const record of records) {
    const value = relayOneText(record.url)
    if (value !== undefined && /^https?:\/\//.test(value)) return value
  }
  return undefined
}
function videoState(payload: unknown): string {
  for (const record of deepRecords(payload)) {
    const state = relayOneText(record.status) ?? relayOneText(record.state)
    if (state !== undefined) return state.toLowerCase()
  }
  return ''
}
function videoFailure(payload: unknown): string | undefined {
  for (const record of deepRecords(payload)) {
    const message = relayOneText(record.error_message) ?? relayOneText(record.errorMessage) ?? relayOneText(record.error) ?? relayOneText(record.message)
    if (message !== undefined) return message
  }
  return undefined
}
async function pollVideoTask(
  taskId: string,
  apiKey: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  intervalMs: number,
  budgetMs: number,
): Promise<string> {
  const deadline = Date.now() + budgetMs
  while (Date.now() <= deadline) {
    const response = await fetchFn(RELAYONE_VIDEO_URL + '/' + encodeURIComponent(taskId), { headers: relayOneHeaders(apiKey, false), signal })
    if (!response.ok) throw await relayOneMediaError(response, 'video task query', apiKey)
    const payload = await response.json() as unknown
    const state = videoState(payload)
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(state)) {
      const url = videoUrl(payload)
      if (url === undefined) throw new HarnessError('RelayOne video task completed without a video URL.', 'RELAYONE_VIDEO_TASK_EMPTY')
      return url
    }
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(state)) {
      throw new HarnessError(relayOneSafeDetail(videoFailure(payload) ?? 'RelayOne video task failed.', apiKey), 'RELAYONE_VIDEO_TASK_FAILED')
    }
    if (Date.now() + intervalMs > deadline) break
    await relayOneSleep(intervalMs, signal)
  }
  throw new HarnessError('RelayOne video task did not finish before the local deadline; the task was not resubmitted.', 'RELAYONE_VIDEO_TASK_TIMEOUT')
}
async function downloadVideo(url: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }> {
  let current = new URL(url)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new HarnessError('Generated video URL must be HTTP(S).', 'RELAYONE_VIDEO_URL_INVALID')
    const addresses = await lookupHostAddresses(current.hostname).catch(() => [])
    assertPublicFetchTarget(current.hostname, addresses)
    const response = await fetchFn(current, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (location === null) throw new HarnessError('Generated video redirect omitted Location.', 'RELAYONE_VIDEO_REDIRECT_INVALID')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw await relayOneMediaError(response, 'video download')
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) { await response.body?.cancel().catch(() => undefined); throw new HarnessError('Generated video exceeds 200 MB.', 'RELAYONE_VIDEO_TOO_LARGE') }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength === 0 || data.byteLength > MAX_VIDEO_BYTES) throw new HarnessError('Generated video is empty or exceeds 200 MB.', 'RELAYONE_VIDEO_TOO_LARGE')
    const header = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    const mediaType = header.startsWith('video/') ? header
      : /\.webm(?:$|\?)/i.test(current.pathname) ? 'video/webm'
        : /\.mov(?:$|\?)/i.test(current.pathname) ? 'video/quicktime' : 'video/mp4'
    return { data, mediaType }
  }
  throw new HarnessError('Generated video exceeded the redirect limit.', 'RELAYONE_VIDEO_REDIRECT_LIMIT')
}
async function workspaceRoot(ctx: Context, exec: { agent?: unknown; signal?: AbortSignal }): Promise<string> {
  const agent = exec.agent as { session?: { header?: { cwd?: string } } } | undefined
  if (agent !== undefined) {
    const service = ctx.get('workingDirectory') as { ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string> } | undefined
    if (typeof service?.ensure === 'function') {
      const root = await service.ensure(agent, exec.signal).catch(() => undefined)
      if (typeof root === 'string' && root.trim() !== '') return path.resolve(root)
    }
    const cwd = agent.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd)
  }
  throw new HarnessError('RelayOne video generation needs a session working directory so the resulting file can be opened.', 'RELAYONE_VIDEO_NO_WORKSPACE')
}
async function saveVideo(
  ctx: Context,
  exec: { agent?: unknown; signal?: AbortSignal },
  data: Uint8Array,
  mediaType: string,
  taskId: string,
  now: number,
): Promise<{ relativePath: string; bytes: number }> {
  const root = await workspaceRoot(ctx, exec)
  const directory = path.join(root, 'relayone-videos')
  const safeTask = taskId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64) || 'video'
  const extension = mediaType === 'video/webm' ? '.webm' : mediaType === 'video/quicktime' ? '.mov' : '.mp4'
  const name = 'relayone-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '-' + safeTask + extension
  const absolute = path.join(directory, name)
  if (path.dirname(absolute) !== directory || path.basename(absolute) !== name) throw new HarnessError('Generated video path escaped its workspace directory.', 'RELAYONE_VIDEO_BAD_PATH')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(absolute, data, { flag: 'wx' })
  return { relativePath: path.relative(root, absolute).split(path.sep).join('/'), bytes: data.byteLength }
}

export function createRelayOneVideoTool(ctx: Context, stores: RelayOneMediaStores, options: RelayOneVideoToolOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch
  const now = options.now ?? Date.now
  return defineTool({
    name: RELAYONE_VIDEO_TOOL_NAME,
    description: 'Generate a video through the configured RelayOne key. Submit once, poll the asynchronous task until it completes, then save the video into the session workspace. Use the accessible default video model or another model shown in RelayOne settings.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed video prompt including subject, action, camera and style.' },
      model: { type: 'string', description: 'Optional accessible RelayOne video model; defaults to the line setting.' },
      durationSeconds: { type: 'integer', description: 'Requested duration in seconds; validated by the upstream model.' },
      size: { type: 'string', description: 'Resolution or aspect ratio accepted by the selected model, for example 1280x720 or 16:9.' },
      options: { type: 'object', additionalProperties: true, description: 'Additional model-specific JSON fields; dedicated arguments cannot be overridden.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        videoPath: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
        model: { type: 'string', required: true }, taskId: { type: 'string', required: true }, durationSeconds: { type: 'integer' },
      } },
      render: (_args, value): ContentBlock[] => {
        const output = value as unknown as VideoOutput
        return [{ type: 'text', text: 'Generated video written to ' + output.videoPath + ' (' + output.mediaType + ', ' + output.bytes + ' bytes).' }]
      },
      presentationMeta: (_args, value) => {
        const output = value as unknown as VideoOutput
        return {
          videoPath: output.videoPath, mediaType: output.mediaType, bytes: output.bytes,
          model: output.model, taskId: output.taskId, ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
        }
      },
    },
    timeoutMs: 15 * 60_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'other', title: 'Generate video with RelayOne', rawInput: args }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'RelayOne video generation failed' : 'RelayOne video generated', content: result.content }),
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') throw new HarnessError('Video prompt cannot be empty.', 'RELAYONE_VIDEO_PROMPT_EMPTY')
      const apiKey = await relayOneMediaCredential(stores)
      const model = await resolveRelayOneMediaModel(stores, 'video', typeof args.model === 'string' ? args.model : undefined)
      const extra = relayOneMediaOptions(args.options, ['model', 'prompt', 'duration', 'size'])
      const body: Record<string, unknown> = {
        ...extra, model: model.id, prompt,
        ...(args.durationSeconds === undefined ? {} : { duration: args.durationSeconds }),
        ...(typeof args.size === 'string' && args.size.trim() ? { size: args.size.trim() } : {}),
      }
      const submitted = await fetchFn(RELAYONE_VIDEO_URL, { method: 'POST', headers: relayOneHeaders(apiKey), body: JSON.stringify(body), signal: exec.signal })
      if (!submitted.ok) throw await relayOneMediaError(submitted, 'video submission', apiKey)
      const payload = await submitted.json() as unknown
      const taskId = videoTaskId(payload, submitted.headers.get('x-newapi-task-id'))
      let url = videoUrl(payload)
      if (url === undefined) {
        if (taskId === undefined) throw new HarnessError('RelayOne video submission returned neither a task id nor a video URL.', 'RELAYONE_VIDEO_RESPONSE_EMPTY')
        url = await pollVideoTask(taskId, apiKey, fetchFn, exec.signal, options.pollIntervalMs ?? 5000, options.generationBudgetMs ?? 600_000)
      }
      const downloaded = await downloadVideo(url, fetchFn, exec.signal)
      const stored = await saveVideo(ctx, exec, downloaded.data, downloaded.mediaType, taskId ?? 'direct', now())
      return {
        videoPath: stored.relativePath, mediaType: downloaded.mediaType, bytes: stored.bytes,
        model: model.id, taskId: taskId ?? 'direct',
        ...(args.durationSeconds === undefined ? {} : { durationSeconds: args.durationSeconds }),
      }
    },
  })
}
