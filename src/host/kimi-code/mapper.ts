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
// Schema normalization and image resolution are provider-neutral behaviour, not
// Kimi preferences; they are shared with the other lines that send inline media.
import { normalizeKimiToolSchema, stripMetaSchema } from '../common/tool-schema.ts'
import { estimatedInputTokens } from '../common/prompt-estimate.ts'

export { estimatedInputTokens, normalizeKimiToolSchema }
import {
  MAX_MESSAGE_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_REQUEST_VIDEO_BYTES,
  MAX_VIDEO_MESSAGE_BODY_BYTES,
  NO_RESOLVED_IMAGES,
  REQUEST_IMAGE_MAX_EDGE,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages,
  requestImageTarget,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
} from '../common/request-images.ts'

// Re-exported so this line keeps one import surface for its own adapter.
export {
  MAX_MESSAGE_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_REQUEST_VIDEO_BYTES,
  MAX_VIDEO_MESSAGE_BODY_BYTES,
  NO_RESOLVED_IMAGES,
  REQUEST_IMAGE_MAX_EDGE,
  offloadOldestRequestImages,
  requestImageTarget,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
}
import { maxOutputTokensFor, type KimiCacheTtl } from './types.ts'
import { base64LengthOf, videoBlockLabel, videoDataUrl, videoOmissionText } from './modalities.ts'
// The traversal, byte budgeting and base64 encoding are provider-neutral and are
// shared with the MiniMax Code line; see ../common/video-request.ts.
import {
  offloadOldestRequestVideos as offloadVideosWithinBudget,
  requestHasVideo,
  resolveRequestVideos,
  videoBlockToInline as resolveVideoBlock,
  type AttachmentVideoReader,
  type ResolvedRequestVideos,
} from '../common/video-request.ts'

// Re-exported so this line keeps one import surface for its own adapter, while
// the implementation stays shared with the MiniMax Code line.
export {
  offloadVideosWithinBudget as offloadOldestRequestVideos,
  requestHasVideo,
  resolveRequestVideos,
  type AttachmentVideoReader,
  type ResolvedRequestVideos,
}

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

/**
 * Whether one failure is a cancellation rather than a real read failure.
 *
 * The name check is deliberately structural rather than `instanceof Error`:
 * DSH's own `LlmError` is not an Error subclass, so an `instanceof` test fails
 * on precisely the errors the harness itself throws when a caller cancels. A
 * misjudged abort would be converted into a model-visible placeholder, turning
 * a cancelled read into a wrong answer instead of a cancelled turn.
 */
function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'AbortError'
}

/**
 * Wire keys an OpenAI-compatible response can carry reasoning under.
 *
 * The Chat Completions ecosystem never standardized one. Kimi answers with
 * `reasoning_content`; newer vLLM builds renamed the field to `reasoning` and
 * accept only that name on the request side, and gateways in between use
 * `reasoning_details`. The first entry doubles as the default for a request
 * made before any response has been seen.
 */
export const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'] as const

/** Default outbound reasoning key, used until a response proves otherwise. */
export const DEFAULT_REASONING_KEY: string = KNOWN_REASONING_KEYS[0]

/**
 * Per-endpoint reasoning-field dialect: observes what the endpoint actually
 * sends, and echoes thinking back under the same key.
 *
 * Sending `reasoning_content` to an endpoint that only reads `reasoning` is not
 * a cosmetic mismatch — preserved thinking then reports the thinking as
 * missing, so the model loses the reasoning chain of every prior assistant
 * turn. Detection never clears: a response with no reasoning keeps the last
 * known dialect, and an endpoint that switches is adapted on its next reply.
 */
export class ReasoningKeyDialect {
  private detected: string | undefined

  /** Reasoning text on an inbound message or delta, remembering its key. */
  observe(source: unknown): string | undefined {
    if (typeof source !== 'object' || source === null) return undefined
    const record = source as Record<string, unknown>
    for (const key of KNOWN_REASONING_KEYS) {
      const value = record[key]
      // Non-string values are skipped on purpose: vLLM emits a compatibility
      // placeholder `reasoning_content: null`, and OpenRouter's
      // `reasoning_details` is an array.
      if (typeof value !== 'string') continue
      this.detected = key
      return value
    }
    return undefined
  }

  /** The key to serialize thinking into on an outbound assistant message. */
  outboundKey(): string {
    return this.detected ?? DEFAULT_REASONING_KEY
  }

  /** Forget the detected key, returning to the default. Test seam only. */
  reset(): void {
    this.detected = undefined
  }
}

/**
 * Process-wide reasoning dialect for this route.
 *
 * The dialect is a property of the endpoint, not of one request: a request that
 * has to be answered by a peer which speaks `reasoning` must itself use that
 * key, and the only evidence available is what an earlier response carried.
 * One instance per process is therefore correct here, and it is what makes the
 * first turn of a session safe too — before any observation it answers the
 * Kimi-documented default.
 *
 * Note this is deliberately NOT scoped per session: a per-session instance
 * would send a newly observed key to a conversation that has never been told
 * that key, which is the same mismatch it exists to prevent.
 */
const reasoningDialect = new ReasoningKeyDialect()

/**
 * The reasoning key an outbound assistant message should use.
 *
 * Exposed for tests and for the request builder, which builds outside any
 * stream state.
 */
export function outboundReasoningKey(): string {
  return reasoningDialect.outboundKey()
}

/** Reset the learned dialect. Test seam only. */
export function resetReasoningDialect(): void {
  reasoningDialect.reset()
}

/** Kimi's hard cap on a tool-call id; a longer one is rejected outright. */
const MAX_TOOL_CALL_ID_LENGTH = 64

/** Fallback for an id that sanitizes down to nothing. */
const EMPTY_TOOL_CALL_ID = 'tool_call'

