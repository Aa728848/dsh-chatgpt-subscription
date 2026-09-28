/**
 * Provider-wire mapping for the MiniMax Code subscription.
 *
 * The subscription speaks Anthropic Messages, so this file builds a
 * \`/messages\` body and normalizes the SSE stream back into DSH's block/delta
 * vocabulary.
 *
 * WHAT IS REUSED, AND WHAT IS NOT
 *
 * The generic halves of this problem already exist beside it in
 * \`../kimi-code/mapper.ts\` and are imported rather than reimplemented: durable
 * image resolution, the image budget that drops the oldest attachments first,
 * JSON-Schema cleanup for tool parameters, and the serialized-body guard. None of
 * those is provider-specific, and having one implementation is what keeps the two
 * lines from drifting.
 *
 * The provider-specific halves are written here:
 *
 * - the thinking control. The subscription's own model table names its thinking
 *   vocabulary (M2.7 always on with no level, M3 a two-state switch, M3.1 forced
 *   on with a level), which is not Kimi's low/high/max ladder; and
 * - every diagnostic string, because an error a user reads must name the service
 *   they are actually talking to.
 *
 * WHAT IS MEASURED AND WHAT IS INFERRED
 *
 * Measured (brief sections 2.1 and 2.3): the endpoint, the URL shape
 * \`<base>/mavis/api/v1/llm/v1/messages\`, the bearer header, the Anthropic
 * protocol revision, the request body \`{model, max_tokens, messages}\` answering
 * 200, and the four usage counters in the response.
 *
 * Inferred, and isolated in \`thinkingFieldFor\` so it is the only thing to change if
 * it is ever contradicted: the \`thinking\` object's exact shape. The model table
 * describes thinking as a state ("none-thinking / thinking") and, for M3.1, as an
 * \`effort\` level, so the field is emitted in that vocabulary and nowhere else. No
 * other undocumented field is ever sent.
 */

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
import { toToolCallId } from '../common/brand-compat.ts'
import {
  MAX_MESSAGE_BODY_BYTES,
  offloadOldestRequestImages,
  resolveRequestImages,
  stripMetaSchema,
  type AttachmentImageReader,
  type ResolvedRequestImages,
} from '../kimi-code/mapper.ts'
import {
  effortForModel,
  isThinkingDisabledEffort,
  minimaxCodeModelDef,
  type MinimaxCodeCatalogModel,
} from './model-catalog.ts'
import {
  ANTHROPIC_VERSION,
  CONTEXT_HEADROOM_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_NAME,
} from './types.ts'

export { MAX_MESSAGE_BODY_BYTES, offloadOldestRequestImages, resolveRequestImages }
export type { AttachmentImageReader, ResolvedRequestImages }

/** Anthropic content blocks are plain JSON objects on the wire. */
type AnthropicBlock = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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

/** Media types the wire accepts as inline base64. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function attachmentOf(block: Record<string, unknown>): Record<string, unknown> | undefined {
  const attachment = block.attachment
  return isRecord(attachment) ? attachment : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = attachmentOf(block)
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

/** Text that stands in for an attachment whose bytes could not be read. */
function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  return '[image unavailable: ' + (label === undefined ? 'the attachment could not be read' : label)
    + ' could not be read from local storage. Ask the user to attach it again.]'
}

/**
 * Inline base64 image block for one DSH image block, or undefined when the bytes
 * are missing or in a media type the wire does not accept.
 */
function imageBlockToAnthropic(
  block: Record<string, unknown>,
  images: ResolvedRequestImages,
): AnthropicBlock | undefined {
  const attachment = attachmentOf(block)
  const attachmentId = asString(attachment?.attachmentId)
  if (attachmentId === undefined) return undefined
  const resolved = images.get(attachmentId)
  if (resolved === undefined || resolved.kind !== 'inline') return undefined
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(resolved.mediaType)) return undefined
  return { type: 'image', source: { type: 'base64', media_type: resolved.mediaType, data: resolved.data } }
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
  return blocks.map((block) => {
    if (!isRecord(block)) return ''
    if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
    if (block.type === 'tool-result') return toolResultText(block.content)
    // A result image is named, not inlined: the request body has a ceiling and
    // inlining every result image would break the request rather than enrich it.
    if (block.type === 'image') return '[image: ' + (attachmentLabel(block) ?? 'attached image') + ']'
    return ''
  }).join('')
}

/**
 * Anthropic \`tool_result\` content for one tool result, or undefined when the
 * result carries no image.
 *
 * Returning undefined is what keeps a plain tool result a byte-identical string on
 * the wire: only a result that actually holds pixels takes the block-array form.
 */
