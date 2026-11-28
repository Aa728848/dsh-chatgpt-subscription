/** Qwen4 Chat Completions wire mapping. No network I/O lives here. */
import { CONTEXT_OVERFLOW_CODE, isContextOverflow } from '../../common/context-overflow.ts'
import {
  LlmError,
  extractSystemText,
  midConversationUpdateToUserMessage,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type OutboundContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '../../common/llm-compat.ts'
import { toToolCallId } from '../../common/brand-compat.ts'
import { stripMetaSchema } from '../../common/tool-schema.ts'
import {
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImages,
} from '../../common/request-images.ts'
import type { QianwenSettings } from './token-store.ts'
import { defaultQianwenSettings } from './token-store.ts'
import { resolveQianwenModel } from './model-catalog.ts'
import { PROVIDER_ID, PROVIDER_NAME, QIANWEN_DEFAULT_MAX_PIXELS } from './types.ts'
import type { QianwenCacheUsage } from './cache-stats.ts'

export { resolveRequestImages }
export type { AttachmentImageReader, ResolvedRequestImages }
export const QIANWEN_MAX_REQUEST_IMAGE_BYTES = 48 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const clean = (text: string): string => text.replace(/\0/g, '')
const numberOr = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
function safeJson(text: string): unknown { try { return JSON.parse(text) as unknown } catch { return undefined } }
function argsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!isRecord(block)) return ''
    if (block.type === 'text' && typeof block.text === 'string') return clean(block.text)
    if (block.type === 'tool-result') return textOf(block.content)
    if (block.type === 'image') return '[image: ' + (attachmentLabel(block) ?? 'attached image') + ']'
    return ''
  }).join('')
}

export function offloadOldestQianwenRequestImages(options: GenerateOptions, images: ResolvedRequestImages = NO_RESOLVED_IMAGES): GenerateOptions {
  return offloadOldestRequestImages(options, QIANWEN_MAX_REQUEST_IMAGE_BYTES, images)
}

type WireBlock = Record<string, unknown>
type WireMessage = Record<string, unknown>

interface ReplayRead {
  fields: Record<string, unknown>
  encryptedReplays: number
  missingEncryptedContent: number
}
function replayAssistantReasoning(message: Message, model: string): ReplayRead {
  const out: ReplayRead = { fields: {}, encryptedReplays: 0, missingEncryptedContent: 0 }
  const state = isRecord(message.source?.replayState) ? message.source.replayState : undefined
  const response = isRecord(state?.response) ? state.response : undefined
  if (response?.provider !== PROVIDER_ID || response.model !== model || !Array.isArray(state?.blocks)) return out
  const replayBlocks: unknown[] = state.blocks
  const form = response.form
  const full: string[] = []
  const encrypted: string[] = []
  message.content.forEach((block, index) => {
    if (!isRecord(block) || block.type !== 'reasoning') return
    const entry = isRecord(replayBlocks[index]) ? replayBlocks[index] : undefined
    const ciphertext = asString(entry?.encrypted)
    if (ciphertext !== undefined && ciphertext !== '') encrypted.push(ciphertext)
    else if (form === 'full' && typeof block.text === 'string') full.push(block.text)
    else if (form === 'summarized') out.missingEncryptedContent += 1
  })
  // The Chat Completions field carries one opaque value per assistant message.
  // Never concatenate multiple ciphertexts: if a legacy assembler folded several
  // model turns into one message, omitting replay is safer than corrupting it.
  if (encrypted.length === 1) {
    out.fields.encrypted_content = encrypted[0]
    out.encryptedReplays = 1
  } else if (encrypted.length > 1) {
    out.missingEncryptedContent += encrypted.length
  }
  if (form === 'full' && full.length > 0) out.fields.reasoning_content = full.join('')
  return out
}

function leadingInstructionEndIndex(messages: readonly Message[]): number {
  let end = 0
  while (end < messages.length && (messages[end]?.role === 'system' || messages[end]?.role === 'developer')) {
    end += 1
  }
  return end
}

