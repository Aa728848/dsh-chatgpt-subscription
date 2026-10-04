/**
 * Provider-wire mapping for the two Command Code provider endpoints.
 *
 * The API serves Anthropic-format models on `/messages` and everything else on
 * `/chat/completions`; it validates the split and rejects a model sent to the
 * wrong endpoint. Both wires are mapped here so one adapter can serve the whole
 * catalog, and both streams are normalized into DSH's block/delta vocabulary.
 *
 * https://commandcode.ai/blog/command-code-provider-api
 */

import { CONTEXT_OVERFLOW_CODE, isContextOverflow } from '../common/context-overflow.ts'
import {
  LlmError,
  type ContentBlock,
  type OutboundContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '../common/llm-compat.ts'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { toToolCallId } from '../common/brand-compat.ts'
import { anthropicThinkingBudget, maxOutputTokensFor, wireReasoningEffort } from './types.ts'
import type { CommandCodeWire } from '../../shared/command-code-contracts.ts'

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
 * Both Command Code endpoints are proxies: the body is forwarded to whichever
 * upstream serves the model, so the bound has to hold for the strictest of
 * them. 12 MB matches what this plugin already allows its Gemini route and
 * keeps the conversation text, tool schemas, and system prompt inside the same
 * body.
 */
export const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its image limit; older images are omitted first. '
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
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const attachment = attachmentOf(block)
      if (attachment) refs.set(attachment.attachmentId, attachment)
      continue
    }
    // Tool results nest their own content, and a screenshot or a read_image
    // result carries its pixels there. Stopping at the top level made every
    // tool-produced image unresolvable before it could reach the wire.
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
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
      // A tool-result image is named, not inlined; DSH's own multi-provider
      // adapter flattens a tool result to text, so naming it already keeps more
      // of the loss visible than that reference route does.
      if (block.type === 'image') return `[image: ${attachmentLabel(block) ?? 'attached image'}]`
      return ''
    })
    .join('')
}

/**
 * Anthropic `tool_result` content for one tool result, or `undefined` when the
 * result carries no image. Returning `undefined` is what keeps a plain tool
 * result a byte-identical string on the wire: the image-less path never changes
 * shape, so only results that actually hold pixels take the block-array form.
 */
function toolResultBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
): AnthropicBlock[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const out: AnthropicBlock[] = []
  let hasImage = false
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: sanitizeText(block.text) })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
      } else {
        out.push({ type: 'text', text: unavailableImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result') {
      const nested = toolResultBlocks(block.content, images)
      if (nested) {
        hasImage = true
        out.push(...nested)
      }
    }
  }
  if (!hasImage) return undefined
  // Anthropic requires at least one block; keep the shape conservative.
  if (out[0]?.type !== 'text') out.unshift({ type: 'text', text: '' })
  return out
}

/**
 * OpenAI `image_url` blocks for one tool result. A `role: "tool"` message can
 * only carry text, so these ride on a `user` message appended after the run of
 * tool messages rather than inside it.
 */
function toolResultImageBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
): OpenAIMessage[] {
  if (!Array.isArray(blocks)) return []
  const out: OpenAIMessage[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        out.push({ type: 'text', text: unavailableImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...toolResultImageBlocks(block.content, images))
  }
  return out
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

function stopSequences(stop: unknown): string[] | undefined {
  if (Array.isArray(stop)) {
    const list = stop.filter((s): s is string => typeof s === 'string' && s !== '')
    return list.length > 0 ? list : undefined
  }
  if (typeof stop === 'string' && stop !== '') return [stop]
  return undefined
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

// ---------------------------------------------------------------------------
// OpenAI Chat Completions request
// ---------------------------------------------------------------------------

/** Models that reject `max_tokens` in favour of `max_completion_tokens`. */
function wantsCompletionTokens(modelId: string): boolean {
  return /^(gpt-5|gpt-6|o[1-9])/i.test(modelId.trim())
}

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

function openAIAssistantContent(message: Message): { content: string; toolCalls: OpenAIMessage[] } {
  const textParts: string[] = []
  const toolCalls: OpenAIMessage[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(sanitizeText(block.text))
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_${toolCalls.length}`,
        type: 'function',
        function: { name: block.name, arguments: toolCallArguments(block.arguments) },
      })
    }
    // Reasoning blocks are never replayed: none of the served upstreams accept
    // a thinking block without the provider signature that produced it.
  }
  return { content: textParts.join(''), toolCalls }
}

/** Build one `/chat/completions` body. */
export function buildOpenAIRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = []
  const system = leadingSystemText(options)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    if (isToolResultMessage(message)) {
      // Parallel tool calls emit several consecutive `role: "tool"` messages, and
      // a strict upstream rejects a `user` message wedged between them. So the
      // whole run is scanned, every image in it is collected, and a single `user`
      // message carrying them is appended once the run ends.
      const imageBlocks: OpenAIMessage[] = []
      while (index < conversation.length && isToolResultMessage(conversation[index]!)) {
        const current = conversation[index]!
        const block = current.content[0]
        const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: callId, content: toolResultText(current.content) })
        imageBlocks.push(...toolResultImageBlocks(current.content, images))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) messages.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls } = openAIAssistantContent(message)
      const entry: OpenAIMessage = { role: 'assistant', content }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      // An assistant turn with neither text nor calls carries nothing on this wire.
      if (content !== '' || toolCalls.length > 0) messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  // `none` is expressed by omitting the field on this wire; Command Code has no
  // `off`/`none` reasoning_effort level to send.
  const effort = wireReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(wantsCompletionTokens(options.model)
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) },
          })),
          tool_choice: 'auto',
        }
      : {}),
    ...(effort === undefined || effort === '' ? {} : { reasoning_effort: effort }),
  }
  return body
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
      // A tool result with an image becomes the block-array form Anthropic
      // natively supports; one without stays exactly the string it was.
      const resultBlocks = toolResultBlocks(block.content, images)
      blocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: resultBlocks ?? toolResultText(block.content),
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
        id: typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${blocks.length}`,
        name: block.name,
        input: isRecord(parsed) ? parsed : {},
      })
    }
    // Reasoning blocks are dropped: a replayed thinking block needs the
    // provider signature, and no wire here accepts an unsigned one.
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

/** Reasoning budget a thinking-enabled request may spend, given its output cap. */
export function thinkingBudgetFor(effort: string | undefined, maxTokens: number): number | undefined {
  if (effort === undefined || effort === '') return undefined
  const requested = anthropicThinkingBudget(effort)
  if (requested === undefined || requested === null) return undefined
  // Anthropic requires the budget to be smaller than max_tokens and leaves room
  // for the visible answer; a request that cannot fit one simply omits thinking.
  const budget = Math.min(requested, maxTokens - 1024)
  return budget >= 1024 ? budget : undefined
}

/** Build one `/messages` body. */
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
  // A disabled-thinking level arrives as `none`/`off` and must not become a
  // thinking budget: omitting `thinking` entirely is how this wire says "do not
  // think".
  const requestEffort = wireReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  const budget = thinkingBudgetFor(requestEffort, maxTokens)

  return {
    model: options.model,
    max_tokens: maxTokens,
    messages: mergeAnthropicMessages(entries),
    ...(system === undefined ? {} : { system }),
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
    // Thinking and an explicit temperature are mutually exclusive on this wire.
    ...(budget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }),
  }
}

/** Build the body for whichever endpoint serves `modelId`. */
export function buildRequest(
  options: GenerateOptions,
  wire: CommandCodeWire,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  if (wire === 'anthropic') return buildAnthropicRequest(options, images)
  if (wire === 'responses') return buildResponsesRequest(options, images)
  return buildOpenAIRequest(options, images)
}

// ---------------------------------------------------------------------------
// OpenAI Responses request
// ---------------------------------------------------------------------------

/**
 * Build one `/responses` body.
 *
 * The Responses API takes a flat `input` list instead of `messages`, and its
 * reasoning and tool calls are item types rather than message fields. This is a
 * separate builder rather than a reshaping of the Chat Completions one: the two
 * APIs differ in more than field names, and a translated body is a request the
 * route rejects.
 */
