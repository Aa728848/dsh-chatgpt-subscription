/** MiniMax Code image and audio tools backed by the subscription Matrix gateway. */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { callMatrixTool, matrixPayloadField } from './matrix-client.ts'
import {
  MAX_AUDIO_FILE_BYTES, MAX_IMAGE_FILE_BYTES, downloadWorkspaceMedia, readWorkspaceMedia,
  uploadWorkspaceMedia, workspaceRootOf, writeWorkspaceText, type MatrixCredential,
} from './media-files.ts'
import { assertMinimaxRoute } from './video-tool.ts'

export const MINIMAX_GENERATE_IMAGE_TOOL_NAME = 'minimax_generate_image'
export const MINIMAX_SEARCH_IMAGES_TOOL_NAME = 'minimax_search_images'
export const MINIMAX_REVERSE_IMAGE_SEARCH_TOOL_NAME = 'minimax_reverse_image_search'
export const MINIMAX_LIST_VOICES_TOOL_NAME = 'minimax_list_voices'
export const MINIMAX_GENERATE_SPEECH_TOOL_NAME = 'minimax_generate_speech'
export const MINIMAX_GENERATE_MUSIC_TOOL_NAME = 'minimax_generate_music'
export const MINIMAX_UNDERSTAND_AUDIO_TOOL_NAME = 'minimax_understand_audio'
export const MINIMAX_TRANSCRIBE_AUDIO_TOOL_NAME = 'minimax_transcribe_audio'

const GENERATION_TIMEOUT_MS = 600_000
const UNDERSTAND_TIMEOUT_MS = 300_000
const MEDIA_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
} as const

export interface MinimaxMediaCredentialSource {
  getFreshCredential(accountId?: string, fetchFn?: typeof fetch): Promise<MatrixCredential>
}
export interface MinimaxMediaToolOptions {
  readonly fetchFn?: typeof fetch
  readonly pool: MinimaxMediaCredentialSource
}