function leadingSystemText(options: GenerateOptions): string {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  const leadingEnd = leadingInstructionEndIndex(options.messages)
  for (let index = 0; index < leadingEnd; index += 1) {
    const text = extractSystemText(options.messages[index]!.content, clean)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}
function isToolResult(message: Message): boolean { return message.source?.kind === 'tool' }

function imageBlock(block: Record<string, unknown>, images: ResolvedRequestImages, settings: QianwenSettings, supportsImages: boolean, visualBudget: boolean): WireBlock {
  const inline = supportsImages ? imageBlockToInline(block, images) : undefined
  if (inline === undefined || !SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
    return { type: 'text', text: supportsImages ? unavailableImageText(block) : '[image omitted: selected model does not declare image input.]' }
  }
  const url = 'data:' + inline.mediaType + ';base64,' + inline.data
  if (!visualBudget) return { type: 'image_url', image_url: { url } }
  const maxPixels = settings.maxPixels ?? (settings.imageDetail === 'high' ? null : QIANWEN_DEFAULT_MAX_PIXELS)
  return {
    type: 'image_url', image_url: { url, detail: settings.imageDetail },
    ...(maxPixels === null ? {} : { max_pixels: maxPixels }),
  }
}
function userBlocks(message: Message, images: ResolvedRequestImages, settings: QianwenSettings, supportsImages: boolean, supportsVideo: boolean, visualBudget: boolean): WireBlock[] {
  const out: WireBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: clean(block.text) })
    else if (block.type === 'image') out.push(imageBlock(block, images, settings, supportsImages, visualBudget))
    else if ((String(block.type) === 'video_url' || block.type === 'video') && supportsVideo) {
      const url = asString(block.url) ?? (isRecord(block.video_url) ? asString(block.video_url.url) : undefined)
      if (url !== undefined) out.push({ type: 'video_url', video_url: { url } })
    } else if (block.type === 'tool-result') out.push({ type: 'text', text: textOf(block.content) })
  }
  return out
}
function toolResultImages(content: unknown, images: ResolvedRequestImages, settings: QianwenSettings, supportsImages: boolean, visualBudget: boolean): WireBlock[] {
  if (!Array.isArray(content)) return []
  const out: WireBlock[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') out.push(imageBlock(block, images, settings, supportsImages, visualBudget))
    else if (block.type === 'tool-result') out.push(...toolResultImages(block.content, images, settings, supportsImages, visualBudget))
  }
  return out
}

