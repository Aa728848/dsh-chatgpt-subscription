/**
 * Provider-wire mapping for the Kimi Code coding endpoints.
 *
 * Two surfaces serve the same models:
 *
 * - the OpenAI-compatible `/coding/v1/chat/completions`, which is what the
 *   official CLI configures for its managed provider and therefore the default
 *   here; and
 * - the Anthropic-compatible `/coding/v1/messages?beta=true`, which authenticates
 *   with `x-api-key` rather than a bearer token.
 *
 * Both are mapped here, and both streams are normalized into DSH's block/delta
 * vocabulary.
 *
 * Two Kimi-specific behaviours shape the request builders:
 *
 * 1. Thinking is selected with `reasoning_effort` and accepts only
 *    low/high/max; anything else the client sends is answered with HTTP 400, so
 *    a caller's broader effort vocabulary is narrowed here rather than passed
 *    through. Thinking off is expressed as `thinking: {type: "disabled"}`.
 * 2. When thinking is on, Kimi requires `reasoning_content` on an assistant
 *    message that also carries tool calls — the service answers 400
 *    "thinking is enabled but reasoning_content is missing" otherwise. Reasoning
 *    blocks are therefore replayed on the OpenAI wire, unlike the sibling routes
 *    which drop them.
 *
 * See https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
 */

import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createHash } from 'node:crypto'
import { toToolCallId } from '../common/brand-compat.ts'
import { maxOutputTokensFor } from './types.ts'
import type { KimiCodeReasoningEffort, KimiCodeWire } from '../../shared/kimi-code-contracts.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/**
 * Kimi caps a tool-call id at 64 characters and rejects a longer one.
 *
 * DSH ids are usually short, but a provider that prefixes them with a session
 * or turn marker can exceed the bound, so a long id is truncated
 * deterministically rather than allowed to fail the whole request.
 */
export function clampToolCallId(id: string): string {
  return id.length <= 64 ? id : id.slice(0, 64)
}

// ---------------------------------------------------------------------------
// Thinking effort
// ---------------------------------------------------------------------------

/**
 * Service limits on the request shape, from the official error reference.
 *
 * Both were documented as hard 400s, so exceeding them costs the whole turn
 * rather than degrading gracefully — which is why the request is trimmed to fit
 * instead of being sent and rejected.
 */
export const MAX_STOP_SEQUENCES = 5
export const MAX_STOP_SEQUENCE_BYTES = 32

/**
 * Whether one request asks the service to keep reasoning across turns.
 *
 * Kimi's models reason by default and the official CLI ships Preserved Thinking
 * ON (`[thinking] keep = "all"`), which is what its own error reference assumes
 * when it demands `reasoning_content` on every assistant message. An
 * environment opt-out exists for a deployment that would rather not pay for the
 * replayed reasoning tokens.
 */
export function preserveThinkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DSH_KIMI_CODE_PRESERVE_THINKING ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'no', 'off', 'none'].includes(raw)
}

/**
 * Trim stop sequences to what the service accepts.
 *
 * At most five entries, each at most 32 bytes; a longer sequence is dropped
 * rather than truncated, because a shortened stop string would halt generation
 * at the wrong place — silently changing the answer is worse than not stopping.
 */
export function stopSequences(stop: readonly string[] | undefined): string[] {
  if (stop === undefined || stop.length === 0) return []
  const accepted: string[] = []
  for (const entry of stop) {
    if (accepted.length >= MAX_STOP_SEQUENCES) break
    if (entry === '' || Buffer.byteLength(entry, 'utf8') > MAX_STOP_SEQUENCE_BYTES) continue
    accepted.push(entry)
  }
  return accepted
}

/**
 * Narrow a caller's effort onto the levels Kimi accepts.
 *
 * DSH exposes low/high/max/none for these models, but a conversation can hold
 * an effort chosen for a different provider, so the broader vocabulary the rest
 * of the plugin uses is mapped rather than rejected: an unknown value would be
 * answered with HTTP 400 and fail the turn.
 */