/**
 * Characters the service accepts in a tool-call id.
 *
 * DSH ids are usually already clean, but a provider that prefixes them with a
 * session or turn marker can carry a separator (".", ":", "/"), and the
 * endpoint rejects an id outside this set. The same allowlist is what pi-ai
 * applies on its Anthropic route and what the official client applies, so a
 * value sanitized here stays acceptable to both.
 */
const UNSAFE_TOOL_CALL_ID_CHARS = /[^a-zA-Z0-9_-]/g

/**
 * Sanitize one id into the shape the service accepts, without dedup.
 *
 * Exported because the request builders and the stream readers must agree on
 * the result, and the guarantee callers actually rely on is that this is
 * idempotent: sanitizing an already-sanitized id returns it unchanged, so an id
 * that has been through here once stays stable across every later turn.
 *
 * Use {@link ToolCallIdNormalizer} instead wherever more than one id in the
 * same request must be kept distinct.
 */
export function clampToolCallId(id: string): string {
  const sanitized = id.replace(UNSAFE_TOOL_CALL_ID_CHARS, '_')
  return sanitized.length <= MAX_TOOL_CALL_ID_LENGTH
    ? sanitized
    : sanitized.slice(0, MAX_TOOL_CALL_ID_LENGTH)
}

/**
 * Assigns collision-free tool-call ids across one request.
 *
 * Truncation alone is not injective: two ids sharing a 64-character prefix
 * clamp to the same value, and a later tool result then resolves against the
 * wrong call. This maps each raw id to a unique sanitized id, appending
 * `_2`, `_3`, … on collision, and returns the same answer for the same
 * input for the lifetime of the normalizer.
 *
 * One normalizer serves one request (or one stream), so the mapping is
 * request-scoped by construction: a conversation whose history is replayed
 * re-derives the same assignment from the same inputs, which is what keeps
 * a tool result answerable by the call it belongs to.
 */
export class ToolCallIdNormalizer {
  private readonly assigned = new Map<string, string>()
  private readonly used = new Set<string>()