function markBreakpoint(message: WireMessage, position?: number): boolean {
  const content = message.content
  if (!Array.isArray(content)) return false
  const indices = position === undefined
    ? Array.from({ length: content.length }, (_, index) => content.length - 1 - index)
    : [position]
  for (const index of indices) {
    const block = content[index]
    if (!isRecord(block) || (block.type !== 'text' && block.type !== 'image_url' && block.type !== 'video_url')) continue
    if (block.prompt_cache_breakpoint !== undefined) return false
    block.prompt_cache_breakpoint = { mode: 'explicit' }
    return true
  }
  return false
}
function contentBlockCount(message: WireMessage): number {
  return Array.isArray(message.content) ? message.content.length : typeof message.content === 'string' && message.content !== '' ? 1 : 0
}
function planBreakpoints(messages: WireMessage[], enabled: boolean): number {
  if (!enabled || messages.length === 0) return 0
  let marked = 0
  const system = messages.find(message => message.role === 'system')
  if (system !== undefined && markBreakpoint(system)) marked += 1
  const candidates: Array<{ message: WireMessage; position: number }> = []
  let count = 0
  for (const message of messages) {
    const blocks = contentBlockCount(message)
    for (let index = 0; index < blocks; index += 1) {
      count += 1
      if (count % 20 === 0 && message !== system && (message.role === 'user' || message.role === 'assistant')) candidates.push({ message, position: index })
    }
  }
  // Keep exact 20-block positions, including several inside one long message.
  for (const candidate of candidates.slice(-Math.max(0, 3 - marked))) {
    const message = candidate.message
    if (!Array.isArray(message.content) && typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
    if (markBreakpoint(message, candidate.position)) marked += 1
  }
  return marked
}

export interface QianwenRequestBuild {
  body: Record<string, unknown>
  cacheBreakpoints: number
  summaryMode: boolean
  encryptedReplays: number
  missingEncryptedContent: number
}
export function buildQianwenChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  settings: QianwenSettings = defaultQianwenSettings(),
): QianwenRequestBuild {
  const entry = resolveQianwenModel(options.model)
  const messages: WireMessage[] = []
  const system = leadingSystemText(options)
  if (system !== '') messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
  const leadingEnd = leadingInstructionEndIndex(options.messages)
  const conversation: Message[] = []
  for (let index = leadingEnd; index < options.messages.length; index += 1) {
    const message = options.messages[index]!
    if (message.role !== 'system' && message.role !== 'developer') {
      conversation.push(message)
      continue
    }
    const reminder = midConversationUpdateToUserMessage(message, clean)
    if (reminder !== undefined) conversation.push(reminder)
  }
  let encryptedReplays = 0
  let missingEncryptedContent = 0
  for (let index = 0; index < conversation.length; index += 1) {
    const message = conversation[index]
    if (isToolResult(message)) {
      const imageParts: WireBlock[] = []
      while (index < conversation.length && isToolResult(conversation[index])) {
        const current = conversation[index]
        const first = current.content[0]
        const callId = isRecord(first) && typeof first.toolCallId === 'string' ? first.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: callId, content: textOf(current.content) })
        imageParts.push(...toolResultImages(current.content, images, settings, entry.supportsImages, entry.supportsVisualBudget))
        index += 1
      }
      index -= 1
      if (imageParts.length > 0) messages.push({ role: 'user', content: imageParts })
      continue
    }
    if (message.role === 'assistant') {
      const text: string[] = []
      const calls: WireMessage[] = []
      for (const block of message.content) {
        if (!isRecord(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') text.push(clean(block.text))
        else if (block.type === 'tool-call' && typeof block.name === 'string') calls.push({
          id: typeof block.id === 'string' ? block.id : 'call_' + calls.length,
          type: 'function', function: { name: block.name, arguments: argsText(block.arguments) },
        })
      }
      const replay = replayAssistantReasoning(message, options.model)
      encryptedReplays += replay.encryptedReplays
      missingEncryptedContent += replay.missingEncryptedContent
      if (text.join('') !== '' || calls.length > 0 || Object.keys(replay.fields).length > 0) {
        messages.push({ role: 'assistant', content: text.join(''), ...(calls.length > 0 ? { tool_calls: calls } : {}), ...replay.fields })
      }
      continue
    }
    const content = userBlocks(message, images, settings, entry.supportsImages, entry.supportsVideo, entry.supportsVisualBudget)
    if (content.length > 0) messages.push({ role: 'user', content })
  }
  const requested = typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim() !== ''
    ? options.reasoningEffort.trim()
    : settings.defaultReasoningEffort
  const effort = requested !== null && entry.reasoningEfforts.includes(requested as never) ? requested : undefined
  const thinkingEnabled = effort !== 'none'
  const summaryMode = settings.thinkingSummary && entry.supportsCoTSummary && thinkingEnabled
  const cacheEnabled = settings.cacheEnabled && entry.supportsExplicitCache
  const manualBreakpoints = planBreakpoints(messages, cacheEnabled)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxTokens === undefined ? {} : { max_completion_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(options.tools !== undefined && options.tools.length > 0 ? {
      tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) } })),
      ...(entry.automaticRouting ? {} : { tool_choice: 'auto', parallel_tool_calls: true }),
    } : {}),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(thinkingEnabled && entry.supportsCoTSummary ? { enable_thinking: true, preserve_thinking: true } : {}),
    ...(summaryMode ? { thinking_display: 'summarized' } : {}),
    ...(cacheEnabled ? { prompt_cache_options: { mode: 'implicit', ttl: settings.cacheTtl } } : {}),
  }
  return { body, cacheBreakpoints: manualBreakpoints + (cacheEnabled ? 1 : 0), summaryMode, encryptedReplays, missingEncryptedContent }
}