function toolResultBlocks(blocks: unknown, images: ResolvedRequestImages): AnthropicBlock[] | undefined {
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
      const inline = imageBlockToAnthropic(block, images)
      out.push(inline ?? { type: 'text', text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      const nested = toolResultBlocks(block.content, images)
      if (nested !== undefined) {
        hasImage = true
        out.push(...nested)
      }
    }
  }
  if (!hasImage) return undefined
  // The Messages wire requires at least one block, so the conservative shape wins.
  if (out[0]?.type !== 'text') out.unshift({ type: 'text', text: '' })
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

/**
 * Whether one message is a tool result.
 *
 * The provenance tag is what distinguishes it: a hand-built one-shot request may
 * carry messages without any source, and only a real tool-result message has one.
 */
function isToolResultMessage(message: Message): boolean {
  return message.source?.kind === 'tool'
}

/**
 * Concatenated system-prompt text.
 *
 * The system prompt is the head of the prefix the service caches, so this is a
 * pure, order-stable fold of its inputs: options.system always leads and message
 * text follows in history order. Nothing per-turn is added here, because one
 * changed byte at the head invalidates the whole cached prefix.
 */
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

function anthropicUserContent(message: Message, images: ResolvedRequestImages): AnthropicBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      const inline = imageBlockToAnthropic(block, images)
      blocks.push(inline ?? { type: 'text', text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      const callId = asString(block.toolCallId) ?? ''
      const resultBlocks = toolResultBlocks(block.content, images)
      blocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: resultBlocks ?? toolResultText(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
      })
      continue
    }
    if (block.type === 'video') {
      // The subscription documents video on M3 and M3.1, but DSH's attachment
      // service stores images only, so a video part that reaches this mapper has no
      // bytes behind it. Saying so beats sending an unverified field.
      blocks.push({
        type: 'text',
        text: '[video omitted: this route has no video byte reader installed, so the clip could not be sent]',
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
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string') {
      const parsed = safeJsonParse(toolCallArguments(block.arguments))
      blocks.push({
        type: 'tool_use',
        id: asString(block.id) ?? 'toolu_' + blocks.length,
        name: block.name,
        input: isRecord(parsed) ? parsed : {},
      })
    }
    // Reasoning blocks are dropped on this wire: a thinking block must carry the
    // provider signature that produced it, and an unsigned one is rejected.
  }
  return blocks
}

/**
 * Merge neighbouring same-role turns.
 *
 * DSH history can hold two user messages in a row (an injected context notice
 * followed by the real turn) and a tool result is itself a user-role message; the
 * Messages wire wants one user turn, so consecutive turns of one role are folded
 * together in order.
 */
function mergeAnthropicMessages(
  entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>,
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
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

/** The catalog entry for one request's model, or undefined when it is unknown. */
function catalogEntry(modelId: string): MinimaxCodeCatalogModel | undefined {
  return minimaxCodeModelDef(modelId)
}

/**
 * The thinking control for one request.
 *
 * This is the single inferred field in the builder, and it is kept to the
 * vocabulary the subscription's own model table uses:
 *
 * - \`always-on\` (M2.7, M2.7-highspeed): nothing is sent. The model always thinks
 *   and has no level, so any field would be decoration at best and a rejected one
 *   at worst;
 * - \`toggle\` (M3): the table names the two states "none-thinking / thinking", so
 *   the off state is the explicit disable and the on state is what a request that
 *   says nothing already gets;
 * - \`forced-effort\` (M3.1-Flash-Preview): thinking is forced on and the table
 *   gives the level in an \`effort\` field, so the level travels there.
 *
 * A caller asking for a level the model does not list is mapped to the model's
 * documented default by \`effortForModel\` before it reaches here.
 */
export function thinkingFieldFor(
  modelId: string,
  requestedEffort: string | undefined | null,
): Record<string, unknown> | undefined {
  const model = catalogEntry(modelId)
  if (model === undefined) return undefined
  const disabled = isThinkingDisabledEffort(requestedEffort)
  if (model.thinking === 'always-on') {
    // Nothing selectable and nothing to disable: the model table documents no way
    // to turn this off, so no field is sent.
    return undefined
  }
  if (disabled) {
    return model.thinking === 'toggle' ? { type: 'disabled' } : { type: 'disabled' }
  }
  if (model.thinking === 'toggle') return { type: 'enabled' }
  return {
    type: 'enabled',
    effort: effortForModel(modelId, requestedEffort ?? null),
  }
}

/** Output cap one request asks for, tracked against the model's declared ceiling. */
export function maxOutputTokensFor(modelId: string, contextWindow?: number): number {
  const model = catalogEntry(modelId)
  const declared = model?.maxTokens ?? DEFAULT_MAX_TOKENS
  const window = contextWindow ?? model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  return Math.max(1, Math.min(declared, window - CONTEXT_HEADROOM_TOKENS))
}

/** Reduce a requested cap so prompt plus output still fit the window. */
export function clampOutputToContext(
  requested: number,
  contextWindow: number,
  estimatedInputTokens?: number,
): number {
  if (estimatedInputTokens === undefined || !Number.isFinite(estimatedInputTokens)) return requested
  const available = contextWindow - Math.max(0, estimatedInputTokens) - CONTEXT_HEADROOM_TOKENS
  if (available <= 0) return Math.min(requested, CONTEXT_HEADROOM_TOKENS)
  return Math.min(requested, available)
}

/** Build one Anthropic Messages body for this subscription. */
export function buildMinimaxRequest(
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
  const thinking = thinkingFieldFor(options.model, options.reasoningEffort === undefined ? null : String(options.reasoningEffort))

  return {
    model: options.model,
    max_tokens: maxTokens,
    // Without this the service answers with one JSON message body instead of an
    // event stream, and the SSE reader in the adapter reports the complete answer
    // as a stream that ended before its terminal event. Every sibling line that
    // consumes SSE asks for it here for the same reason.
    stream: true,
    messages: mergeAnthropicMessages(entries),
    ...(system === undefined ? {} : { system }),
    // Thinking and an explicit temperature are mutually exclusive on this
    // protocol, so the temperature is dropped whenever thinking is engaged.
    ...(options.temperature === undefined || thinking !== undefined ? {} : { temperature: options.temperature }),
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
    ...(thinking === undefined ? {} : { thinking }),
  }
}

/**
 * Reject a request the service would refuse, before sending it.
 *
 * @returns the serialized body, so the caller about to send it does not serialize
 * a multi-megabyte string a second time.
 */
export function assertRequestBodyFits(body: Record<string, unknown>): string {
  const serialized = JSON.stringify(body)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= MAX_MESSAGE_BODY_BYTES) return serialized
  throw new LlmError(
    PROVIDER_NAME + ' request was not sent: the serialized body is ' + bytes + ' bytes, above the '
    + MAX_MESSAGE_BODY_BYTES + '-byte ceiling this route enforces. Compact the conversation or start a new '
    + 'session, and check for large tool results or attached media.',
    'PROVIDER_ERROR',
  )
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** One tool call accumulating across content-block deltas. */
interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
}

/** Stream accumulator for one Messages response. */
export interface MinimaxStreamState {
  blocks: OutboundContentBlock[]
  current: { index: number; type: 'text' | 'reasoning'; text: string } | null
  /** wire content-block index -> accumulating call. */
  toolCalls: Map<number, PendingToolCall>
  /** wire content-block index -> our block index. */
  contentIndexes: Map<number, number>
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  done: boolean
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  sawUsage: boolean
}

export function createStreamState(): MinimaxStreamState {
  return {
    blocks: [],
    current: null,
    toolCalls: new Map(),
    contentIndexes: new Map(),
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    done: false,
    finished: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sawUsage: false,
  }
}

function closeCurrent(state: MinimaxStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function openTextBlock(state: MinimaxStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  const out = closeCurrent(state)
  const index = state.blocks.length
  state.current = { index, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return out
}

function closeToolCalls(state: MinimaxStreamState): StreamChunk[] {
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

function tokenUsage(state: MinimaxStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
  }
}

function finishReasonFor(state: MinimaxStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_use' || reason === 'tool_calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/** Flush every open block, then emit usage and the terminal finish. */
export function closeMinimaxStream(state: MinimaxStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/** Raise when a stream ended without the terminal event the protocol promises. */
export function assertStreamComplete(state: MinimaxStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError(PROVIDER_NAME + ' stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}

/** Feed one SSE line from the Messages endpoint. */
export function processMinimaxStreamLine(line: string, state: MinimaxStreamState): StreamChunk[] {
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
    const usage = message !== undefined && isRecord(message.usage) ? message.usage : undefined
    if (usage !== undefined) {
      state.sawUsage = true
      state.inputTokens = numberOr(usage.input_tokens, 0)
      state.cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0)
      state.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, 0)
      state.outputTokens = numberOr(usage.output_tokens, 0)
    }
    const stop = message === undefined ? undefined : asString(message.stop_reason)
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
      const id = asString(block.id) ?? 'toolu_' + contentIndex
      const name = asString(block.name) ?? ''
      state.toolCalls.set(contentIndex, { blockIndex: index, id, name, arguments: '' })
      state.contentIndexes.set(contentIndex, index)
      state.blocks.push({ type: 'tool-call', id: toToolCallId(id), name, arguments: '' })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: toToolCallId(id), name, argumentsDelta: '' })
      return out
    }
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      out.push(...openTextBlock(state, 'reasoning'))
      state.contentIndexes.set(contentIndex, state.current!.index)
      return out
    }
    out.push(...openTextBlock(state, 'text'))
    state.contentIndexes.set(contentIndex, state.current!.index)
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

    const text = deltaType === 'thinking_delta' ? asString(delta.thinking) : asString(delta.text)
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
    const stop = delta === undefined ? undefined : asString(delta.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    const usage = isRecord(event.usage) ? event.usage : undefined
    if (usage !== undefined) {
      state.sawUsage = true
      state.outputTokens = numberOr(usage.output_tokens, state.outputTokens)
    }
    return out
  }

  if (type === 'message_stop') {
    state.done = true
    return closeMinimaxStream(state)
  }

  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : {}
    throw new LlmError(
      PROVIDER_NAME + ' stream error: ' + (asString(error.message) ?? 'unknown error'),
      'PROVIDER_ERROR',
    )
  }

  return out
}

/** Whether one chunk stream carried any assistant content at all. */
export function streamHasContent(state: MinimaxStreamState): boolean {
  return state.hasContent
}

export { ANTHROPIC_VERSION, type ContentBlock }