  /** The unique sanitized id for `id`, stable for the life of this normalizer. */
  normalize(id: string): string {
    const existing = this.assigned.get(id)
    if (existing !== undefined) return existing

    const base = clampToolCallId(id) || EMPTY_TOOL_CALL_ID
    let candidate = base
    // Collision against an id already handed out. A raw id that sanitizes onto
    // the same value as another keeps its own unique suffix rather than
    // overwriting it, so both calls stay answerable.
    for (let attempt = 2; this.used.has(candidate); attempt++) {
      candidate = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - attempt.toString().length - 1)}_${attempt}`
      if (candidate.length <= 0) break
    }
    this.assigned.set(id, candidate)
    this.used.add(candidate)
    return candidate
  }
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


/**
 * Media a single request build may carry.
 *
 * Passed as one object so adding a media kind never grows a positional
 * signature the existing callers already bind.
 */

/**
 * The cache field for the Anthropic-compatible wire.
 *
 * TOP LEVEL, not per block: the service documents that a `cache_control` inside
 * a message is ignored, and omitting the field means "read a 5m entry but do
 * not write one" — which is why this is only attached when the caller asked
 * for a tier.
 */
function kimiAnthropicCacheControl(ttl: KimiCacheTtl): Record<string, unknown> {
  return { cache_control: { type: 'ephemeral', ttl } }
}

/**
 * The cache field for the OpenAI-compatible wire.
 *
 * `mode: 'implicit'` is the only mode the service supports — it identifies the
 * prefix itself, so this is not a request to break the cache but a request to
 * write it at a chosen TTL.
 */
function kimiOpenAICacheOptions(ttl: KimiCacheTtl): Record<string, unknown> {
  return { prompt_cache_options: { mode: 'implicit', ttl } }
}

export interface RequestMediaOptions {
  /** Videos read for this request; absent means none are readable. */
  videos?: ResolvedRequestVideos
  /** Whether the selected model declares video input. */
  videoAccepted?: boolean
  /**
   * Whether the selected model accepts message-level tool declarations
   * (`messages[].tools`), Kimi's `dynamically_loaded_tools` capability.
   */
  messageTools?: boolean
  /**
   * Prompt-cache tier to request, or `null` to leave the service default.
   *
   * Kimi documents two separate fields for this and they are NOT interchangeable:
   * the OpenAI-compatible wire takes `prompt_cache_options`, and the
   * Anthropic wire takes a TOP-LEVEL `cache_control` (a marker inside a message
   * is explicitly ignored by the service). `null` sends neither, which is what
   * this line did before and remains the safe default: a caller that states
   * nothing gets the service's own 5m behaviour.
   */
  cacheTtl?: KimiCacheTtl | null
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

/**
 * Concatenated system-prompt text.
 *
 * Every system message's text is folded into the single leading system message,
 * so a `system` message used as a tool-declaration carrier must stay
 * content-less: adding text to it would both move that text to the front of the
 * request and give the declaration a `content` field the service forbids.
 *
 * Cache-stability invariant: the system prompt is the head of the prefix the
 * service caches, so this function must be a pure, order-stable fold of its
 * inputs. `options.system` always leads and message text follows in history
 * order — never re-sorted, never re-dated, never decorated with per-turn
 * metadata. Any value that changes turn-over-turn belongs in a trailing user
 * message (where the harness's time/snapshot injectors already put it), not in
 * this head, because one changed byte here invalidates the whole cached prefix
 * and collapses the hit rate. `trackPrefixStability` fingerprints this exact
 * string so a drift is attributed rather than silent.
 */
function leadingSystemText(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    // A declaration carrier holds its text at its own position instead
    // (declarationSlots re-emits it there), so folding it here as well would
    // send the same system text twice: wasted tokens, and the second copy sits
    // at a position that can disturb the very cache prefix the declarations
    // exist to protect.
    if (messageToolsOf(message) !== undefined) continue
    const text = textOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
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
// Dynamically loaded tools
// ---------------------------------------------------------------------------

/**
 * One complete tool definition, in the shape the function-calling wire wants.
 *
 * The service rejects a bare tool name: a message-level declaration must carry
 * the same name/description/parameters triple the top-level list carries, so
 * the caller cannot pass a reference and let the model guess.
 */
export interface DynamicToolDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * A tool declaration that belongs to a message rather than the request.
 *
 * DSH has no message-level tool field, so the producer sets this symbol on a
 * system-role {@link Message} to ask for one. A symbol is used rather than a
 * string key because every other reader of a message — the session log, the
 * transcript UI, another adapter — must not start seeing a field it cannot
 * honor; the property is invisible to them and only this mapper looks for it.
 */
export const MESSAGE_TOOLS = Symbol.for('dsh-chatgpt-subscription.kimi-code.messageTools')

/**
 * Serializable key the declaration travels under.
 *
 * A symbol alone is not enough: the session log persists messages through
 * JSON, which drops symbol-keyed properties, so a restored session would lose
 * every declaration and the model would believe it had tools the request no
 * longer carries. The declaration is therefore stored under a plain string key
 * AND the symbol, so in-process readers keep the exempt-from-`Object.keys`
 * behaviour while a round trip through persistence still reconstructs it.
 */
export const MESSAGE_TOOLS_KEY = 'kimiCodeMessageTools'

/**
 * Attach message-level tool declarations to one system message.
 *
 * Two copies are written deliberately, and they differ in visibility:
 *
 * - the SYMBOL copy is non-enumerable, so a reader that inspects a message the
 *   ordinary way (the transcript UI, a sibling adapter) sees nothing new and
 *   cannot mistake an unhandled field for something it must act on;
 * - the STRING-KEYED copy is enumerable, because JSON persistence only
 *   serializes enumerable string keys and a declaration that vanishes on
 *   session resume is worse than one that is visible. Readers that do walk the
 *   keys will see `kimiCodeMessageTools`; the convention is that only this
 *   route's mapper interprets it.
 */
export function withMessageTools<T extends Message>(message: T, tools: readonly DynamicToolDeclaration[]): T {
  const copy = [...tools]
  Object.defineProperty(message, MESSAGE_TOOLS, {
    value: copy,
    enumerable: false,
    configurable: true,
    writable: false,
  })
  Object.defineProperty(message, MESSAGE_TOOLS_KEY, {
    // Enumerable is required here: this is the copy persistence round-trips.
    value: copy,
    enumerable: true,
    configurable: true,
    writable: false,
  })
  return message
}

/** Message-level tool declarations one message carries, when any. */
export function messageToolsOf(message: Message): readonly DynamicToolDeclaration[] | undefined {
  const record = message as unknown as Record<PropertyKey, unknown>
  for (const key of [MESSAGE_TOOLS, MESSAGE_TOOLS_KEY] as const) {
    const value = record[key]
    if (Array.isArray(value) && value.length > 0) return value as readonly DynamicToolDeclaration[]
  }
  return undefined
}

/**
 * Re-attach declarations after a message has been through JSON.
 *
 * Persistence keeps the declarations but necessarily loses the symbol, so a
 * restored message exposes them only under {@link MESSAGE_TOOLS_KEY}. This
 * restores the symbol too, which is what makes a declaration survive a resumed
 * session instead of silently disappearing.
 */
export function rehydrateMessageTools<T extends Message>(message: T): T {
  const declarations = messageToolsOf(message)
  if (declarations !== undefined) withMessageTools(message, declarations)
  return message
}

/** One declaration in the wire shape Kimi documents for `messages[].tools`. */
function openAIDynamicTool(tool: DynamicToolDeclaration): OpenAIMessage {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: stripMetaSchema(tool.parameters),
    },
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions request
// ---------------------------------------------------------------------------

type OpenAIMessage = Record<string, unknown>

function openAIUserContent(
  message: Message,
  images: ResolvedRequestImages,
  media: RequestMediaOptions = {},
): string | OpenAIMessage[] {
  if (!Array.isArray(message.content)) return ''
  const parts: OpenAIMessage[] = []
  let hasRichPart = false
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        hasRichPart = true
        parts.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        parts.push({ type: 'text', text: unavailableImageText(block) })
      }
    } else if (block.type === 'video') {
      // The OpenAI-compatible surface carries video as a sibling of image_url.
      // A clip the selected model or protocol cannot take degrades to the
      // ordinary text fallback, so the turn still runs and the model learns why
      // the video is absent instead of answering about an empty message.
      const outcome = resolveVideoBlock(
        block,
        media.videos ?? new Map(),
        media.videoAccepted === true,
        videoOmissionText,
      )
      if ('inline' in outcome) {
        hasRichPart = true
        parts.push({
          type: 'video_url',
          video_url: { url: videoDataUrl(outcome.inline.mediaType, outcome.inline.data) },
        })
      } else {
        parts.push({ type: 'text', text: outcome.omission })
      }
    }
  }
  if (!hasRichPart) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
  return parts
}

function openAIAssistantContent(
  message: Message,
  toolCallIds: ToolCallIdNormalizer,
): { content: string; toolCalls: OpenAIMessage[]; reasoning: string } {
  const textParts: string[] = []
  const toolCalls: OpenAIMessage[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(sanitizeText(block.text))
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      toolCalls.push({
        id: toolCallIds.normalize(typeof block.id === 'string' && block.id !== '' ? block.id : `call_${toolCalls.length}`),
        type: 'function',
        function: { name: block.name, arguments: toolCallArguments(block.arguments) },
      })
    }
  }
  return { content: textParts.join(''), toolCalls, reasoning: reasoningText(message) }
}


/** Why one declaration could not be put on the wire, as the model sees it. */
function declarationNotice(
  model: string,
  count: number,
  reason: 'capability' | 'content' | 'wire',
): string {
  if (reason === 'wire') {
    return `[${count} dynamically loaded tool(s) were not sent: model "${model}" is served over the Anthropic Messages protocol, which does not document message-level tool declarations. Do not call those tools.]`
  }
  return reason === 'capability'
    ? `[${count} dynamically loaded tool(s) were not sent: model "${model}" does not declare the dynamically_loaded_tools capability.]`
    : `[${count} dynamically loaded tool(s) were not sent: a tool declaration must be a content-less system message, and this one also carries text. Resend the declaration on its own system message.]`
}

/**
 * One declaration, anchored to the history position it was produced at.
 *
 * `beforeIndex` counts non-system messages, which is exactly the index space of
 * the filtered history the request is built from.
 */
interface DeclarationSlot {
  beforeIndex: number
  entries: OpenAIMessage[]
}

/**
 * Project every message-level tool declaration at its own history position.
 *
 * Position is the entire point of this feature. Kimi's prompt cache is a prefix
 * match, so a declaration is only cache-safe when it keeps the place it was
 * first sent: appending leaves everything before it cached, whereas emitting
 * the same declaration earlier — closer to the front — rewrites the prefix and
 * invalidates the cached conversation. Hoisting every declaration to the top of
 * the request would therefore defeat the one property the feature exists for,
 * and would additionally re-declare tools the conversation had long moved past.
 *
 * A declaration on a system message that also carries text cannot be sent as
 * one message: the service's dynamic-tool schema is `additionalProperties:
 * false` with no `content` field. The text is preserved and the declaration is
 * replaced by a notice, because losing the tools is recoverable while losing
 * system text silently changes what the model was told.
 */
function declarationSlots(
  options: GenerateOptions,
  media: RequestMediaOptions,
): DeclarationSlot[] {
  const slots: DeclarationSlot[] = []
  let beforeIndex = 0
  for (const message of options.messages) {
    if (message.role !== 'system') {
      beforeIndex += 1
      continue
    }
    const declarations = messageToolsOf(message)
    if (declarations === undefined) continue
    const text = textOf(message.content)
    if (text !== '') {
      slots.push({
        beforeIndex,
        entries: [
          { role: 'system', content: text },
          { role: 'system', content: declarationNotice(options.model, declarations.length, 'content') },
        ],
      })
      continue
    }
    slots.push({
      beforeIndex,
      entries: media.messageTools === true
        ? [{ role: 'system', tools: declarations.map(openAIDynamicTool) }]
        : [{ role: 'system', content: declarationNotice(options.model, declarations.length, 'capability') }],
    })
  }
  return slots
}

/** Build one `/chat/completions` body. */
export function buildOpenAIRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  preserveThinking: boolean = preserveThinkingEnabled(),
  media: RequestMediaOptions = {},
): Record<string, unknown> {
  const effort = mapReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  // Thinking is on unless the caller explicitly disabled it: the models reason
  // by default, so `undefined` still means thinking is active and the
  // reasoning_content rule applies.
  const thinkingOn = effort !== 'none'

  // One assignment for the whole request: every tool call and its result must
  // resolve to the same id, and two history ids sharing a 64-char prefix would
  // otherwise collapse onto each other and answer the wrong call.
  const toolCallIds = new ToolCallIdNormalizer()

  const messages: OpenAIMessage[] = []
  const system = leadingSystemText(options)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  // Dynamically loaded tools: complete definitions carried by content-less
  // system messages, emitted at the position they occupy in the history. A
  // declaration is only cache-safe if it keeps that position, so they are
  // interleaved with the conversation rather than gathered at the front.
  const slots = declarationSlots(options, media)
  let slotIndex = 0
  let nonSystemIndex = 0
  const flushSlots = (upTo: number): void => {
    while (slotIndex < slots.length && slots[slotIndex]!.beforeIndex <= upTo) {
      messages.push(...slots[slotIndex]!.entries)
      slotIndex += 1
    }
  }
  // A declaration that precedes every conversation message belongs at the head,
  // after the assembled system prompt.
  flushSlots(0)

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    flushSlots(nonSystemIndex)
    nonSystemIndex += 1
    if (isToolResultMessage(message)) {
      // Parallel tool calls emit several consecutive `role: "tool"` messages, and
      // a strict upstream rejects a `user` message wedged between them. So the
      // whole run is scanned, every image in it is collected, and a single `user`
      // message carrying them is appended once the run ends. Declaration slots
      // are still flushed once per conversation message, so no slot drifts.
      const imageBlocks: OpenAIMessage[] = []
      while (index < conversation.length && isToolResultMessage(conversation[index]!)) {
        const current = conversation[index]!
        if (index > 0) {
          flushSlots(nonSystemIndex)
          nonSystemIndex += 1
        }
        const block = current.content[0]
        const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: toolCallIds.normalize(callId), content: toolResultText(current.content) })
        imageBlocks.push(...toolResultImageBlocks(current.content, images))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) messages.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls, reasoning } = openAIAssistantContent(message, toolCallIds)
      // An assistant turn with neither text, nor calls, nor reasoning carries nothing on this wire.
      if (content === '' && toolCalls.length === 0 && reasoning === '') continue
      const entry: OpenAIMessage = { role: 'assistant' }
      // Per Moonshot / Kimi Code official provider conventions (see kosong/kimi.ts & agent-core-v2 trait):
      // When an assistant message has tool_calls and no text content, the `content` field is omitted,
      // matching the model's wire output and preventing tokenizer/KV prefix misalignment.
      // On plain text turns (toolCalls.length === 0), content is always sent (even if empty string '').
      if (content !== '' || toolCalls.length === 0) {
        entry.content = content
      }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      // Preserved Thinking (`thinking.keep = "all"`, the official default) requires
      // the reasoning field on every assistant message that lacks it, including
      // plain text turns — omitting it is the documented cause of
      // "thinking is enabled but reasoning_content is missing in assistant tool
      // call message at index N". An empty string is the value the service asks
      // for when a turn genuinely produced no reasoning, so the field is always
      // written rather than conditionally added.
      //
      // The field NAME is the one this endpoint was last observed to send under
      // (see ReasoningKeyDialect). Echoing the key the peer used is what keeps
      // the reasoning chain of prior turns readable to it; hard-coding
      // `reasoning_content` silently breaks the chain against a newer vLLM,
      // which accepts only `reasoning` on the request side.
      if (thinkingOn) entry[reasoningDialect.outboundKey()] = reasoning
      messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images, media)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }
  // A declaration produced after the final conversation message is a trailing
  // append, which is the cache-preserving case this feature is built for.
  flushSlots(nonSystemIndex)

  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // The managed endpoint documents max_completion_tokens; the legacy field is
    // normalized away by the service, so it is never sent.
    max_completion_tokens: maxTokens,
    // Prompt-cache tier on this wire; see kimiOpenAICacheOptions. Sent only
    // when a tier was asked for, so the default request is byte-identical to
    // what this line sent before the setting existed.
    ...(media.cacheTtl === null || media.cacheTtl === undefined
      ? {}
      : kimiOpenAICacheOptions(media.cacheTtl)),
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
 * The key is derived from the session identifier alone — never from message
 * content. The official agent keys its cache on the conversation (its
 * sessionId) so the key survives context compaction and multimodal churn
 * byte-for-byte. Deriving it from the first user message (as a fallback once
 * did) produces a key that CHANGES the moment compaction rewrites that first
 * message, silently re-routing the whole session to a cold cache entry and
 * collapsing the hit rate. A session that has no identity yet sends no key at
 * all rather than a key that will drift.
 */
export function promptCacheKey(options: GenerateOptions): string | undefined {
  if (typeof options.sessionId === 'string' && options.sessionId.trim() !== '') {
    return `dsh-${options.sessionId.trim()}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Anthropic Messages request
// ---------------------------------------------------------------------------

type AnthropicBlock = Record<string, unknown>

function anthropicUserContent(
  message: Message,
  images: ResolvedRequestImages,
  toolCallIds: ToolCallIdNormalizer,
): AnthropicBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    // A video part on this protocol is not documented, and an unverified field
    // must never be sent: the block degrades to text that says so.
    if (block.type === 'video') {
      blocks.push({
        type: 'text',
        text: videoOmissionText('unsupported-wire', videoBlockLabel(block as { attachment?: { name?: string; attachmentId?: string } })),
      })
      continue
    }
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
        tool_use_id: toolCallIds.normalize(callId),
        content: resultBlocks ?? toolResultText(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
      })
    }
  }
  return blocks
}

