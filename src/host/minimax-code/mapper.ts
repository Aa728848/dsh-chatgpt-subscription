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
 * JSON-Schema cleanup for tool parameters. None of those is provider-specific,
 * and having one implementation is what keeps the two lines from drifting.
 *
 * The serialized-body guard is deliberately NOT in that shared list. It looks
 * generic and is not: the byte ceiling it enforces is a property of the upstream
 * gateway, so Kimi's 2 MB figure was Kimi's and had no standing here. It was
 * imported anyway, and the cost was a local refusal on conversations this route
 * would have served. The shape of the check is shared; the number is per-route,
 * and \`maxMessageBodyBytes\` in ./types.ts is where the number lives.
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
 *
 * PROMPT CACHING IS ON BY DEFAULT, AND IT IS THE REQUEST THAT TURNS IT ON
 *
 * MiniMax documents two caching mechanisms, and they are not interchangeable:
 *
 * - an AUTOMATIC cache on its native API, which needs no marker at all; and
 * - an EXPLICIT cache on its Anthropic-compatible API, where the
 *   `cache_control` breakpoints are what create the cache at all
 *   (`tools` -> `system` -> `messages`, at most MAX_CACHE_BREAKPOINTS per
 *   request, per the "Explicit Prompt Caching (Anthropic API)" page of the
 *   MiniMax docs).
 *
 * This line speaks the Anthropic dialect, so the explicit mechanism is the one
 * that applies: a request with no breakpoint gets no `cache_read_input_tokens`
 * back no matter how identical its bytes are turn over turn, which is exactly
 * why this route showed no cache hits before the markers went in.
 *
 * The shape is the Claude line's (claude/mapper.ts, section 7), because the
 * wire vocabulary is the same and that shape is the one MiniMax's
 * explicit-caching page documents: breakpoints on the LAST system block, the
 * last block of the LAST user message, and the last tool. The first requires
 * `system` to go out as a block array rather than the plain string this line
 * was first measured with, so the array form is used only while caching is on -
 * a caller that opts out (MinimaxRequestOptions.cacheControl === false) gets
 * the original string body byte-for-byte.
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
import { toToolCallId } from '../common/brand-compat.ts'
import {
  estimatedInputTokens,
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
import { createHash } from 'node:crypto'
import {
  ANTHROPIC_VERSION,
  CONTEXT_HEADROOM_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_MESSAGE_BODY_BYTES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  PROVIDER_NAME,
  maxMessageBodyBytes,
  maxRequestImageBytes,
} from './types.ts'

export {
  DEFAULT_MAX_MESSAGE_BODY_BYTES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  estimatedInputTokens,
  maxMessageBodyBytes,
  maxRequestImageBytes,
  offloadOldestRequestImages,
  resolveRequestImages,
}
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

/** Provenance scope for safe thinking replay. */
export interface MinimaxReplayScope {
  route: string
  model: string
  authOwner: string
  provider?: string
}

function jsonSafeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) return undefined
      return Object.is(value, -0) ? 0 : value
    case 'object':
      break
    default:
      return undefined
  }
  if (seen.has(value)) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item) => jsonSafeValue(item, seen) ?? null)
    }
    const record: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const child = jsonSafeValue((value as Record<string, unknown>)[key], seen)
      if (child !== undefined) record[key] = child
    }
    return record
  } finally {
    seen.delete(value)
  }
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

/**
 * Native blocks to replay for one assistant turn, as the service issued them.
 *
 * Read from the message's stored replay state rather than rebuilt from the
 * visible reasoning text: a rebuilt block is not the block the model signed, and
 * the difference is exactly what the provider validates. Falls back to nothing
 * when a turn carries no stored state, which is the current behaviour for
 * history this route did not produce.
 */
/** Fingerprint the entire array of emitted visible blocks in an assistant message. */
function computeVisibleContentHash(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const canonical = blocks.map((b) => {
    if (!isRecord(b)) return null
    const type = asString(b.type) ?? ''
    if (type === 'text' || type === 'reasoning') return [type, sanitizeText(asString(b.text) ?? '')]
    if (type === 'tool-call') return [type, asString(b.id) ?? '', asString(b.name) ?? '', toolCallArguments(b.arguments)]
    return [type, jsonSafeValue(b)]
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}

/**
 * Verbatim wire block to replay for one reasoning block.
 *
 * Verifies route, model, and auth owner provenance. Fails safely on legacy unscoped state
 * or any mismatch, dropping the replay block rather than submitting invalid state.
 * Preserves raw native text and signature binding.
 */
function replayedThinkingBlock(
  message: Message,
  index: number,
  expectedScope?: MinimaxReplayScope,
  block?: Record<string, unknown>,
): AnthropicBlock | undefined {
  const source = message.source
  if (source === undefined || source === null || !isRecord(source)) return undefined
  // Check source provider and model when declared
  if (source.provider && source.provider !== PROVIDER_ID && source.provider !== 'dsh-chatgpt-subscription') {
    return undefined
  }
  if (source.model && expectedScope && source.model !== expectedScope.model) {
    return undefined
  }
  const state = source.replayState
  if (!isRecord(state)) return undefined

  // Inspect provenance envelope (handles both state.response and flattened state)
  const resp = isRecord(state.response) ? state.response : state
  const stateRoute = asString(resp.route) ?? asString(resp.provider)
  const stateModel = asString(resp.model)
  const stateAuthOwner = asString(resp.authOwner)

  // Fail safely on legacy unscoped state: all three scope fields MUST be non-empty strings
  if (!stateRoute || !stateModel || !stateAuthOwner || stateAuthOwner.trim() === '') {
    return undefined
  }

  // Provenance verification against expectedScope: empty authOwner never creates an accepted scope
  if (expectedScope === undefined) return undefined
  if (expectedScope.route && stateRoute !== expectedScope.route) return undefined
  if (expectedScope.model && stateModel !== expectedScope.model) return undefined
  if (!expectedScope.authOwner || expectedScope.authOwner.trim() === '' || stateAuthOwner !== expectedScope.authOwner) {
    return undefined
  }

  // Retrieve native block by block-index mapping, response.blocks, or response.nativeBlocks
  let candidate: AnthropicBlock | undefined
  if (Array.isArray(state.blocks)) {
    const entry = state.blocks[index]
    if (isRecord(entry)) candidate = entry as AnthropicBlock
  }
  if (candidate === undefined && Array.isArray(resp.blocks)) {
    const entry = resp.blocks[index]
    if (isRecord(entry)) candidate = entry as AnthropicBlock
  }
  if (candidate === undefined && Array.isArray(resp.nativeBlocks)) {
    const entry = resp.nativeBlocks[index]
    if (isRecord(entry)) candidate = entry as AnthropicBlock
  }

  if (candidate === undefined) return undefined

  // Envelope binding: reject if turn blocks were compacted, reordered, or truncated
  if (Array.isArray(state.blocks) && state.blocks.length !== message.content.length) return undefined
  if (Array.isArray(resp.blocks) && resp.blocks.length !== message.content.length) return undefined

  // Full content hash binding: require nonempty visibleContentHash and exact match
  const stateVisibleHash = asString(resp.visibleContentHash)
  if (!stateVisibleHash || stateVisibleHash.trim() === '') return undefined
  if (computeVisibleContentHash(message.content) !== stateVisibleHash) return undefined

  // Authoritative raw signed block: require candidate.type exactly 'thinking' or 'redacted_thinking'
  if (candidate.type !== 'thinking' && candidate.type !== 'redacted_thinking') {
    return undefined
  }

  const visibleText = asString(block?.text) ?? ''

  if (candidate.type === 'redacted_thinking') {
    // Redacted thinking carries no visible text
    if (visibleText !== '') return undefined
    const data = asString(candidate.data)
    if (!data || data.trim() === '') return undefined
    return structuredClone(candidate)
  }

  // Candidate is 'thinking': strictly bind candidate native text to visible reasoning text
  const nativeThinking = asString(candidate.thinking) ?? ''
  if (sanitizeText(nativeThinking) !== sanitizeText(visibleText)) {
    return undefined
  }
  const signature = asString(candidate.signature)
  if (!signature || signature.trim() === '') return undefined

  return structuredClone(candidate)
}

function anthropicAssistantContent(
  message: Message,
  expectedScope?: MinimaxReplayScope,
): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks

  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index]
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
      continue
    }

    if (block.type === 'reasoning') {
      const replay = replayedThinkingBlock(message, index, expectedScope, block)
      if (replay !== undefined) {
        blocks.push(replay)
      }
      continue
    }
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
    // Both remaining modes accept the same off switch, so there is one shape to
    // send. `always-on` never reaches here (it returns above): the model table
    // documents no way to turn it off, and inventing one would be a field the
    // service never agreed to.
    return { type: 'disabled' }
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

/**
 * Breakpoint budget the wire enforces.
 *
 * MiniMax's explicit-caching page caps a request at four `cache_control`
 * markers, the same number Anthropic allows (claude/mapper.ts). This module
 * marks at most three (see the module doc), so the budget is never the binding
 * constraint - the constant exists so a test can assert that against the REAL
 * number rather than a magic three.
 */
export const MAX_CACHE_BREAKPOINTS = 4

/**
 * Block types the wire accepts a cache_control marker on.
 *
 * A marker on any other block is a request the server rejects, so the last
 * block of the last user message is marked only when its type is one of these
 * (the same set the Claude line guards on, since the wire vocabulary is the
 * same).
 */
const CACHE_MARKABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'tool_result'])

/**
 * The last block worth a cache breakpoint on the message list, if any.
 *
 * Marks the last block of the last USER message and nothing else, with two
 * load-bearing guards: the last message must be a user turn (a history ending
 * on an assistant turn - a prefill-shaped request - gets no message breakpoint
 * rather than a marker somewhere it was not asked for), and the block must be
 * one the wire accepts a marker on. An unmarkable block yields NO breakpoint
 * rather than one moved onto an earlier turn: an unmarked request is merely
 * uncached, while a marker on a block type the wire rejects fails the whole
 * turn.
 */
function lastCacheableUserBlock(messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>): AnthropicBlock | undefined {
  const lastMessage = messages[messages.length - 1]
  if (lastMessage === undefined || lastMessage.role !== 'user') return undefined
  const block = lastMessage.content[lastMessage.content.length - 1]
  if (block === undefined) return undefined
  return CACHE_MARKABLE_BLOCK_TYPES.has(String(block.type)) ? block : undefined
}

/**
 * Put the cache breakpoints on one built body, and report how many landed.
 *
 * Runs against the FINAL shape - the merged message list and the full tool
 * array - so the marker cannot land on a block the merge then moves.
 *
 * @param body - the built body, mutated in place: it was created by this module
 *   and has not been handed to a caller yet.
 * @returns the number of breakpoints written.
 */
function markMinimaxCacheBreakpoints(body: Record<string, unknown>): number {
  let marked = 0

  const system = body.system
  if (Array.isArray(system)) {
    const last = system[system.length - 1] as AnthropicBlock | undefined
    if (last !== undefined) {
      last.cache_control = { type: 'ephemeral' }
      marked += 1
    }
  }

  const messages = body.messages as Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> | undefined
  if (Array.isArray(messages)) {
    const target = lastCacheableUserBlock(messages)
    if (target !== undefined) {
      target.cache_control = { type: 'ephemeral' }
      marked += 1
    }
  }

  const tools = body.tools
  if (Array.isArray(tools) && tools.length > 0) {
    const last = tools[tools.length - 1] as AnthropicBlock | undefined
    if (last !== undefined) {
      last.cache_control = { type: 'ephemeral' }
      marked += 1
    }
  }

  return marked
}

/**
 * How many cache_control markers one built body carries.
 *
 * Walks the finished body rather than counting calls to the marker: the number
 * the wire enforces is the number of markers IN THE BYTES, so a test that
 * counts its own marking calls could pass while the body carried a fourth
 * breakpoint from somewhere else. Used by the tests only.
 */
export function countMinimaxCacheBreakpoints(body: unknown): number {
  let count = 0
  // A marker's own value is { type: 'ephemeral' } and holds no nested markers,
  // so a plain walk cannot double-count one.
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (!isRecord(value)) return
    if (value.cache_control !== undefined) count += 1
    for (const entry of Object.values(value)) visit(entry)
  }
  visit(body)
  return count
}

/** Options for one built request that are not part of the conversation itself. */
export interface MinimaxRequestOptions {
  /**
   * Emit prompt-cache breakpoints. Default TRUE: caching is what a caller that
   * states nothing gets (see the module doc). Pass false only to opt out.
   *
   * When on, breakpoints go on the last system block, the last block of the
   * last user message, and the last tool - at most
   * {@link MAX_CACHE_BREAKPOINTS} in total, and `system` goes out as a block
   * array because a plain string cannot carry a marker.
   */
  cacheControl?: boolean
  /** Nonsecret hash of the adapter-selected auth owner, required to scope replay. */
  authOwner?: string
  /** Route identity for replay scoping; defaults to PROVIDER_ID. */
  route?: string
}

/** Build one Anthropic Messages body for this subscription. */
export function buildMinimaxRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  request: MinimaxRequestOptions = {},
): Record<string, unknown> {
  const expectedScope: MinimaxReplayScope | undefined = request.authOwner !== undefined
    ? {
        route: request.route ?? PROVIDER_ID,
        model: options.model,
        authOwner: request.authOwner,
        provider: PROVIDER_ID,
      }
    : undefined

  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message)) {
      entries.push({ role: 'user', content: anthropicUserContent(message, images) })
      continue
    }
    entries.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'assistant'
        ? anthropicAssistantContent(message, expectedScope)
        : anthropicUserContent(message, images),
    })
  }

  const system = leadingSystemText(options)
  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const thinking = thinkingFieldFor(options.model, options.reasoningEffort === undefined ? null : String(options.reasoningEffort))
  const caching = request.cacheControl !== false

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
    // REQUIRED. The adapter reads every response body as an SSE stream, and the
    // service only answers with one when the request asks for it. Without this
    // field the endpoint replies 200 `application/json` with a single complete
    // message, which carries no `data:` line, no `message_stop` and no
    // `stop_reason` — so `assertStreamComplete` reports a perfectly good answer
    // as a truncated stream ("stream ended before its terminal event") and every
    // turn on this line fails. The sibling lines that consume SSE request it in
    // their own builders for the same reason (kimi-code/mapper.ts,
    // claude/mapper.ts).
    stream: true,
    messages: mergeAnthropicMessages(entries),
    // A cache breakpoint cannot sit on a plain string, so the system prompt
    // takes the block-array form while caching is on - the shape MiniMax's
    // explicit-caching page marks - and stays the measured string when it is
    // off.
    ...(system === undefined ? {} : { system: caching ? [{ type: 'text', text: system }] : system }),
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

  if (caching) markMinimaxCacheBreakpoints(body)
  return body
}

/**
 * Reject a request past this route's byte ceiling, before spending the connection.
 *
 * The ceiling is this route's own (`maxMessageBodyBytes`), NOT Kimi Code's 2 MB
 * figure: that number belongs to Kimi's gateway, was imported here on the
 * "same family of endpoints" assumption, and refused locally conversations
 * MiniMax would have served. See `types.ts` for the full derivation. The
 * consequence that matters: this guard must never be the reason an ordinary
 * turn fails, so it sits far above any real conversation and fires only on a
 * runaway one.
 *
 * @returns the serialized body, so the caller about to send it does not serialize
 * a multi-megabyte string a second time.
 */
export function assertRequestBodyFits(
  body: Record<string, unknown>,
  limit: number = maxMessageBodyBytes(),
): string {
  const serialized = JSON.stringify(body)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= limit) return serialized
  throw new LlmError(
    PROVIDER_NAME + ' request was not sent: the serialized body is ' + bytes + ' bytes, above the '
    + limit + '-byte ceiling this route enforces. Compact the conversation or start a new '
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
/** Native blocks the service issued for this turn, kept for exact replay. */
export interface MinimaxStreamState {
  provenance?: MinimaxReplayScope
  /** Native blocks by DSH block index (null if text/tool-call that has no native thinking). */
  replayBlocks: (AnthropicBlock | null)[]
  /** Wire content index -> pending thinking block info. */
  pendingThinking: Map<number, {
    dshIndex: number
    kind: 'thinking' | 'redacted_thinking'
    text: string
    signature: string
    data?: string
  }>
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

export interface MinimaxStreamStateOptions {
  model?: string
  authOwner?: string
  route?: string
  provider?: string
}

export function createStreamState(options?: MinimaxStreamStateOptions): MinimaxStreamState {
  const provenance: MinimaxReplayScope | undefined = (options?.model && options?.authOwner)
    ? {
        route: options.route ?? PROVIDER_ID,
        model: options.model,
        authOwner: options.authOwner,
        provider: options.provider ?? PROVIDER_ID,
      }
    : undefined

  return {
    provenance,
    replayBlocks: [],
    pendingThinking: new Map(),
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
  state.replayBlocks[index] = null
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
    state.replayBlocks[call.blockIndex] = null
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

  const paddedBlocks = state.blocks.map((_, i) => {
    const b = state.replayBlocks[i]
    return b !== undefined && b !== null ? (jsonSafeValue(b) as AnthropicBlock) : null
  })
  const replayThinking = paddedBlocks.filter((b): b is AnthropicBlock => b !== null)
  const hasReplay = replayThinking.length > 0

  const visibleContentHash = computeVisibleContentHash(state.blocks)
  const replayState = hasReplay
    ? (state.provenance
      ? {
          response: {
            provider: state.provenance.provider ?? PROVIDER_ID,
            route: state.provenance.route ?? PROVIDER_ID,
            model: state.provenance.model,
            authOwner: state.provenance.authOwner,
            visibleContentHash,
            minimaxThinking: replayThinking,
          },
          blocks: paddedBlocks,
        }
      : {
          response: {
            visibleContentHash,
            minimaxThinking: replayThinking,
          },
          blocks: paddedBlocks,
        })
    : undefined

  out.push({
    type: 'finish',
    reason: finishReasonFor(state),
    ...(replayState !== undefined ? { replayState } : {}),
  })
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
      const index = state.blocks.length
      const kind: 'thinking' | 'redacted_thinking' = blockType === 'redacted_thinking' ? 'redacted_thinking' : 'thinking'
      const data = asString(block.data) ?? ''
      const signature = asString(block.signature) ?? ''
      const thinking = asString(block.thinking) ?? ''
      state.current = { index, type: 'reasoning', text: kind === 'thinking' ? thinking : '' }
      state.blocks.push({ type: 'reasoning', text: state.current.text })
      const initialReplay: AnthropicBlock = isRecord(event.content_block)
        ? structuredClone(event.content_block)
        : { type: blockType }
      state.replayBlocks[index] = initialReplay
      state.pendingThinking.set(contentIndex, { dshIndex: index, kind, text: thinking, signature, data })
      state.contentIndexes.set(contentIndex, index)
      out.push({ type: 'block-start', index, blockType: 'reasoning' })
      if (state.current.text !== '') {
        out.push({ type: 'reasoning-delta', index, text: state.current.text })
      }
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

    if (deltaType === 'signature_delta') {
      const signature = asString(delta.signature) ?? ''
      const pending = state.pendingThinking.get(contentIndex)
      if (pending !== undefined && signature !== '') {
        pending.signature += signature
        const replay = state.replayBlocks[pending.dshIndex]
        if (replay !== undefined && replay !== null) {
          replay.signature = (asString(replay.signature) ?? '') + signature
        }
      }
      return out
    }

    if (deltaType === 'data_delta') {
      const data = asString(delta.data) ?? ''
      const pending = state.pendingThinking.get(contentIndex)
      if (pending !== undefined && data !== '') {
        pending.data = (pending.data ?? '') + data
        const replay = state.replayBlocks[pending.dshIndex]
        if (replay !== undefined && replay !== null) {
          replay.data = (asString(replay.data) ?? '') + data
        }
      }
      return out
    }

    const text = deltaType === 'thinking_delta' ? asString(delta.thinking) : asString(delta.text)
    if (text !== undefined && text !== '') {
      const pending = state.pendingThinking.get(contentIndex)
      if (pending !== undefined) {
        pending.text += text
        const replay = state.replayBlocks[pending.dshIndex]
        if (replay !== undefined && replay !== null) {
          const field = replay.type === 'redacted_thinking' ? 'data' : 'thinking'
          replay[field] = (asString(replay[field]) ?? '') + text
        }
      }
      const index = state.contentIndexes.get(contentIndex) ?? state.current?.index
      const kind: 'text' | 'reasoning' = deltaType === 'thinking_delta' ? 'reasoning' : 'text'
      if (state.current === null || state.current.index !== index) {
        out.push(...closeCurrent(state))
        const next = state.blocks.length
        state.current = { index: next, type: kind, text: '' }
        state.blocks.push({ type: kind, text: '' })
        state.replayBlocks[next] = null
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
      // Measured on this endpoint: message_start carries a zero-filled usage
      // stub and the REAL counters arrive here, in the terminal delta - input
      // as the UNCACHED portion only (input_tokens + cache_read_input_tokens
      // is the full prompt, which is already DSH's disjoint accounting), with
      // cache_read_input_tokens present only when a breakpoint actually hit.
      // The fallbacks keep a delta that omits a counter from erasing the value
      // message_start already gave, which is the Anthropic-public-API shape.
      state.inputTokens = numberOr(usage.input_tokens, state.inputTokens)
      state.cacheReadTokens = numberOr(usage.cache_read_input_tokens, state.cacheReadTokens)
      state.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, state.cacheWriteTokens)
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
      isContextOverflow(error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  return out
}

/** Whether one chunk stream carried any assistant content at all. */
export function streamHasContent(state: MinimaxStreamState): boolean {
  return state.hasContent
}

export { ANTHROPIC_VERSION, type ContentBlock }