export function mapReasoningEffort(effort: string | undefined | null): KimiCodeReasoningEffort | undefined {
  if (effort === undefined || effort === null) return undefined
  const normalized = String(effort).trim().toLowerCase()
  if (normalized === '') return undefined
  switch (normalized) {
    case 'none':
    case 'off':
    case 'disabled':
      return 'none'
    case 'minimal':
    case 'minimum':
    case 'light':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'max'
    default:
      // An unrecognized level has no correct mapping, so the model's own
      // default is used instead of sending a value the service rejects.
      return undefined
  }
}

/**
 * Thinking-token budget one Anthropic-route level asks for.
 *
 * Kimi's Anthropic surface takes the standard `thinking` block, so the budget is
 * derived from the same three levels the OpenAI surface uses.
 */
export function thinkingBudgetFor(effort: KimiCodeReasoningEffort | undefined, maxTokens: number): number | undefined {
  if (effort === undefined || effort === 'none') return undefined
  const requested = effort === 'low' ? 2_048 : effort === 'high' ? 8_192 : 16_384
  // The budget must stay below max_tokens and leave room for the answer.
  const budget = Math.min(requested, maxTokens - 1024)
  return budget >= 1024 ? budget : undefined
}

// ---------------------------------------------------------------------------
// Durable request images
// ---------------------------------------------------------------------------

/** Attachment seam this route needs: verified bytes for one durable image. */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage'>

/** One durable user image resolved for an in-flight request, or proven unreadable. */
export type ResolvedRequestImage =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** Resolved images keyed by durable attachment id; consumed by one request build. */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>

const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

/**
 * Base64 image payload one request may carry.
 *
 * Kimi rejects a request whose total message size exceeds 2 MB with a 400, and
 * the image bytes share that budget with the conversation text, tool schemas,
 * and system prompt — so the bound is deliberately the smaller of the two
 * documented limits rather than the largest body the transport would accept.
 */
export const MAX_REQUEST_IMAGE_BYTES = 1_500_000

/** Message-body ceiling the service documents for one request. */
export const MAX_MESSAGE_BODY_BYTES = 2_097_152

const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its size limit; older images are omitted first. '
  + 'If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** Media types both upstream wires accept as inline base64. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function attachmentOf(block: Record<string, unknown>): ImageAttachmentRef | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  return typeof attachment.attachmentId === 'string' ? attachment as unknown as ImageAttachmentRef : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const attachment = attachmentOf(block)
    if (attachment) refs.set(attachment.attachmentId, attachment)
  }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function requestImageBytes(block: Record<string, unknown>): number | undefined {
  const attachment = attachmentOf(block)
  if (attachment) return base64Length(attachment.bytes)
  const inline = asString(block.data) || asString(block.base64)
  return inline ? inline.length : undefined
}

function collectRequestImageBytes(content: unknown, lengths: number[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const bytes = requestImageBytes(block)
    if (bytes !== undefined) lengths.push(bytes)
  }
}

/**
 * Replace the oldest inline images with a text placeholder once one request
 * would carry more than {@link MAX_REQUEST_IMAGE_BYTES} of base64 image data.
 * Durable history is untouched; only the request about to be sent changes.
 */
export function offloadOldestRequestImages(options: GenerateOptions): GenerateOptions {
  const lengths: number[] = []
  for (const message of options.messages) collectRequestImageBytes(message.content, lengths)
  const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - MAX_REQUEST_IMAGE_BYTES
  if (excess <= 0) return options

  let omitted = 0
  let freed = 0
  for (const bytes of lengths) {
    if (freed >= excess) break
    freed += bytes
    omitted += 1
  }

  const remaining = { count: omitted }
  const messages = options.messages.map((message) => {
    if (remaining.count === 0 || !Array.isArray(message.content)) return message
    let replaced = false
    const content = message.content.map((block) => {
      if (remaining.count === 0 || !isRecord(block) || block.type !== 'image') return block
      if (requestImageBytes(block) === undefined) return block
      remaining.count -= 1
      replaced = true
      return { type: 'text', text: OMITTED_IMAGE_TEXT } as ContentBlock
    })
    return replaced ? { ...message, content } : message
  })
  return { ...options, messages }
}

/**
 * Read every durable `{ type: 'image', attachment }` block one request carries.
 * An unreadable image resolves to `unavailable` rather than disappearing, so
 * the model is told the picture is missing instead of answering about a blank.
 */