type RecordValue = Record<string, unknown>
type Exec = { readonly agent?: unknown; readonly signal?: AbortSignal }

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is RecordValue => item !== undefined) : []
}
function requiredText(value: unknown, field: string): string {
  const result = text(value)
  if (result === undefined) throw new HarnessError(field + ' cannot be empty', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
  return result
}
function requestArray(value: unknown, maximum: number): RecordValue[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new HarnessError('requests must contain 1 through ' + maximum + ' items', 'MINIMAX_MEDIA_BATCH_INVALID')
  }
  return value.map((item, index) => {
    const row = record(item)
    if (row === undefined) throw new HarnessError('requests[' + index + '] must be an object', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
    return row
  })
}
function optionalNumber(row: RecordValue, key: string, minimum: number, maximum: number, integer = false): number | undefined {
  const value = row[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new HarnessError(key + ' must be ' + (integer ? 'an integer ' : '') + 'from ' + minimum + ' through ' + maximum, 'MINIMAX_MEDIA_ARGUMENT_INVALID')
  }
  return value
}
function slotIndex(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^slot_(\d+)\./.exec(value) : null
  return match === null ? undefined : Number(match[1])
}
function errorOf(item: RecordValue | undefined): string {
  return text(item?.error_msg) ?? text(item?.error) ?? text(item?.text_response) ?? 'unknown server error'
}
async function credentialFor(exec: Exec, options: MinimaxMediaToolOptions, action: string): Promise<MatrixCredential> {
  assertMinimaxRoute(exec, action)
  return options.pool.getFreshCredential(undefined, options.fetchFn ?? fetch)
}
async function invoke(
  credential: MatrixCredential, tool: string, body: RecordValue, options: MinimaxMediaToolOptions,
  exec: Exec, timeoutMs: number,
): Promise<RecordValue> {
  const response = await callMatrixTool({
    region: credential.region, accessToken: credential.accessToken, tool, body,
    fetchFn: options.fetchFn ?? fetch, timeoutMs, ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  })
  return response.body
}
function callPresentation(title: string) {
  return (args: unknown) => ({ card: 'generic' as const, kind: 'other' as const, title, rawInput: args })
}
function resultPresentation(title: string, failure: string) {
  return (_args: unknown, result: { isError?: boolean; content: ContentBlock[] }) => ({
    card: 'generic' as const, title: result.isError ? failure : title, content: result.content,
  })
}
function imageExtension(sourceUrl: string): string {
  try {
    const extension = new URL(sourceUrl).pathname.match(/\.[A-Za-z0-9]{1,5}$/)?.[0].toLowerCase()
    return extension !== undefined && ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(extension) ? extension : '.jpg'
  } catch { return '.jpg' }
}

function createImageGeneration(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_GENERATE_IMAGE_TOOL_NAME,
    description: 'Generate or edit up to 10 images with MiniMax H3 Image. Each request saves one PNG in the session workspace. Reference images are optional (up to 4 per request). Generation is billed; do not retry a refused call automatically. Only available on the minimax-code provider.',
    parameters: { requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      prompt: { type: 'string', required: true }, outputPath: { type: 'string', required: true, description: 'Workspace-relative .png output path.' },
      referenceImagePaths: { type: 'array', items: { type: 'string' }, description: 'Up to 4 workspace image paths.' },
      aspectRatio: { type: 'string', description: 'For example 16:9 or 1:1.' }, resolution: { type: 'string', enum: ['1K', '2K', '4K'] },
    } }, description: '1 through 10 image requests.' } },
    output: MEDIA_OUTPUT, timeoutMs: GENERATION_TIMEOUT_MS, isConcurrencySafe: () => false,
    presentCall: callPresentation('Generate images with MiniMax'),
    presentResult: resultPresentation('MiniMax images generated', 'MiniMax image generation failed'),
    async execute(args, exec) {
      const requests = requestArray(args.requests, 10)
      const credential = await credentialFor(exec, options, 'generate images')
      const root = await workspaceRootOf(ctx, exec)
      const wireRequests: RecordValue[] = []
      for (const [index, row] of requests.entries()) {
        const outputPath = requiredText(row.outputPath, 'outputPath')
        if (!outputPath.toLowerCase().endsWith('.png')) throw new HarnessError('image outputPath must end in .png', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        const references = Array.isArray(row.referenceImagePaths) ? row.referenceImagePaths : []
        if (references.length > 4) throw new HarnessError('at most 4 reference images are allowed per request', 'MINIMAX_MEDIA_BATCH_INVALID')
        const inputUrls: string[] = []
        for (const reference of references) {
          const local = await readWorkspaceMedia(root, requiredText(reference, 'referenceImagePaths'), 'image')
          inputUrls.push(await uploadWorkspaceMedia(credential, local, options.fetchFn ?? fetch, exec.signal))
        }
        wireRequests.push({
          prompt: requiredText(row.prompt, 'prompt'), output_file: 'slot_' + index + '.png',
          ...(inputUrls.length > 0 ? { input_urls: inputUrls } : {}),
          ...(text(row.aspectRatio) === undefined ? {} : { aspect_ratio: text(row.aspectRatio) }),
          ...(text(row.resolution) === undefined ? {} : { resolution: text(row.resolution) }),
        })
      }
      const body = await invoke(credential, 'image_synthesize', { requests: wireRequests }, options, exec, GENERATION_TIMEOUT_MS)
      const successful = records(matrixPayloadField(body, 'success_items'))
      const failed = records(matrixPayloadField(body, 'failed_items'))
      const files: JsonValue[] = []
      const failures: (JsonValue | undefined)[] = requests.map((row, index) => ({ index, outputPath: row.outputPath as string, error: 'server returned no result for this slot' }))
      for (const item of failed) {
        const index = slotIndex(item.output_file)
        if (index !== undefined && index < failures.length) failures[index] = { index, outputPath: requests[index].outputPath as string, error: errorOf(item) }
      }
      for (const item of successful) {
        const index = slotIndex(item.output_file)
        if (index === undefined || index >= requests.length) continue
        const sourceUrl = text(item.output_url)
        if (sourceUrl === undefined || item.has_image_output === false) {
          failures[index] = { index, outputPath: requests[index].outputPath as string, error: errorOf(item) }
          continue
        }
        try {
          const file = await downloadWorkspaceMedia(root, requests[index].outputPath as string, sourceUrl, options.fetchFn ?? fetch, exec.signal, MAX_IMAGE_FILE_BYTES)
          files.push({ index, ...file })
          failures.splice(index, 1, undefined)
        } catch (error) {
          failures[index] = { index, outputPath: requests[index].outputPath as string, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return { totalSucceeded: files.length, totalFailed: requests.length - files.length, files, failures: failures.filter((item): item is JsonValue => item !== undefined) }
    },
  })
}

function createImageSearch(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_SEARCH_IMAGES_TOOL_NAME,
    description: 'Search the web for images with MiniMax and download up to 10 results per query into workspace directories. Use this for image assets, not ordinary text web search. Only available on the minimax-code provider.',
    parameters: {
      queries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', required: true }, outputDir: { type: 'string', required: true }, prompt: { type: 'string' },
      } }, description: '1 through 10 image search queries.' },
      providers: { type: 'array', items: { type: 'string' }, description: 'Optional upstream providers, for example tencent or serper.' },
    },
    output: MEDIA_OUTPUT, timeoutMs: GENERATION_TIMEOUT_MS, isConcurrencySafe: () => true,
    presentCall: callPresentation('Search and download images with MiniMax'),
    presentResult: resultPresentation('MiniMax image search completed', 'MiniMax image search failed'),
    async execute(args, exec) {
      const queries = requestArray(args.queries, 10)
      const credential = await credentialFor(exec, options, 'search images')
      const root = await workspaceRootOf(ctx, exec)
      const providers = Array.isArray(args.providers) ? args.providers.map(item => requiredText(item, 'providers')) : undefined
      const body = await invoke(credential, 'images_search_and_download', {
        queries: queries.map(row => ({ query: requiredText(row.query, 'query'), ...(text(row.prompt) === undefined ? {} : { prompt: text(row.prompt) }) })),
        ...(providers === undefined ? {} : { providers }),
      }, options, exec, GENERATION_TIMEOUT_MS)
      const results = records(matrixPayloadField(body, 'results'))
      const perQuery: JsonValue[] = []
      for (const [index, row] of queries.entries()) {
        const outputDir = requiredText(row.outputDir, 'outputDir').replace(/[\\/]+$/, '')
        const result = results[index]
        const files: JsonValue[] = []
        const failures: JsonValue[] = []
        for (const [imageIndex, image] of records(result?.images).slice(0, 10).entries()) {
          const sourceUrl = text(image.image_url)
          if (sourceUrl === undefined) { failures.push({ index: imageIndex, error: 'missing image_url' }); continue }
          try {
            files.push({ ...await downloadWorkspaceMedia(root, outputDir + '/' + imageIndex + imageExtension(sourceUrl), sourceUrl, options.fetchFn ?? fetch, exec.signal, MAX_IMAGE_FILE_BYTES) })
          } catch (error) { failures.push({ index: imageIndex, sourceUrl, error: error instanceof Error ? error.message : String(error) }) }
        }
        perQuery.push({ query: requiredText(row.query, 'query'), files, failures, ...(text(result?.error) === undefined ? {} : { serverError: text(result?.error) }) })
      }
      return { queries: perQuery }
    },
  })
}