function anthropicAssistantContent(message: Message, toolCallIds: ToolCallIdNormalizer): AnthropicBlock[] {
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
        id: toolCallIds.normalize(typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${blocks.length}`),
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
  media: RequestMediaOptions = {},
): Record<string, unknown> {
  const cacheTtl = media.cacheTtl ?? null
  // Shared across the whole request; see buildOpenAIRequest for why.
  const toolCallIds = new ToolCallIdNormalizer()
  // Message-level tool declarations are an OpenAI-surface feature this protocol
  // does not document, so none is emitted. The count is still reported in the
  // system prompt: without that, a model switched onto this wire would try to
  // call tools it can no longer see, and nothing in the request would say why.
  const carriers = options.messages.filter(
    (message) => message.role === 'system' && messageToolsOf(message) !== undefined,
  )
  const unsentDeclarations = carriers.reduce(
    (total, message) => total + (messageToolsOf(message)?.length ?? 0),
    0,
  )
  // `leadingSystemText` skips declaration carriers on both wires, because the
  // OpenAI path re-emits their text at the carrier's own position. This wire has
  // no such slot, so the text is collected here instead: dropping it would
  // silently change what the model was told, which is the one outcome the
  // declaration handling exists to avoid.
  const carrierText = carriers
    .map((message) => textOf(message.content))
    .filter((text) => text !== '')
  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message)) {
      entries.push({ role: 'user', content: anthropicUserContent(message, images, toolCallIds) })
      continue
    }
    entries.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'assistant'
        ? anthropicAssistantContent(message, toolCallIds)
        : anthropicUserContent(message, images, toolCallIds),
    })
  }

  const leading = leadingSystemText(options)
  const systemParts = [
    leading,
    ...carrierText,
    ...(unsentDeclarations === 0 ? [] : [declarationNotice(options.model, unsentDeclarations, 'wire')]),
  ].filter((part): part is string => part !== undefined && part !== '')
  const system = systemParts.length === 0 ? undefined : systemParts.join('\n\n')
  const maxTokens = options.maxTokens ?? maxOutputTokensFor(options.model)
  const effort = mapReasoningEffort(options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort))
  const budget = thinkingBudgetFor(effort, maxTokens)

  return {
    model: options.model,
    max_tokens: maxTokens,
    messages: mergeAnthropicMessages(entries),
    // TOP-LEVEL cache_control on this wire; see kimiAnthropicCacheControl.
    ...(cacheTtl === null || cacheTtl === undefined ? {} : kimiAnthropicCacheControl(cacheTtl)),
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
  media: RequestMediaOptions = {},
): Record<string, unknown> {
  // Fingerprint the prefix-breaking inputs before building, so the cause is
  // recorded even if the build below throws (an oversized body is itself a turn
  // that never reached the warm cache).
  recordDriftCause(trackPrefixStability(options), options.sessionId)
  return wire === 'anthropic'
    ? buildAnthropicRequest(options, images, media)
    : buildOpenAIRequest(options, images, preserveThinking, media)
}

/**
 * Reject a request the service would answer with its 2 MB body 400.
 *
 * This is the most frequently reported 400 on the coding endpoint, and it is
 * worth catching locally for two reasons: the message can name the actual
 * remedy (DSH's compaction), and a request that cannot succeed should not be
 * sent at all. The measured size is the real serialized body, so it accounts
 * for tool schemas and inlined images the caller cannot easily estimate.
 *
 * @returns the serialized body, so a caller that is about to send it does not
 * serialize a body of up to tens of megabytes a second time.
 */
export function assertRequestBodyFits(body: Record<string, unknown>, carriesVideo = false): string {
  const serialized = JSON.stringify(body)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  // Video raises the ceiling: the 2 MB figure is the documented text/image
  // limit, and a clip the caller deliberately attached must not be measured
  // against a guard sized for a conversation without one.
  //
  // Callers state this rather than the body being inspected for it: sniffing
  // the serialized JSON for a "video_url" substring both paid for a second
  // full serialization of a body that can reach tens of megabytes and let user
  // text containing that literal widen the text/image guard.
  const limit = carriesVideo ? MAX_VIDEO_MESSAGE_BODY_BYTES : MAX_MESSAGE_BODY_BYTES
  if (bytes <= limit) return serialized
  throw new LlmError(oversizedBodyMessage(bytes, limit, body), 'PROVIDER_ERROR')
}

/**
 * How a request body splits into the parts that share the ceiling.
 *
 * The 2 MB limit covers images, conversation text, tool schemas and the system
 * prompt together, but only the first is compressible by dropping something. A
 * message that names which part dominates is the difference between a user who
 * compacts the conversation and a user who deletes images and fails again.
 */
export interface RequestBodyBreakdown {
  readonly totalBytes: number
  readonly imageBytes: number
  readonly toolSchemaBytes: number
  readonly otherBytes: number
}

function walkJson(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit)
    return
  }
  if (!isRecord(value)) return
  visit(value)
  for (const nested of Object.values(value)) walkJson(nested, visit)
}

/**
 * Measure one already-serialized body by composition.
 *
 * Image payload is found structurally (a base64 `data:` URL or an Anthropic
 * base64 source) rather than by searching for a marker substring, so a user
 * message that happens to contain that text cannot inflate the image share.
 */
export function requestBodyBreakdown(
  body: Record<string, unknown>,
  carriesVideo = false,
): RequestBodyBreakdown {
  const serialized = JSON.stringify(body)
  const totalBytes = Buffer.byteLength(serialized, 'utf8')
  let imageBytes = 0
  walkJson(body, (node) => {
    const url = isRecord(node.image_url) ? asString(node.image_url.url) : undefined
    if (url?.startsWith('data:')) {
      imageBytes += Buffer.byteLength(url, 'utf8')
      return
    }
    const source = isRecord(node.source) ? node.source : undefined
    if (source && asString(source.data) !== undefined && asString(source.media_type) !== undefined) {
      imageBytes += Buffer.byteLength(asString(source.data) ?? '', 'utf8')
    }
  })
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(body.tools ?? []), 'utf8')
  return {
    totalBytes,
    imageBytes,
    toolSchemaBytes,
    otherBytes: Math.max(0, totalBytes - imageBytes - toolSchemaBytes),
  }
}

function oversizedBodyMessage(
  bytes: number,
  limit: number,
  body: Record<string, unknown>,
): string {
  const parts = requestBodyBreakdown(body)
  const composition = `images ${parts.imageBytes} bytes, tool schemas ${parts.toolSchemaBytes} bytes, `
    + `conversation text and system prompt ${parts.otherBytes} bytes`
  // Two failures that look identical from outside need different remedies, and
  // the old single message sent everyone to compaction even when their images
  // were the whole problem.
  const remedy = parts.imageBytes >= parts.otherBytes
    ? 'Older images are omitted first; drop or re-attach fewer images, or start a new session.'
    : 'The conversation text and tool schemas dominate, so no image budget can fix this: '
      + 'compact the conversation or start a new session.'
  return `Kimi Code rejected the request before sending: the serialized body is ${bytes} bytes, above the `
    + `${limit}-byte limit this route enforces. Composition: ${composition}. ${remedy}`
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

/**
 * One failure the stream reported itself, as the wire stated it.
 *
 * The vocabulary travels with the object because the two wires do not spell a
 * transient failure the same way — an Anthropic frame is an `error` EVENT, an
 * OpenAI one an `error` field on an ordinary data frame — so the same verdict is
 * reached by two different rules, and the adapter cannot re-derive which one
 * applied from the wire it happened to send the request on.
 */
export interface KimiCodeInBandStreamError {
  /** Wire the event was read with; it selects the vocabulary it reclassifies by. */
  vocabulary: KimiCodeWire
  /** The event's wire `error` object, as received. */
  error: Record<string, unknown>
  /** The provider's own diagnostic, without this mapper's prefix. */
  message: string
}

export interface KimiCodeStreamState {
  wire: KimiCodeWire
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
  /**
   * An in-band failure, recorded just before the mapper throws on it.
   *
   * The mapper cannot tell whether anything has reached the caller yet and has
   * no other verdict to give the event; the adapter can, and reclassifies a
   * transient one from this while nothing has. Both wires record into the one
   * field because one request is served by one of them, never both.
   */
  streamError?: KimiCodeInBandStreamError
  done: boolean
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
  /**
   * Per-request tool-call id assignment.
   *
   * The request side and the stream side must hand the service the same id for
   * the same call, and truncation alone cannot guarantee that across a
   * multi-call response. Shared by reference so both halves of one turn agree.
   */
  toolCallIds: ToolCallIdNormalizer
  /**
   * Session this turn belongs to, when the caller stated one.
   *
   * Carried so usage can be filed under the right conversation at close time,
   * even if the caller does not pass the session again.
   */
  sessionId: string | undefined
}

export function createStreamState(wire: KimiCodeWire, sessionId?: string): KimiCodeStreamState {
  return {
    wire,
    sessionId: typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : undefined,
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
    toolCallIds: new ToolCallIdNormalizer(),
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function closeCurrent(state: KimiCodeStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: KimiCodeStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const [wireIndex, call] of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const block: OutboundContentBlock = {
      type: 'tool-call',
      id: toToolCallId(state.toolCallIds.normalize(call.id)),
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
  // an HTTP error, so it must be surfaced as a provider error here. This is
  // the route's DEFAULT wire, so it is the delivery most turns actually fail
  // through, and it records the same evidence the Anthropic branch does.
  const errorPayload = isRecord(chunk.error) ? chunk.error : undefined
  if (errorPayload !== undefined) {
    const message = asString(errorPayload.message) ?? 'unknown error'
    // Typed PROVIDER_ERROR here because output may already have reached the
    // caller; the adapter, which knows, reclassifies a transient one from this.
    state.streamError = { vocabulary: 'openai', error: errorPayload, message }
    throw new LlmError(
      `Kimi Code stream error: ${message}`,
      isContextOverflow(errorPayload) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
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
    // Learn which reasoning key this endpoint speaks, and read it under that
    // key. `reasoning_content` is Kimi's, `reasoning` is newer vLLM's, and
    // `reasoning_details` is the gateway spelling; all three are accepted and
    // the observed one is echoed back on the next request.
    const reasoning = reasoningDialect.observe(delta)
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
    state.blocks.push({ type: 'tool-call', id: toToolCallId(state.toolCallIds.normalize(call.id)), name: call.name, arguments: '' })
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
      id: toToolCallId(state.toolCallIds.normalize(call.id)),
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
      state.blocks.push({ type: 'tool-call', id: toToolCallId(state.toolCallIds.normalize(pending.id)), name: pending.name, arguments: '' })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({
        type: 'tool-call-delta',
        index,
        id: toToolCallId(state.toolCallIds.normalize(pending.id)),
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
          id: toToolCallId(state.toolCallIds.normalize(pending.id)),
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
        id: toToolCallId(state.toolCallIds.normalize(pending.id)),
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
    const message = asString(error.message) ?? 'unknown error'
    // Typed PROVIDER_ERROR here because output may already have reached the
    // caller; the adapter, which knows, reclassifies a transient one from this.
    state.streamError = { vocabulary: 'anthropic', error, message }
    throw new LlmError(
      `Kimi Code stream error: ${message}`,
      isContextOverflow(error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  return out
}

/**
 * A short, stable fingerprint of one prefix-breaking input.
 *
 * The prefix cache is invalidated as a whole whenever the system prompt or the
 * tool list changes, so these are hashed (not stored verbatim) and compared
 * request-over-request. A 32-bit FNV-1a keeps this dependency-free; collisions
 * only ever produce a missed *diagnostic*, never a wrong request.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * The prefix-breaking inputs of the previous request, kept so a cache miss can
 * be attributed to the change that caused it rather than guessed at.
 *
 * kimi-code's own agent tracks exactly this pair (its `systemPromptHash` /
 * `toolsHash` telemetry) for the same reason: a bare hit ratio cannot say
 * *why* a turn went cold, but a diff of the stability inputs can.
 */
export interface PrefixStabilitySnapshot {
  systemPromptHash: string | null
  toolsHash: string | null
  cacheKey: string | null
}

/**
 * Bucket key for a request that carries no session identity.
 *
 * A one-shot request (a probe, a test, a caller that never had a session) still
 * gets its usage counted, but it is kept apart from every real session so it can
 * never inflate — or be mistaken for — a session's hit ratio.
 */
const UNSCOPED_CACHE_KEY = ''

/**
 * How many distinct sessions to remember.
 *
 * These maps live for the life of the process, so an unbounded one would grow
 * for as long as the harness runs. The bound sits far above any real session
 * count: eviction only begins once a host has served hundreds of them, and it
 * evicts the least recently written key, which is a stale session by then.
 */
const MAX_TRACKED_SESSIONS = 256

/**
 * Composite key separating one session's numbers from another's.
 *
 * The account is part of the key because the account pool can answer the same
 * session from different accounts, and each account keeps its own cache
 * server-side. A shared entry would blend a cold account's misses into a warm
 * account's ratio, leaving a number that means nothing.
 */
function cacheScopeKey(sessionId: string | undefined, accountId?: string): string {
  const session = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (session === '') return UNSCOPED_CACHE_KEY
  return accountId === undefined || accountId === '' ? session : `${session} ${accountId}`
}

/** Write a key, evicting the oldest entry once the bound is reached. */
function rememberScoped<K, V>(store: Map<K, V>, key: K, value: V): void {
  // Re-insert so Map iteration order stays least-recently-written first.
  store.delete(key)
  store.set(key, value)
  if (store.size <= MAX_TRACKED_SESSIONS) return
  const oldest = store.keys().next()
  if (oldest.done !== true) store.delete(oldest.value)
}

/**
 * Prefix snapshots per session.
 *
 * Scoped by session on purpose: DSH runs several sessions — and subagents —
 * concurrently, so one process-wide snapshot is overwritten by whichever request
 * landed last. The attribution it feeds would then name a cause belonging to a
 * different conversation, which is worse than no attribution at all because a
 * reader has no way to tell the two apart.
 */
const prefixSnapshots = new Map<string, PrefixStabilitySnapshot>()

/**
 * Which stability input changed relative to the previous request, if any.
 *
 * `'stable'` means the prefix should have held; a miss then points at the
 * service or at content below the head. Anything else names the input that
 * broke the prefix. `'cold-key'` means no cache key was sent, so the request
 * could not be routed to the warm entry at all.
 */
export type PrefixDriftCause =
  | 'first-request'
  | 'stable'
  | 'system-prompt'
  | 'tools'
  | 'cache-key'
  | 'cold-key'

/**
 * Fingerprint the current request's stability inputs and diff them against the
 * last request. Called once per request build; the result is read back when the
 * stream reports usage so a low-or-zero cache read can be explained.
 */
export function trackPrefixStability(options: GenerateOptions): PrefixDriftCause {
  const systemText = leadingSystemText(options) ?? ''
  const systemPromptHash = systemText === '' ? null : fingerprint(systemText)
  const tools = options.tools ?? []
  const toolsHash = tools.length === 0
    ? null
    : fingerprint(JSON.stringify(tools.map((tool) => [tool.name, tool.description ?? '', tool.parameters ?? {}])))
  const cacheKey = promptCacheKey(options) ?? null

  // Scoped by session only: the prefix inputs are properties of the request
  // itself, and the account that will answer it is not known yet.
  const scope = cacheScopeKey(options.sessionId)
  const previous = prefixSnapshots.get(scope)
  rememberScoped(prefixSnapshots, scope, { systemPromptHash, toolsHash, cacheKey })

  if (
    previous === undefined
    || (previous.systemPromptHash === null && previous.toolsHash === null && previous.cacheKey === null)
  ) {
    return 'first-request'
  }
  if (cacheKey === null) return 'cold-key'
  if (previous.cacheKey !== cacheKey) return 'cache-key'
  if (previous.systemPromptHash !== systemPromptHash) return 'system-prompt'
  if (previous.toolsHash !== toolsHash) return 'tools'
  return 'stable'
}

/** Drift cause recorded for each session. */
const driftCauses = new Map<string, PrefixDriftCause>()

/** Record the cause computed for one in-flight request. */
export function recordDriftCause(cause: PrefixDriftCause, sessionId?: string): void {
  rememberScoped(driftCauses, cacheScopeKey(sessionId), cause)
}

/**
 * The cause attributed to the most recent request of one session.
 *
 * `undefined` for a session that has not made a request, rather than a default
 * value: an absent attribution and an unattributed first request are different
 * facts, and the caller can only tell them apart if absence is expressible.
 */
export function getLastDriftCause(sessionId?: string): PrefixDriftCause | undefined {
  return driftCauses.get(cacheScopeKey(sessionId))
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

/**
 * Rolling cache totals per session.
 *
 * Per session rather than per process for the same reason as the prefix
 * snapshots above, and additionally per account: the pool can serve one session
 * from several accounts, and each of those keeps its own cache server-side.
 */
const cacheStatsByScope = new Map<string, KimiCodeCacheStats>()

const EMPTY_CACHE_STATS: KimiCodeCacheStats = {
  requests: 0,
  cachedTokens: 0,
  freshTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
}

/** Record one request's usage into its own session's totals. */
export function recordCacheStats(state: KimiCodeStreamState, sessionId?: string, accountId?: string): void {
  if (!state.sawUsage) return
  const scope = cacheScopeKey(sessionId ?? state.sessionId, accountId)
  const previous = cacheStatsByScope.get(scope) ?? EMPTY_CACHE_STATS
  rememberScoped(cacheStatsByScope, scope, {
    requests: previous.requests + 1,
    cachedTokens: previous.cachedTokens + state.cacheReadTokens,
    freshTokens: previous.freshTokens + state.inputTokens,
    outputTokens: previous.outputTokens + state.outputTokens,
    cacheWriteTokens: previous.cacheWriteTokens + state.cacheWriteTokens,
  })
}

/** Add one entry into an accumulator. */
function accumulate(totals: KimiCodeCacheStats, stats: KimiCodeCacheStats): void {
  totals.requests += stats.requests
  totals.cachedTokens += stats.cachedTokens
  totals.freshTokens += stats.freshTokens
  totals.outputTokens += stats.outputTokens
  totals.cacheWriteTokens += stats.cacheWriteTokens
}

/**
 * Totals for one account's share of a session, one whole session, or every
 * tracked session.
 *
 * The three cases are not a convenience: each answers a different question a
 * caller actually has. Naming an account answers "is this account's cache
 * warm", naming only a session answers "how is this conversation doing
 * overall", and naming neither answers "how is this install doing". Summing
 * the per-scope entries rather than keeping a second running total means the
 * aggregate can never drift out of step with the parts it summarises.
 */
export function getCacheStats(
  sessionId?: string,
  accountId?: string,
): KimiCodeCacheStats & { hitRatio: number | null } {
  const totals: KimiCodeCacheStats = { ...EMPTY_CACHE_STATS }
  if (sessionId === undefined) {
    // No session named: the whole process. An account without a session cannot
    // be singled out, so it is included rather than silently dropped.
    for (const stats of cacheStatsByScope.values()) accumulate(totals, stats)
  } else if (accountId !== undefined) {
    Object.assign(totals, cacheStatsByScope.get(cacheScopeKey(sessionId, accountId)) ?? EMPTY_CACHE_STATS)
  } else {
    // The session across every account that served it. The account is part of
    // the key, so an exact lookup here would find nothing once rotation has run
    // and every turn has been filed under "<session> <account>".
    const prefix = sessionId + ' '
    for (const [key, stats] of cacheStatsByScope) {
      if (key === sessionId || key.startsWith(prefix)) accumulate(totals, stats)
    }
  }
  const prompt = totals.cachedTokens + totals.freshTokens
  return { ...totals, hitRatio: prompt === 0 ? null : totals.cachedTokens / prompt }
}

/** Drop every key belonging to one session, whatever account served it. */
function dropSession(store: Map<string, unknown>, sessionId: string): void {
  for (const key of [...store.keys()]) {
    if (key === sessionId || key.startsWith(sessionId + ' ')) store.delete(key)
  }
}

/** Forget one session's numbers, or all of them. Test seam and session teardown. */
export function resetCacheStats(sessionId?: string): void {
  if (sessionId === undefined) {
    cacheStatsByScope.clear()
    prefixSnapshots.clear()
    driftCauses.clear()
    return
  }
  dropSession(cacheStatsByScope, sessionId)
  dropSession(prefixSnapshots, sessionId)
  dropSession(driftCauses, sessionId)
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
export function closeStream(state: KimiCodeStreamState, accountId?: string): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) {
    // One accounting point per request, so the rolling cache ratio stays honest.
    recordCacheStats(state, state.sessionId, accountId)
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