export async function resolveRequestImages(
  options: GenerateOptions,
  attachments: AttachmentImageReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRequestImages> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return NO_RESOLVED_IMAGES

  const resolved = new Map<string, ResolvedRequestImage>()
  await Promise.all([...refs].map(async ([attachmentId, ref]) => {
    if (!attachments) {
      resolved.set(attachmentId, { kind: 'unavailable' })
      return
    }
    try {
      const stored = await attachments.readImage(ref, signal)
      resolved.set(attachmentId, {
        kind: 'inline',
        mediaType: stored.ref.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error) {
      if (isAbort(error, signal)) throw error
      resolved.set(attachmentId, { kind: 'unavailable' })
    }
  }))
  return resolved
}

function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label} could not be read` : 'the image could not be read'
  return `[image unavailable: ${subject}; ask the user to attach it again if the image is needed]`
}

interface InlineImage {
  mediaType: string
  data: string
}

function imageBlockToInline(block: Record<string, unknown>, images: ResolvedRequestImages): InlineImage | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  let mediaType =
    asString(block.mimeType)
    || asString(block.mediaType)
    || (source ? asString(source.mimeType) || asString(source.mediaType) : undefined)
    || 'image/png'

  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) {
      mediaType = matched[1] || mediaType
      data = matched[2] || ''
    }
  }
  if (data) return { mediaType, data }

  const attachment = attachmentOf(block)
  const resolved = attachment ? images.get(attachment.attachmentId) : undefined
  // The media type comes from the verified reference, not from the block.
  return resolved?.kind === 'inline' ? { mediaType: resolved.mediaType, data: resolved.data } : undefined
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return sanitizeText(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(sanitizeText(block.text))
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
  }
  return parts.join('')
}

function toolResultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
      if (block.type === 'tool-result') return toolResultText(block.content)
      // A tool-result image is named, not inlined: the service's body-size
      // ceiling is small enough that inlining every result image would break
      // the request rather than enrich it.
      if (block.type === 'image') return `[image: ${attachmentLabel(block) ?? 'attached image'}]`
      return ''
    })
    .join('')
}

function toolCallArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return '{}'
  try {
    return JSON.stringify(raw)
  } catch {
    return '{}'
  }
}

function isToolResultMessage(message: Message): boolean {
  // A hand-built one-shot request (GenerateOptions documents those) may carry
  // messages without provenance; only a real tool-result message has one.
  return message.source?.kind === 'tool'
}

function leadingSystemText(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = textOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

/** Drop the JSON-Schema keywords provider gateways reject or ignore. */
export function stripMetaSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} }
  const copy: Record<string, unknown> = { ...schema }
  delete copy.$schema
  return copy
}

/** Concatenated reasoning text one assistant message carries, when it has any. */
function reasoningText(message: Message): string {
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(sanitizeText(block.text))
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions request
// ---------------------------------------------------------------------------

type OpenAIMessage = Record<string, unknown>

function openAIUserContent(message: Message, images: ResolvedRequestImages): string | OpenAIMessage[] {
  if (!Array.isArray(message.content)) return ''
  const parts: OpenAIMessage[] = []
  let hasImage = false
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        hasImage = true
        parts.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        parts.push({ type: 'text', text: unavailableImageText(block) })
      }
    }
  }
  if (!hasImage) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
  return parts
}

function openAIAssistantContent(message: Message): { content: string; toolCalls: OpenAIMessage[]; reasoning: string } {
  const textParts: string[] = []
  const toolCalls: OpenAIMessage[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(sanitizeText(block.text))
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      toolCalls.push({
        id: clampToolCallId(typeof block.id === 'string' && block.id !== '' ? block.id : `call_${toolCalls.length}`),
        type: 'function',
        function: { name: block.name, arguments: toolCallArguments(block.arguments) },
      })
    }
  }
  return { content: textParts.join(''), toolCalls, reasoning: reasoningText(message) }
}

/**
 * Rough prompt size for one request, in tokens.
 *
 * Derived from the serialized text with the usual ~4 characters per token
 * heuristic. It is deliberately an estimate: the purpose is only to keep
 * `max_tokens` from making a request the service will reject outright, and the
 * service's own count remains authoritative. Undefined is returned for an empty
 * request so the caller leaves the cap alone rather than clamping against zero.
 */
export function estimatedInputTokens(options: GenerateOptions): number | undefined {
  let characters = typeof options.system === 'string' ? options.system.length : 0
  if (options.tools !== undefined) {
    for (const tool of options.tools) {
      characters += tool.name.length + (tool.description?.length ?? 0)
      try {
        characters += JSON.stringify(tool.parameters).length
      } catch {
        // A non-serializable schema contributes nothing to the estimate.
      }
    }
  }
  for (const message of options.messages) characters += textOf(message.content).length
  if (characters === 0) return undefined
  return Math.ceil(characters / 4)
}

/** Build one `/chat/completions` body. */
export function buildOpenAIRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  preserveThinking: boolean = preserveThinkingEnabled(),
): Record<string, unknown> {
  const effort = mapReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  // Thinking is on unless the caller explicitly disabled it: the models reason
  // by default, so `undefined` still means thinking is active and the
  // reasoning_content rule applies.
  const thinkingOn = effort !== 'none'

  const messages: OpenAIMessage[] = []
  const system = leadingSystemText(options)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message)) {
      const block = message.content[0]
      const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
      messages.push({ role: 'tool', tool_call_id: clampToolCallId(callId), content: toolResultText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls, reasoning } = openAIAssistantContent(message)
      // An assistant turn with neither text nor calls carries nothing on this wire.
      if (content === '' && toolCalls.length === 0) continue
      const entry: OpenAIMessage = { role: 'assistant', content }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      // Preserved Thinking (`thinking.keep = "all"`, the official default) requires
      // `reasoning_content` on every assistant message that lacks it, including
      // plain text turns — omitting it is the documented cause of
      // "thinking is enabled but reasoning_content is missing in assistant tool
      // call message at index N". An empty string is the value the service asks
      // for when a turn genuinely produced no reasoning, so the field is always
      // written rather than conditionally added.
      if (thinkingOn) entry.reasoning_content = reasoning
      messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // The managed endpoint documents max_completion_tokens; the legacy field is
    // normalized away by the service, so it is never sent.
    max_completion_tokens: maxTokens,
    // Sampling is fixed per model (temperature 1.0, top_p 0.95, n 1) and the
    // service rejects an explicit value rather than clamping it, so a caller's
    // temperature is deliberately dropped instead of forwarded.
    ...(stopSequences(options.stop).length > 0 ? { stop: stopSequences(options.stop) } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) },
          })),
          tool_choice: 'auto',
        }
      : {}),
  }
  // Thinking has exactly two encodings here: a level, or explicitly disabled.
  // The level goes out as the documented top-level `reasoning_effort`; the
  // `thinking` object carries Preserved Thinking, which is what makes the
  // service echo reasoning back across turns instead of discarding it.
  if (effort === 'none') body.thinking = { type: 'disabled' }
  else {
    if (effort !== undefined) body[`reasoning_effort`] = effort
    if (preserveThinking) {
      body.thinking = {
        type: 'enabled',
        ...(effort === undefined ? {} : { effort }),
        keep: 'all',
      }
    }
  }

  // A stable cache key tied to the conversation lets a resumed session re-hit
  // the prefix cache. The service derives its cache from the request content, so
  // an unrecognized key is harmless.
  const cacheKey = promptCacheKey(options)
  if (cacheKey !== undefined) body.prompt_cache_key = cacheKey

  return body
}

/**
 * Stable identifier for the conversation this request belongs to.
 *
 * Derived from the first user turn rather than a fresh value per request, so it
 * stays identical across the steps of one session and changes when a new
 * conversation starts.
 */
export function promptCacheKey(options: GenerateOptions): string | undefined {
  for (const message of options.messages) {
    if (message.role !== 'user') continue
    const text = textOf(message.content)
    if (text === '') continue
    return `dsh-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Anthropic Messages request
// ---------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>

function anthropicUserContent(message: Message, images: ResolvedRequestImages): AnthropicBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
      } else {
        blocks.push({ type: 'text', text: unavailableImageText(block) })
      }
    } else if (block.type === 'tool-result') {
      const callId = typeof block.toolCallId === 'string' ? block.toolCallId : ''
      blocks.push({
        type: 'tool_result',
        tool_use_id: clampToolCallId(callId),
        content: toolResultText(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
      })
    }
  }
  return blocks
}