function createReverseImageSearch(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_REVERSE_IMAGE_SEARCH_TOOL_NAME,
    description: 'Upload one workspace image to MiniMax, find visually similar images and source pages, and save a Markdown report in the workspace. Only available on the minimax-code provider.',
    parameters: {
      inputPath: { type: 'string', required: true, description: 'Workspace image path.' },
      outputPath: { type: 'string', required: true, description: 'Workspace-relative .md report path.' },
    },
    output: MEDIA_OUTPUT, timeoutMs: GENERATION_TIMEOUT_MS, isConcurrencySafe: () => true,
    presentCall: callPresentation('Reverse image search with MiniMax'),
    presentResult: resultPresentation('MiniMax reverse image search completed', 'MiniMax reverse image search failed'),
    async execute(args, exec) {
      const credential = await credentialFor(exec, options, 'reverse image search')
      const root = await workspaceRootOf(ctx, exec)
      const local = await readWorkspaceMedia(root, requiredText(args.inputPath, 'inputPath'), 'image')
      const imageUrl = await uploadWorkspaceMedia(credential, local, options.fetchFn ?? fetch, exec.signal)
      const body = await invoke(credential, 'image_reverse_search', { image_url: imageUrl }, options, exec, GENERATION_TIMEOUT_MS)
      const items = records(matrixPayloadField(body, 'data')).map(item => ({
        ...(text(item.title) === undefined ? {} : { title: text(item.title) }), ...(text(item.link) === undefined ? {} : { link: text(item.link) }),
        ...(text(item.source) === undefined ? {} : { source: text(item.source) }), ...(text(item.image_url) === undefined ? {} : { imageUrl: text(item.image_url) }),
        ...(text(item.snippet) === undefined ? {} : { snippet: text(item.snippet) }),
      }))
      const lines = ['# Reverse Image Search Results', '']
      if (items.length === 0) lines.push('_No results._', '')
      items.forEach((item, index) => {
        lines.push('## ' + (index + 1) + '. ' + (item.title ?? '(untitled)'))
        if (item.link !== undefined) lines.push('- **Link:** ' + item.link)
        if (item.source !== undefined) lines.push('- **Source:** ' + item.source)
        if (item.imageUrl !== undefined) lines.push('- **Image:** ' + item.imageUrl)
        if (item.snippet !== undefined) lines.push('- **Snippet:** ' + item.snippet)
        lines.push('')
      })
      const report = await writeWorkspaceText(root, requiredText(args.outputPath, 'outputPath'), lines.join('\n'))
      return { report: { ...report }, resultCount: items.length, results: items }
    },
  })
}