function responsesUserContent(
  message: Message,
  images: ResolvedRequestImages,
): Array<Record<string, unknown>> {
  if (!Array.isArray(message.content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') parts.push({ type: 'input_text', text })
    } else if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        parts.push({ type: 'input_image', image_url: 'data:' + inline.mediaType + ';base64,' + inline.data })
      } else {
        parts.push({ type: 'input_text', text: unavailableImageText(block) })
      }
    }
  }
  return parts
}

function responsesToolResultImageBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
): Array<Record<string, unknown>> {
  if (!Array.isArray(blocks)) return []
  const out: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'input_image', image_url: 'data:' + inline.mediaType + ';base64,' + inline.data })
      } else {
        out.push({ type: 'input_text', text: unavailableImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...responsesToolResultImageBlocks(block.content, images))
  }
  return out
}

export function buildResponsesRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = []
  const system = leadingSystemText(options)
  const conversation = nonSystemMessages(options)

  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    if (isToolResultMessage(message)) {
      // Results stay consecutive: a message wedged between them is rejected.
      const imageBlocks: Array<Record<string, unknown>> = []
      while (index < conversation.length && isToolResultMessage(conversation[index]!)) {
        const current = conversation[index]!
        const toolResult = Array.isArray(current.content)
          ? current.content.find((b) => isRecord(b) && b.type === 'tool-result')
          : undefined
        const callId = (isRecord(toolResult) && typeof toolResult.toolCallId === 'string' ? toolResult.toolCallId : '')
          || (typeof current.source?.callId === 'string' ? current.source.callId : '')
        input.push({ type: 'function_call_output', call_id: callId, output: toolResultText(current.content) })
        imageBlocks.push(...responsesToolResultImageBlocks(current.content, images))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) input.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls } = openAIAssistantContent(message)
      if (content !== '') input.push({ role: 'assistant', content })
      for (const call of toolCalls) {
        // Chat Completions nests the name and arguments one level down under
        // `function`; the Responses item type carries them flat. Reading the
        // nested shape's top level would emit a tool call with no name and no
        // arguments, which the next turn's history cannot use.
        const fn = isRecord(call.function) ? call.function : undefined
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: typeof fn?.name === 'string' ? fn.name : '',
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
        })
      }
      continue
    }
    const content = responsesUserContent(message, images)
    if (content.length === 0) continue
    input.push({ role: 'user', content })
  }

  const effort = wireReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  return {
    model: options.model,
    input,
    stream: true,
    max_output_tokens: maxTokens,
    ...(system === undefined ? {} : { instructions: system }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: stripMetaSchema(tool.parameters),
          })),
          tool_choice: 'auto',
        }
      : {}),
    ...(effort === undefined || effort === '' ? {} : { reasoning: { effort } }),
  }
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