export interface QianwenParsedUsage {
  promptTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  reasoningTokens: number
}
export function parseQianwenUsage(raw: unknown): QianwenParsedUsage | undefined {
  if (!isRecord(raw)) return undefined
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const creation = isRecord(details.cache_creation) ? details.cache_creation : {}
  const promptTokens = numberOr(raw.prompt_tokens)
  const cacheReadTokens = numberOr(details.cached_tokens)
  const cacheWriteTokens = numberOr(details.cache_write_tokens, numberOr(details.cache_creation_input_tokens))
  return {
    promptTokens,
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: numberOr(raw.completion_tokens),
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens: numberOr(creation.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: numberOr(creation.ephemeral_1h_input_tokens),
    reasoningTokens: numberOr(isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : raw.reasoning_tokens),
  }
}

interface OpenText { index: number; type: 'text' | 'reasoning'; text: string }
interface PendingTool { blockIndex: number; id: string; name: string; arguments: string; started: boolean }
export interface QianwenStreamState {
  sessionId?: string
  model: string
  summaryMode: boolean
  blocks: OutboundContentBlock[]
  current: OpenText | null
  toolCalls: Map<number, PendingTool>
  encryptedByBlock: Map<number, string>
  hasToolCall: boolean
  finishReason: string | null
  done: boolean
  finished: boolean
  sawUsage: boolean
  usage: QianwenParsedUsage
  encryptedReplays: number
  missingEncryptedContent: number
}
const emptyUsage = (): QianwenParsedUsage => ({ promptTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 })
export function createQianwenStreamState(input: { sessionId?: string; model: string; summaryMode?: boolean; encryptedReplays?: number; missingEncryptedContent?: number }): QianwenStreamState {
  return {
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), model: input.model, summaryMode: input.summaryMode === true,
    blocks: [], current: null, toolCalls: new Map(), encryptedByBlock: new Map(), hasToolCall: false,
    finishReason: null, done: false, finished: false, sawUsage: false, usage: emptyUsage(),
    encryptedReplays: input.encryptedReplays ?? 0, missingEncryptedContent: input.missingEncryptedContent ?? 0,
  }
}
function closeCurrent(state: QianwenStreamState): StreamChunk[] {
  const current = state.current
  if (current === null) return []
  const block = { type: current.type, text: current.text } as OutboundContentBlock
  state.blocks[current.index] = block
  state.current = null
  return [{ type: 'block-end', index: current.index, block }]
}
function closeTools(state: QianwenStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const [wireIndex, call] of [...state.toolCalls.entries()].sort((a,b) => a[0] - b[0])) {
    const block = { type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments } as OutboundContentBlock
    state.blocks[call.blockIndex] = block
    out.push({ type: 'block-end', index: call.blockIndex, block })
    state.toolCalls.delete(wireIndex)
  }
  return out
}
function openText(state: QianwenStreamState, type: 'text' | 'reasoning'): { out: StreamChunk[]; block: OpenText } {
  const out = closeCurrent(state)
  const block: OpenText = { index: state.blocks.length, type, text: '' }
  state.current = block
  state.blocks.push({ type, text: '' } as OutboundContentBlock)
  out.push({ type: 'block-start', index: block.index, blockType: type })
  return { out, block }
}
function appendText(state: QianwenStreamState, type: 'text' | 'reasoning', text: string): StreamChunk[] {
  const out = [...closeTools(state)]
  let block = state.current
  if (block === null || block.type !== type) {
    const opened = openText(state, type)
    out.push(...opened.out)
    block = opened.block
  }
  block.text += text
  out.push(type === 'reasoning' ? { type: 'reasoning-delta', index: block.index, text } : { type: 'text-delta', index: block.index, text })
  return out
}
function ensureCipherBlock(state: QianwenStreamState): { out: StreamChunk[]; index: number } {
  if (state.current?.type === 'reasoning') return { out: [], index: state.current.index }
  const opened = openText(state, 'reasoning')
  return { out: opened.out, index: opened.block.index }
}
function applyTool(state: QianwenStreamState, entry: Record<string, unknown>): StreamChunk[] {
  const wireIndex = typeof entry.index === 'number' ? entry.index : 0
  const fn = isRecord(entry.function) ? entry.function : {}
  const out: StreamChunk[] = [...closeCurrent(state)]
  let call = state.toolCalls.get(wireIndex)
  if (call === undefined) {
    call = { blockIndex: state.blocks.length, id: asString(entry.id) ?? 'call_' + wireIndex, name: asString(fn.name) ?? '', arguments: '', started: false }
    state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' } as OutboundContentBlock)
    state.toolCalls.set(wireIndex, call)
  } else {
    const id = asString(entry.id)
    if (id !== undefined && call.id === 'call_' + wireIndex) call.id = id
    const name = asString(fn.name)
    if (name !== undefined && name !== '') call.name = name
  }
  const delta = asString(fn.arguments) ?? ''
  call.arguments += delta
  if (!call.started) {
    call.started = true
    state.hasToolCall = true
    out.push({ type: 'block-start', index: call.blockIndex, blockType: 'tool-call' })
  }
  out.push({ type: 'tool-call-delta', index: call.blockIndex, id: toToolCallId(call.id), ...(call.name === '' ? {} : { name: call.name }), argumentsDelta: delta })
  return out
}