function createVoiceList(options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_LIST_VOICES_TOOL_NAME,
    description: 'List MiniMax voice presets (voice_id and voice_name) available to minimax_generate_speech. Only available on the minimax-code provider.',
    parameters: {}, output: MEDIA_OUTPUT, timeoutMs: 120_000, isConcurrencySafe: () => true,
    presentCall: callPresentation('List MiniMax voices'),
    presentResult: resultPresentation('MiniMax voices', 'MiniMax voice list failed'),
    async execute(_args, exec) {
      const credential = await credentialFor(exec, options, 'list voices')
      const body = await invoke(credential, 'get_voice_list', {}, options, exec, 120_000)
      const candidates = matrixPayloadField(body, 'voices') ?? matrixPayloadField(body, 'voice_list') ?? matrixPayloadField(body, 'data')
      if (!Array.isArray(candidates)) throw new HarnessError('voice list response contained no voices array', 'MINIMAX_MEDIA_RESPONSE_INVALID')
      const voices = records(candidates).map(item => ({ voiceId: text(item.voice_id) ?? text(item.id) ?? '', voiceName: text(item.voice_name) ?? text(item.name) ?? '' }))
      return { voices }
    },
  })
}

function createSpeechGeneration(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_GENERATE_SPEECH_TOOL_NAME,
    description: 'Generate up to 10 speech MP3 files with MiniMax in one batch. Supports voice, speed, volume, pitch and emotion per item. Use minimax_list_voices when a valid voice id is needed. Generation is billed; do not retry a refused call automatically. Only available on the minimax-code provider.',
    parameters: { requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', required: true }, outputPath: { type: 'string', required: true, description: 'Workspace-relative .mp3 path.' },
      voiceId: { type: 'string' }, speed: { type: 'number' }, volume: { type: 'number' }, pitch: { type: 'integer' },
      emotion: { type: 'string', enum: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'] },
    } } } },
    output: MEDIA_OUTPUT, timeoutMs: GENERATION_TIMEOUT_MS, isConcurrencySafe: () => false,
    presentCall: callPresentation('Generate speech with MiniMax'),
    presentResult: resultPresentation('MiniMax speech generated', 'MiniMax speech generation failed'),
    async execute(args, exec) {
      const requests = requestArray(args.requests, 10)
      const credential = await credentialFor(exec, options, 'generate speech')
      const root = await workspaceRootOf(ctx, exec)
      for (const row of requests) {
        if (!requiredText(row.outputPath, 'outputPath').toLowerCase().endsWith('.mp3')) throw new HarnessError('speech outputPath must end in .mp3', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
      }
      const wireRequests = requests.map((row, index) => ({
        text: requiredText(row.text, 'text'), output_file: 'slot_' + index + '.mp3',
        ...(text(row.voiceId) === undefined ? {} : { voice_id: text(row.voiceId) }),
        ...(optionalNumber(row, 'speed', 0.5, 2) === undefined ? {} : { speed: optionalNumber(row, 'speed', 0.5, 2) }),
        ...(optionalNumber(row, 'volume', 0, 10) === undefined ? {} : { volume: optionalNumber(row, 'volume', 0, 10) }),
        ...(optionalNumber(row, 'pitch', -12, 12, true) === undefined ? {} : { pitch: optionalNumber(row, 'pitch', -12, 12, true) }),
        ...(text(row.emotion) === undefined ? {} : { emotion: text(row.emotion) }),
      }))
      const body = await invoke(credential, 'batch_synthesize_speech', { requests: wireRequests }, options, exec, GENERATION_TIMEOUT_MS)
      return downloadBatchResults(body, requests, root, options, exec, MAX_AUDIO_FILE_BYTES)
    },
  })
}