export interface CommandCodeStreamState {
  wire: CommandCodeWire
  blocks: OutboundContentBlock[]
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

export function createStreamState(wire: CommandCodeWire): CommandCodeStreamState {
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

function closeCurrent(state: CommandCodeStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: CommandCodeStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const [wireIndex, call] of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const block: OutboundContentBlock = {
      type: 'tool-call',
      id: toToolCallId(call.id),
      name: call.name,
      arguments: call.arguments === '' ? '{}' : call.arguments,
    }
    state.blocks[call.blockIndex] = block
    out.push({ type: 'block-end', index: call.blockIndex, block })
    state.toolCalls.delete(wireIndex)
  }
  return out
}

function openTextBlock(state: CommandCodeStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  const out = closeCurrent(state)
  const index = state.blocks.length
  state.current = { index, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return out
}

/** Feed one SSE `data:` payload from `/chat/completions`. */
export function processOpenAIStreamLine(line: string, state: CommandCodeStreamState): StreamChunk[] {
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

  if (isRecord(chunk.error)) {
    throw new LlmError(
      `Command Code stream error: ${asString(chunk.error.message) ?? 'unknown error'}`,
      isContextOverflow(chunk.error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
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

function applyOpenAIToolDelta(entry: Record<string, unknown>, state: CommandCodeStreamState): StreamChunk[] {
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
    state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' })
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
      id: toToolCallId(call.id),
      name: call.name,
      argumentsDelta: argsDelta,
    })
  }
  return out
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Feed one SSE `data:` payload from `/messages`. */
export function processAnthropicStreamLine(line: string, state: CommandCodeStreamState): StreamChunk[] {
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
    if (stop !== undefined && stop !== null) state.finishReason = stop
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
      state.blocks.push({ type: 'tool-call', id: toToolCallId(pending.id), name: pending.name, arguments: '' })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({
        type: 'tool-call-delta',
        index,
        id: toToolCallId(pending.id),
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
          id: toToolCallId(pending.id),
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
      const block: OutboundContentBlock = {
        type: 'tool-call',
        id: toToolCallId(pending.id),
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
      `Command Code stream error: ${asString(error.message) ?? 'unknown error'}`,
      isContextOverflow(error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  return out
}

function tokenUsage(state: CommandCodeStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: CommandCodeStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls' || reason === 'tool_use') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Fold one SSE line from `/responses`.
 *
 * The Responses stream is event-typed rather than delta-shaped: text arrives as
 * `response.output_text.delta`, tool calls as `function_call_arguments.delta`
 * keyed by an item id, and the turn ends on `response.completed` or
 * `response.failed`. Those are read as written; there is no Chat Completions
 * shape to reinterpret.
 */
export function processResponsesStreamLine(line: string, state: CommandCodeStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []

  const type = typeof parsed.type === 'string' ? parsed.type : ''
  if (type === 'response.output_text.delta') {
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    if (delta === '') return []
    state.hasContent = true
    const opened = openBlock(state, 'text')
    state.current!.text += delta
    return [...opened, { type: 'text-delta', index: state.current!.index, text: delta }]
  }
  if (type === 'response.reasoning_summary_text.delta') {
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    if (delta === '') return []
    state.hasContent = true
    const opened = openBlock(state, 'reasoning')
    state.current!.text += delta
    return [...opened, { type: 'reasoning-delta', index: state.current!.index, text: delta }]
  }
  if (type === 'response.output_item.added') {
    const item = isRecord(parsed.item) ? parsed.item : null
    if (item === null || item.type !== 'function_call') return []
    return startResponsesToolCall(state, parsed, item)
  }
  if (type === 'response.function_call_arguments.delta') {
    const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
    const call = responsesToolCall(state, parsed.item_id ?? parsed.call_id)
    if (call === undefined || delta === '') return []
    call.arguments += delta
    return [{
      type: 'tool-call-delta',
      index: call.blockIndex,
      id: toToolCallId(call.id),
      name: call.name,
      argumentsDelta: delta,
    }]
  }
  if (type === 'response.function_call_arguments.done') {
    const call = responsesToolCall(state, parsed.item_id ?? parsed.call_id)
    if (call === undefined) return []
    if (typeof parsed.arguments === 'string') call.arguments = parsed.arguments
    return []
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = isRecord(parsed.response) ? parsed.response : null
    if (response !== null) {
      if (response.status === 'failed') {
        state.done = true
        const errorObj = isRecord(response.error) ? response.error : null
        const detail = errorObj && typeof errorObj.message === 'string'
          ? errorObj.message
          : (typeof response.error === 'string' ? response.error : '')
        throw new LlmError(
          detail === '' ? 'Command Code responses stream failed' : `Command Code responses stream failed: ${detail}`,
          'PROVIDER_ERROR',
        )
      }
      readResponsesUsage(response, state)
    }
    state.done = true
    if (type === 'response.incomplete') {
      const details = response && isRecord(response.incomplete_details) ? response.incomplete_details : null
      const reason = details && typeof details.reason === 'string' ? details.reason : ''
      state.finishReason = reason === 'max_output_tokens' || reason === 'length' || reason === 'max_tokens' ? 'length' : (reason || 'length')
    } else {
      state.finishReason = 'stop'
    }
    return []
  }
  if (type === 'response.failed' || type === 'error') {
    state.done = true
    const errorObj = isRecord(parsed.error)
      ? parsed.error
      : (isRecord(parsed.response) && isRecord(parsed.response.error) ? parsed.response.error : null)
    const detail = (typeof parsed.message === 'string' ? parsed.message : '')
      || (errorObj && typeof errorObj.message === 'string' ? errorObj.message : '')
      || (isRecord(parsed.response) && typeof parsed.response.error === 'string'
          ? parsed.response.error
          : (typeof parsed.error === 'string' ? parsed.error : ''))
    throw new LlmError(
      detail === '' ? 'Command Code responses stream failed' : `Command Code responses stream failed: ${detail}`,
      isContextOverflow(errorObj ?? detail) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }
  return []
}

function openBlock(state: CommandCodeStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  if (state.current !== null && state.current.type === type) return []
  const out = closeCurrent(state)
  state.current = { index: state.blocks.length, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index: state.current.index, blockType: type })
  return out
}

function startResponsesToolCall(
  state: CommandCodeStreamState,
  event: Record<string, unknown>,
  item: Record<string, unknown>,
): StreamChunk[] {
  // Only the current text block closes: several function calls can be started
  // while an earlier one is still streaming arguments, and closing every pending
  // call here would truncate the earlier call's arguments.
  const out = closeCurrent(state)
  // Each tool call owns its own block index. Reserving the block index immediately
  // prevents interleaved text or subsequent calls from colliding with pending calls.
  const index = state.blocks.length
  const name = typeof item.name === 'string' ? item.name : ''
  // Two different identifiers, and they are not interchangeable: `item.id`
  // names the output item in output_item.added, while subsequent argument events
  // carry `item_id`. `call_id` is the tool call id the model references.
  const itemId = typeof item.id === 'string' ? item.id : (typeof event.item_id === 'string' ? event.item_id : null)
  const id = typeof item.call_id === 'string' ? item.call_id : `call_${String(itemId ?? index)}`
  const call = { blockIndex: index, id, name, arguments: '', started: true }
  state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name, arguments: '' })
  state.toolCalls.set(index, call)
  if (itemId !== null) responsesItemIndexOf(state).set(itemId, call)
  state.hasToolCall = true
  out.push({ type: 'block-start', index, blockType: 'tool-call' })
  out.push({ type: 'tool-call-delta', index, id: toToolCallId(call.id), name, argumentsDelta: '' })
  return out
}

/** Item id -> call, held beside the stream state that produced it. */
const responsesItemIndex = new WeakMap<CommandCodeStreamState, Map<string, PendingToolCall>>()


function responsesItemIndexOf(state: CommandCodeStreamState): Map<string, PendingToolCall> {
  let index = responsesItemIndex.get(state)
  if (index === undefined) {
    index = new Map<string, PendingToolCall>()
    responsesItemIndex.set(state, index)
  }
  return index
}

/**
 * The call a function-arguments event refers to.
 *
 * The event carries `item_id` while the recorded call carries `call_id`, so
 * matching on the call id alone silently dropped every argument delta. The
 * call-id fallback stays for a provider that only sends one of the two.
 */
function responsesToolCall(state: CommandCodeStreamState, key: unknown): PendingToolCall | undefined {
  if (typeof key !== 'string' || key === '') return undefined
  const byItem = responsesItemIndex.get(state)
  const match = byItem?.get(key)
  if (match !== undefined) return match
  for (const call of state.toolCalls.values()) {
    if (call.id === toToolCallId(key)) return call
  }
  return undefined
}

function readResponsesUsage(response: Record<string, unknown>, state: CommandCodeStreamState): void {
  const usage = isRecord(response.usage) ? response.usage : null
  if (usage === null) return
  const cached = isRecord(usage.input_tokens_details) ? numberOrZero(usage.input_tokens_details.cached_tokens) : 0
  const written = isRecord(usage.input_tokens_details) ? numberOrZero(usage.input_tokens_details.cache_write_tokens) : 0
  state.inputTokens = Math.max(0, numberOrZero(usage.input_tokens) - cached - written)
  state.cacheReadTokens = cached
  state.cacheWriteTokens = written
  state.outputTokens = numberOrZero(usage.output_tokens)
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
  if (outputDetails !== null) state.reasoningTokens = numberOrZero(outputDetails.reasoning_tokens)
  state.sawUsage = true
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Flush every open block, then emit usage and the terminal finish. */
export function closeStream(state: CommandCodeStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/** Model families whose stream never carried a terminal event. */
export function assertStreamComplete(state: CommandCodeStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError('Command Code stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}