function anthropicAssistantContent(message: Message): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      const parsed = safeJsonParse(toolCallArguments(block.arguments))
      blocks.push({
        type: 'tool_use',
        id: clampToolCallId(typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${blocks.length}`),
        name: block.name,
        input: isRecord(parsed) ? parsed : {},
      })
    }
    // Reasoning blocks are dropped on this wire: Anthropic requires a thinking
    // block to carry the provider signature that produced it, and an unsigned
    // one is rejected outright. The OpenAI wire preserves the same content.
  }
  return blocks
}

/**
 * Merge neighbouring same-role turns.
 *
 * DSH history can hold two user messages in a row (an injected context notice
 * followed by the real turn) and a tool result is itself a user-role message;
 * the Messages wire wants one user turn, so consecutive turns of one role are
 * folded together in order.
 */
function mergeAnthropicMessages(entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const entry of entries) {
    if (entry.content.length === 0) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === entry.role) {
      last.content = [...last.content, ...entry.content]
      continue
    }
    merged.push({ role: entry.role, content: [...entry.content] })
  }
  return merged
}

/** Build one `/v1/messages` body. */
export function buildAnthropicRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message)) {
      entries.push({ role: 'user', content: anthropicUserContent(message, images) })
      continue
    }
    entries.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'assistant'
        ? anthropicAssistantContent(message)
        : anthropicUserContent(message, images),
    })
  }

  const system = leadingSystemText(options)
  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const effort = mapReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  const budget = thinkingBudgetFor(effort, maxTokens)

  return {
    model: options.model,
    max_tokens: maxTokens,
    messages: mergeAnthropicMessages(entries),
    ...(system === undefined ? {} : { system }),
    // Thinking and an explicit temperature are mutually exclusive on this wire.
    ...(options.temperature === undefined || budget !== undefined ? {} : { temperature: options.temperature }),
    ...(options.stop && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: stripMetaSchema(tool.parameters),
          })),
        }
      : {}),
    // This wire keeps the standard Messages shape: `keep` is a Kimi
    // extension on the OpenAI-compatible surface, and preserved thinking on the
    // Anthropic one is expressed as a beta context edit rather than a field here
    // — so neither is sent, and thinking blocks are dropped on replay because
    // they would need the provider signature that produced them.
    ...(effort === undefined
      ? {}
      : budget === undefined
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled', budget_tokens: budget } }),
  }
}

/** Build the body for whichever endpoint serves `wire`. */
export function buildRequest(
  options: GenerateOptions,
  wire: KimiCodeWire,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  preserveThinking: boolean = preserveThinkingEnabled(),
): Record<string, unknown> {
  return wire === 'anthropic'
    ? buildAnthropicRequest(options, images)
    : buildOpenAIRequest(options, images, preserveThinking)
}

/**
 * Reject a request the service would answer with its 2 MB body 400.
 *
 * This is the most frequently reported 400 on the coding endpoint, and it is
 * worth catching locally for two reasons: the message can name the actual
 * remedy (DSH's compaction), and a request that cannot succeed should not be
 * sent at all. The measured size is the real serialized body, so it accounts
 * for tool schemas and inlined images the caller cannot easily estimate.
 */
export function assertRequestBodyFits(body: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  if (bytes <= MAX_MESSAGE_BODY_BYTES) return
  throw new LlmError(
    `Kimi Code rejected the request before sending: the serialized body is ${bytes} bytes, above the `
    + `${MAX_MESSAGE_BODY_BYTES}-byte limit the service enforces. Compact the conversation or start a new `
    + 'session, and check for large tool results or attached images.',
    'PROVIDER_ERROR',
  )
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** One tool call accumulating across `chat/completions` deltas. */
interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
  started: boolean
}

export interface KimiCodeStreamState {
  wire: KimiCodeWire
  blocks: ContentBlock[]
  current: { index: number; type: 'text' | 'reasoning'; text: string } | null
  /** wire tool index -> accumulating call (OpenAI route). */
  toolCalls: Map<number, PendingToolCall>
  /** anthropic content-block index -> our block index. */
  contentIndexes: Map<number, number>
  /** anthropic content index of the block currently open. */
  openContentIndex: number | null
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  done: boolean
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
}

export function createStreamState(wire: KimiCodeWire): KimiCodeStreamState {
  return {
    wire,
    blocks: [],
    current: null,
    toolCalls: new Map(),
    contentIndexes: new Map(),
    openContentIndex: null,
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    done: false,
    finished: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sawUsage: false,
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function closeCurrent(state: KimiCodeStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: ContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: KimiCodeStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const [wireIndex, call] of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const block: ContentBlock = {
      type: 'tool-call',
      id: toToolCallId(clampToolCallId(call.id)),
      name: call.name,
      arguments: call.arguments === '' ? '{}' : call.arguments,
    }
    state.blocks[call.blockIndex] = block
    out.push({ type: 'block-end', index: call.blockIndex, block })
    state.toolCalls.delete(wireIndex)
  }
  return out
}

function openTextBlock(state: KimiCodeStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  const out = closeCurrent(state)
  const index = state.blocks.length
  state.current = { index, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return out
}

/** Feed one SSE `data:` payload from `/chat/completions`. */
export function processOpenAIStreamLine(line: string, state: KimiCodeStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || !trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') {
    state.done = true
    return closeStream(state)
  }
  if (payload === '') return []

  const chunk = safeJsonParse(payload)
  if (!isRecord(chunk)) return []
  const out: StreamChunk[] = []

  // The service reports a mid-stream failure as an SSE data frame rather than
  // an HTTP error, so it must be surfaced as a provider error here.
  const errorPayload = isRecord(chunk.error) ? chunk.error : undefined
  if (errorPayload !== undefined) {
    throw new LlmError(
      `Kimi Code stream error: ${asString(errorPayload.message) ?? 'unknown error'}`,
      'PROVIDER_ERROR',
    )
  }

  const usage = isRecord(chunk.usage) ? chunk.usage : undefined
  if (usage) {
    state.sawUsage = true
    const prompt = numberOr(usage.prompt_tokens, 0)
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
    const cached = details ? numberOr(details.cached_tokens, 0) : 0
    state.inputTokens = Math.max(0, prompt - cached)
    state.cacheReadTokens = cached
    state.outputTokens = numberOr(usage.completion_tokens, state.outputTokens)
    if (isRecord(usage.completion_tokens_details)) {
      state.reasoningTokens = numberOr(usage.completion_tokens_details.reasoning_tokens, state.reasoningTokens)
    }
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = isRecord(choice?.delta) ? (choice as Record<string, unknown>).delta as Record<string, unknown> : undefined

  if (delta) {
    // Newer vLLM gateways name the field `reasoning`; both spellings are read.
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') {
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'reasoning') out.push(...openTextBlock(state, 'reasoning'))
      state.current!.text += sanitizeText(reasoning)
      state.hasContent = true
      out.push({ type: 'reasoning-delta', index: state.current!.index, text: sanitizeText(reasoning) })
    }

    const content = asString(delta.content)
    if (content !== undefined && content !== '') {
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'text') out.push(...openTextBlock(state, 'text'))
      state.current!.text += sanitizeText(content)
      state.hasContent = true
      out.push({ type: 'text-delta', index: state.current!.index, text: sanitizeText(content) })
    }

    const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of toolDeltas) {
      if (!isRecord(entry)) continue
      out.push(...applyOpenAIToolDelta(entry, state))
    }
  }

  const finish = asString(choice?.finish_reason)
  if (finish !== undefined && finish !== '') {
    state.finishReason = finish
    out.push(...closeCurrent(state))
    out.push(...closeToolCalls(state))
  }

  return out
}

function applyOpenAIToolDelta(entry: Record<string, unknown>, state: KimiCodeStreamState): StreamChunk[] {
  const wireIndex = typeof entry.index === 'number' ? entry.index : 0
  const fn = isRecord(entry.function) ? entry.function : {}
  const out: StreamChunk[] = []

  let call = state.toolCalls.get(wireIndex)
  if (call === undefined) {
    out.push(...closeCurrent(state))
    const blockIndex = state.blocks.length
    call = {
      blockIndex,
      id: asString(entry.id) ?? `call_${wireIndex}`,
      name: asString(fn.name) ?? '',
      arguments: '',
      started: false,
    }
    state.blocks.push({ type: 'tool-call', id: toToolCallId(clampToolCallId(call.id)), name: call.name, arguments: '' })
    state.toolCalls.set(wireIndex, call)
  } else {
    if (call.id === `call_${wireIndex}`) {
      const id = asString(entry.id)
      if (id !== undefined) call.id = id
    }
    const name = asString(fn.name)
    if (name !== undefined && name !== '') call.name = name
  }

  const argsDelta = asString(fn.arguments) ?? ''
  if (argsDelta !== '') call.arguments += argsDelta

  if (!call.started) {
    call.started = true
    state.hasToolCall = true
    state.hasContent = true
    out.push({ type: 'block-start', index: call.blockIndex, blockType: 'tool-call' })
  }
  if (argsDelta !== '' || out.length > 0) {
    out.push({
      type: 'tool-call-delta',
      index: call.blockIndex,
      id: toToolCallId(clampToolCallId(call.id)),
      name: call.name,
      argumentsDelta: argsDelta,
    })
  }
  return out
}

/** Feed one SSE `data:` payload from `/v1/messages`. */
export function processAnthropicStreamLine(line: string, state: KimiCodeStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || !trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return []
  const event = safeJsonParse(payload)
  if (!isRecord(event)) return []
  const type = asString(event.type)
  const out: StreamChunk[] = []

  if (type === 'message_start') {
    const message = isRecord(event.message) ? event.message : undefined
    const usage = message && isRecord(message.usage) ? message.usage : undefined
    if (usage) {
      state.sawUsage = true
      state.inputTokens = numberOr(usage.input_tokens, 0)
      state.cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0)
      state.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, 0)
      state.outputTokens = numberOr(usage.output_tokens, 0)
    }
    const stop = message ? asString(message.stop_reason) : undefined
    if (stop !== undefined) state.finishReason = stop
    return out
  }

  if (type === 'content_block_start') {
    const contentIndex = numberOr(event.index, 0)
    const block = isRecord(event.content_block) ? event.content_block : {}
    const blockType = asString(block.type)
    out.push(...closeCurrent(state))
    if (blockType === 'tool_use') {
      const index = state.blocks.length
      const pending: PendingToolCall = {
        blockIndex: index,
        id: asString(block.id) ?? `toolu_${contentIndex}`,
        name: asString(block.name) ?? '',
        arguments: '',
        started: true,
      }
      state.toolCalls.set(contentIndex, pending)
      state.contentIndexes.set(contentIndex, index)
      state.openContentIndex = contentIndex
      state.blocks.push({ type: 'tool-call', id: toToolCallId(clampToolCallId(pending.id)), name: pending.name, arguments: '' })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({
        type: 'tool-call-delta',
        index,
        id: toToolCallId(clampToolCallId(pending.id)),
        name: pending.name,
        argumentsDelta: '',
      })
      return out
    }
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      out.push(...openTextBlock(state, 'reasoning'))
      state.contentIndexes.set(contentIndex, state.current!.index)
      state.openContentIndex = contentIndex
      return out
    }
    // Text (and any unknown block type) starts a plain text block.
    out.push(...openTextBlock(state, 'text'))
    state.contentIndexes.set(contentIndex, state.current!.index)
    state.openContentIndex = contentIndex
    return out
  }

  if (type === 'content_block_delta') {
    const contentIndex = numberOr(event.index, 0)
    const delta = isRecord(event.delta) ? event.delta : {}
    const deltaType = asString(delta.type)

    if (deltaType === 'input_json_delta') {
      const pending = state.toolCalls.get(contentIndex)
      const partial = asString(delta.partial_json) ?? ''
      if (pending !== undefined) {
        pending.arguments += partial
        out.push({
          type: 'tool-call-delta',
          index: pending.blockIndex,
          id: toToolCallId(clampToolCallId(pending.id)),
          name: pending.name,
          argumentsDelta: partial,
        })
      }
      return out
    }

    const text = deltaType === 'thinking_delta'
      ? asString(delta.thinking)
      : asString(delta.text)
    if (text !== undefined && text !== '') {
      const index = state.contentIndexes.get(contentIndex) ?? state.current?.index
      const kind: 'text' | 'reasoning' = deltaType === 'thinking_delta' ? 'reasoning' : 'text'
      if (state.current === null || state.current.index !== index) {
        out.push(...closeCurrent(state))
        const next = state.blocks.length
        state.current = { index: next, type: kind, text: '' }
        state.blocks.push({ type: kind, text: '' })
        state.contentIndexes.set(contentIndex, next)
        out.push({ type: 'block-start', index: next, blockType: kind })
      }
      state.current.text += sanitizeText(text)
      state.hasContent = true
      out.push({
        type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
        index: state.current.index,
        text: sanitizeText(text),
      })
    }
    return out
  }

  if (type === 'content_block_stop') {
    const contentIndex = numberOr(event.index, 0)
    const pending = state.toolCalls.get(contentIndex)
    if (pending !== undefined) {
      state.toolCalls.delete(contentIndex)
      const block: ContentBlock = {
        type: 'tool-call',
        id: toToolCallId(clampToolCallId(pending.id)),
        name: pending.name,
        arguments: pending.arguments === '' ? '{}' : pending.arguments,
      }
      state.blocks[pending.blockIndex] = block
      out.push({ type: 'block-end', index: pending.blockIndex, block })
      return out
    }
    out.push(...closeCurrent(state))
    return out
  }

  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : undefined
    const stop = delta ? asString(delta.stop_reason) : undefined
    if (stop !== undefined && stop !== '') state.finishReason = stop
    const usage = isRecord(event.usage) ? event.usage : undefined
    if (usage) {
      state.sawUsage = true
      state.outputTokens = numberOr(usage.output_tokens, state.outputTokens)
    }
    return out
  }

  if (type === 'message_stop') {
    state.done = true
    return closeStream(state)
  }

  // A mid-stream error event carries the provider's own diagnostic.
  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : {}
    throw new LlmError(
      `Kimi Code stream error: ${asString(error.message) ?? 'unknown error'}`,
      'PROVIDER_ERROR',
    )
  }

  return out
}

/**
 * Rolling per-process view of how well the prefix cache is working.
 *
 * Kimi's cache is automatic and content-hash based, so the only way to know
 * whether a session is actually benefiting is to watch the read ratio. It is a
 * diagnostic: nothing here changes a request.
 */
export interface KimiCodeCacheStats {
  /** Requests that reported usage. */
  requests: number
  /** Prompt tokens that were served from cache. */
  cachedTokens: number
  /** Prompt tokens that had to be processed fresh. */
  freshTokens: number
  /** Output tokens, which reasoning is billed against. */
  outputTokens: number
  /** Prompt tokens the provider counted as cache writes (always 0 on this route). */
  cacheWriteTokens: number
}

let cacheStats: KimiCodeCacheStats = {
  requests: 0,
  cachedTokens: 0,
  freshTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
}

/** Record one request's usage into the rolling totals. */
export function recordCacheStats(state: KimiCodeStreamState): void {
  if (!state.sawUsage) return
  cacheStats = {
    requests: cacheStats.requests + 1,
    cachedTokens: cacheStats.cachedTokens + state.cacheReadTokens,
    freshTokens: cacheStats.freshTokens + state.inputTokens,
    outputTokens: cacheStats.outputTokens + state.outputTokens,
    cacheWriteTokens: cacheStats.cacheWriteTokens + state.cacheWriteTokens,
  }
}

/** Current rolling totals, plus the derived hit ratio. */
export function getCacheStats(): KimiCodeCacheStats & { hitRatio: number | null } {
  const prompt = cacheStats.cachedTokens + cacheStats.freshTokens
  return { ...cacheStats, hitRatio: prompt === 0 ? null : cacheStats.cachedTokens / prompt }
}

/** Test seam and an explicit reset for a new session. */
export function resetCacheStats(): void {
  cacheStats = { requests: 0, cachedTokens: 0, freshTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }
}

function tokenUsage(state: KimiCodeStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: KimiCodeStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls' || reason === 'tool_use') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/** Flush every open block, then emit usage and the terminal finish. */
export function closeStream(state: KimiCodeStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) {
    // One accounting point per request, so the rolling cache ratio stays honest.
    recordCacheStats(state)
    out.push({ type: 'usage', usage: tokenUsage(state) })
  }
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/** Model families whose stream never carried a terminal event. */
export function assertStreamComplete(state: KimiCodeStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError('Kimi Code stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}