async function downloadBatchResults(
  body: RecordValue, requests: RecordValue[], root: string, options: MinimaxMediaToolOptions, exec: Exec,
  maxBytes: number,
) {
  const successful = records(matrixPayloadField(body, 'success_items'))
  const failed = records(matrixPayloadField(body, 'failed_items'))
  const files: JsonValue[] = []
  const failures: (JsonValue | undefined)[] = requests.map((row, index) => ({ index, outputPath: row.outputPath as string, error: 'server returned no result for this slot' }))
  for (const item of failed) {
    const index = slotIndex(item.output_file)
    if (index !== undefined && index < failures.length) failures[index] = { index, outputPath: requests[index].outputPath as string, error: errorOf(item) }
  }
  for (const item of successful) {
    const index = slotIndex(item.output_file)
    if (index === undefined || index >= requests.length) continue
    const sourceUrl = text(item.output_url)
    if (sourceUrl === undefined) { failures[index] = { index, error: errorOf(item) }; continue }
    try {
      files.push({ index, ...await downloadWorkspaceMedia(root, requests[index].outputPath as string, sourceUrl, options.fetchFn ?? fetch, exec.signal, maxBytes) })
      failures.splice(index, 1, undefined)
    } catch (error) { failures[index] = { index, error: error instanceof Error ? error.message : String(error) } }
  }
  return { totalSucceeded: files.length, totalFailed: requests.length - files.length, files, failures: failures.filter((item): item is JsonValue => item !== undefined) }
}

function createMusicGeneration(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_GENERATE_MUSIC_TOOL_NAME,
    description: 'Generate up to 5 music tracks with MiniMax from prompts and optional lyrics. Supports mp3, wav or pcm output. Generation is billed; do not retry a refused call automatically. Only available on the minimax-code provider.',
    parameters: { requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      prompt: { type: 'string', required: true }, outputPath: { type: 'string', required: true }, lyrics: { type: 'string' },
      sampleRate: { type: 'integer', enum: [16000, 24000, 32000, 44100] }, bitrate: { type: 'integer', enum: [32000, 64000, 128000, 256000] },
      format: { type: 'string', enum: ['mp3', 'wav', 'pcm'] },
    } } } },
    output: MEDIA_OUTPUT, timeoutMs: GENERATION_TIMEOUT_MS, isConcurrencySafe: () => false,
    presentCall: callPresentation('Generate music with MiniMax'),
    presentResult: resultPresentation('MiniMax music generated', 'MiniMax music generation failed'),
    async execute(args, exec) {
      const requests = requestArray(args.requests, 5)
      const credential = await credentialFor(exec, options, 'generate music')
      const root = await workspaceRootOf(ctx, exec)
      const wireRequests = requests.map((row, index) => {
        const format = text(row.format) ?? 'mp3'
        const prompt = requiredText(row.prompt, 'prompt')
        if (!requiredText(row.outputPath, 'outputPath').toLowerCase().endsWith('.' + format)) throw new HarnessError('music outputPath must match the selected format', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        if (prompt.length < 10 || prompt.length > 300) throw new HarnessError('music prompt length must be 10 through 300 characters', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        const lyrics = text(row.lyrics)
        if (lyrics !== undefined && (lyrics.length < 10 || lyrics.length > 600)) throw new HarnessError('lyrics length must be 10 through 600 characters', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        const sampleRate = optionalNumber(row, 'sampleRate', 16000, 44100, true)
        if (sampleRate !== undefined && ![16000, 24000, 32000, 44100].includes(sampleRate)) throw new HarnessError('unsupported sampleRate', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        const bitrate = optionalNumber(row, 'bitrate', 32000, 256000, true)
        if (bitrate !== undefined && ![32000, 64000, 128000, 256000].includes(bitrate)) throw new HarnessError('unsupported bitrate', 'MINIMAX_MEDIA_ARGUMENT_INVALID')
        return {
          prompt, output_file: 'slot_' + index + '.' + format, format,
          ...(lyrics === undefined ? {} : { lyrics }), ...(sampleRate === undefined ? {} : { sample_rate: sampleRate }), ...(bitrate === undefined ? {} : { bitrate }),
        }
      })
      const body = await invoke(credential, 'batch_text_to_music', { requests: wireRequests }, options, exec, GENERATION_TIMEOUT_MS)
      return downloadBatchResults(body, requests, root, options, exec, MAX_AUDIO_FILE_BYTES)
    },
  })
}

function createAudioUnderstanding(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_UNDERSTAND_AUDIO_TOOL_NAME,
    description: 'Analyze up to 10 local workspace audio files with MiniMax and return one description per file. For verbatim speech-to-text of one file, prefer minimax_transcribe_audio. Only available on the minimax-code provider.',
    parameters: { requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      inputPath: { type: 'string', required: true }, prompt: { type: 'string', description: 'Question about this audio; defaults to a general description.' },
    } } } },
    output: MEDIA_OUTPUT, timeoutMs: UNDERSTAND_TIMEOUT_MS, isConcurrencySafe: () => true,
    presentCall: callPresentation('Understand audio with MiniMax'),
    presentResult: resultPresentation('MiniMax audio understood', 'MiniMax audio understanding failed'),
    async execute(args, exec) {
      const requests = requestArray(args.requests, 10)
      const credential = await credentialFor(exec, options, 'understand audio')
      const root = await workspaceRootOf(ctx, exec)
      const audioInfo: RecordValue[] = []
      for (const row of requests) {
        const local = await readWorkspaceMedia(root, requiredText(row.inputPath, 'inputPath'), 'audio')
        const url = await uploadWorkspaceMedia(credential, local, options.fetchFn ?? fetch, exec.signal)
        audioInfo.push({ url, mime_type: local.mediaType, prompt: text(row.prompt) ?? '描述这段音频的内容' })
      }
      const body = await invoke(credential, 'audios_understand', { audio_info: audioInfo }, options, exec, UNDERSTAND_TIMEOUT_MS)
      const results = records(matrixPayloadField(body, 'results'))
      return { results: requests.map((row, index) => {
        const item = results[index]
        const analysis = text(item?.description) ?? text(item?.text) ?? text(item?.text_response)
        const error = text(item?.error)
        return { inputPath: requiredText(row.inputPath, 'inputPath'), success: item !== undefined && item.success !== false && analysis !== undefined,
          analysis: analysis ?? '', ...(error === undefined ? {} : { error }) }
      }) }
    },
  })
}