export function feedQianwenChatChunk(state: QianwenStreamState, payload: unknown): StreamChunk[] {
  if (state.finished || !isRecord(payload)) return []
  if (isRecord(payload.error)) {
    const message = asString(payload.error.message) ?? 'unknown upstream error'
    throw new LlmError(PROVIDER_NAME + ' stream error: ' + message, isContextOverflow(payload.error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR')
  }
  const usage = parseQianwenUsage(payload.usage)
  if (usage !== undefined) { state.sawUsage = true; state.usage = usage }
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = isRecord(choice?.delta) ? choice.delta : undefined
  const out: StreamChunk[] = []
  if (delta !== undefined) {
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') out.push(...appendText(state, 'reasoning', clean(reasoning)))
    const encrypted = asString(delta.encrypted_content)
    if (encrypted !== undefined && encrypted !== '') {
      const target = ensureCipherBlock(state)
      out.push(...target.out)
      state.encryptedByBlock.set(target.index, encrypted)
    }
    const content = asString(delta.content)
    if (content !== undefined && content !== '') out.push(...appendText(state, 'text', clean(content)))
    const tools = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of tools) if (isRecord(entry)) out.push(...applyTool(state, entry))
  }
  const finish = asString(choice?.finish_reason)
  if (finish !== undefined && finish !== '' && finish !== 'null') {
    state.finishReason = finish
    out.push(...closeCurrent(state), ...closeTools(state))
  }
  return out
}

function replayState(state: QianwenStreamState): { response: unknown; blocks: unknown[] } | undefined {
  if (!state.blocks.some(block => block.type === 'reasoning')) return undefined
  return {
    response: { provider: PROVIDER_ID, model: state.model, form: state.summaryMode ? 'summarized' : 'full' },
    blocks: state.blocks.map((block, index) => {
      if (block.type !== 'reasoning') return null
      const encrypted = state.encryptedByBlock.get(index)
      if (state.summaryMode && encrypted === undefined) state.missingEncryptedContent += 1
      return { ...(encrypted === undefined ? {} : { encrypted }) }
    }),
  }
}
function finishReason(state: QianwenStreamState): FinishReason {
  if (state.finishReason === 'length' || state.finishReason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || state.finishReason === 'tool_calls' || state.finishReason === 'function_call') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}
export function streamQianwenTokenUsage(state: QianwenStreamState): TokenUsage {
  const usage = state.usage
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
  }
}
export function closeQianwenStream(state: QianwenStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeTools(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: streamQianwenTokenUsage(state) })
  const replay = replayState(state)
  out.push({ type: 'finish', reason: finishReason(state), ...(replay === undefined ? {} : { replayState: replay }) })
  return out
}
export function processQianwenStreamLine(line: string, state: QianwenStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || !trimmed.startsWith('data:')) return []
  const data = trimmed.slice(5).trim()
  if (data === '[DONE]') { state.done = true; return closeQianwenStream(state) }
  if (data === '') return []
  return feedQianwenChatChunk(state, safeJson(data))
}
export function assertQianwenStreamComplete(state: QianwenStreamState): void {
  if (!state.done && state.finishReason === null) throw new LlmError(PROVIDER_NAME + ' stream ended before its terminal event', 'TRANSPORT')
}
export function readQianwenCacheUsage(state: QianwenStreamState): QianwenCacheUsage | undefined {
  if (!state.sawUsage) return undefined
  return { ...state.usage, encryptedReplays: state.encryptedReplays, missingEncryptedContent: state.missingEncryptedContent }
}
export function classifyQianwenFailure(status: number, detail: string): LlmError {
  let parsed: unknown = undefined
  try { parsed = JSON.parse(detail) as unknown } catch { /* text below */ }
  const record = isRecord(parsed) ? parsed : undefined
  const error = isRecord(record?.error) ? record.error : record
  const message = asString(error?.message) ?? detail.slice(0, 600) ?? 'HTTP ' + status
  const code = status === 401 ? 'INVALID_CREDENTIAL'
    : status === 429 ? 'RATE_LIMIT'
    : status >= 500 ? 'SERVER'
    : (error !== undefined && isContextOverflow(error)) || /context.*(length|overflow)|maximum context/i.test(message) ? CONTEXT_OVERFLOW_CODE
    : 'PROVIDER_ERROR'
  return new LlmError(PROVIDER_NAME + ': ' + message, code)
}