function createAudioTranscription(ctx: Context, options: MinimaxMediaToolOptions) {
  return defineTool({
    name: MINIMAX_TRANSCRIBE_AUDIO_TOOL_NAME,
    description: 'Transcribe one local workspace audio file to text with MiniMax. Supports common mp3, wav, m4a, aac, ogg, flac and opus files. Only available on the minimax-code provider.',
    parameters: {
      inputPath: { type: 'string', required: true },
      prompt: { type: 'string', description: 'Optional transcription context or vocabulary hints.' },
    },
    output: MEDIA_OUTPUT, timeoutMs: UNDERSTAND_TIMEOUT_MS, isConcurrencySafe: () => true,
    presentCall: callPresentation('Transcribe audio with MiniMax'),
    presentResult: resultPresentation('MiniMax audio transcribed', 'MiniMax audio transcription failed'),
    async execute(args, exec) {
      const credential = await credentialFor(exec, options, 'transcribe audio')
      const root = await workspaceRootOf(ctx, exec)
      const local = await readWorkspaceMedia(root, requiredText(args.inputPath, 'inputPath'), 'audio')
      const url = await uploadWorkspaceMedia(credential, local, options.fetchFn ?? fetch, exec.signal)
      const body = await invoke(credential, 'listen_audio', {
        audio_info: { url, mime_type: local.mediaType, ...(text(args.prompt) === undefined ? {} : { prompt: text(args.prompt) }) },
      }, options, exec, UNDERSTAND_TIMEOUT_MS)
      const first = records(matrixPayloadField(body, 'results'))[0]
      const transcript = text(first?.transcript) ?? text(first?.text) ?? text(first?.description) ?? text(matrixPayloadField(body, 'text'))
      if (transcript === undefined) throw new HarnessError('transcription response contained no text', 'MINIMAX_MEDIA_RESPONSE_INVALID')
      return { inputPath: args.inputPath, transcript }
    },
  })
}

export function createMinimaxMediaTools(ctx: Context, options: MinimaxMediaToolOptions) {
  return [
    createImageGeneration(ctx, options), createImageSearch(ctx, options), createReverseImageSearch(ctx, options),
    createVoiceList(options), createSpeechGeneration(ctx, options), createMusicGeneration(ctx, options),
    createAudioUnderstanding(ctx, options), createAudioTranscription(ctx, options),
  ]
}