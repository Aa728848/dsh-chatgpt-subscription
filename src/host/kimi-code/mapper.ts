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
  collectRemainingImageKeys,
  imageBlockToInline,
  offloadOldestRequestImages,
  offloadRequestImagesWithStickyBudget,
  requestImageKey,
  requestImageTarget,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
  type StickyImageOffloadResult,
} from '../common/request-images.ts'

// Re-exported so this line keeps one import surface for its own adapter.
export {
  MAX_MESSAGE_BODY_BYTES,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_REQUEST_VIDEO_BYTES,
  MAX_VIDEO_MESSAGE_BODY_BYTES,
  NO_RESOLVED_IMAGES,
  REQUEST_IMAGE_MAX_EDGE,
  collectRemainingImageKeys,
  offloadOldestRequestImages,
  offloadRequestImagesWithStickyBudget,
  requestImageKey,
  requestImageTarget,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
  type StickyImageOffloadResult,
}
import { maxMessageBodyBytes, maxOutputTokensFor } from './types.ts'

// The image budget this route enforces, re-exported so this line keeps one
// import surface for its own adapter and its own tests.
export { DEFAULT_LOW_REQUEST_IMAGE_BYTES, lowRequestImageBytes } from './types.ts'
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
 * How one `reasoning_details` fragment arrived on the wire.
 *
 * - `string` — the older bare-string spelling of the whole field;
 * - `summary` — a visible summary element: official `type: 'summary'`, no
 *   `type` at all, or the `reasoning.summary` gateway spelling;
 * - `encrypted` — official opaque provider state, which carries no visible text;
 * - `text` — the `reasoning.text` compatibility spelling.
 *
 * The form is recorded because the same text has to be written back in the shape
 * it arrived in: a bare string must not become an array, and an official
 * encrypted element must stay one.
 */
export type ReasoningForm = 'string' | 'text' | 'summary' | 'encrypted'

/**
 * One reasoning fragment, together with how it arrived.
 *
 * The key is carried per fragment rather than per message because one delta can
 * legitimately carry several at once: Kimi answers under `reasoning_content`,
 * gateways add `reasoning_details`, and newer vLLM builds reply under
 * `reasoning`. Stopping at the first field loses text the service already
 * charged for, and flattening every field onto one outbound key is what makes a
 * replay read as a field the peer never sent.
 *
 * An encrypted fragment is the one shape with no visible text: its `text` is ''
 * and its payload stays in `encrypted`, which is opaque provider state and is
 * never decoded, rendered, or logged.
 */
export interface ReasoningFragment {
  /** Wire field the fragment arrived under. */
  readonly key: string
  /** Wire form, only meaningful when `key` is `reasoning_details`. */
  readonly form?: ReasoningForm
  /** Element `type` exactly as received; absent when the element carried none. */
  readonly wireType?: string
  /** Element index: the wire's own number, else the element's position. */
  readonly index?: number
  /** Opaque encrypted provider state (`form: 'encrypted'`); never text. */
  readonly encrypted?: string
  /** Visible text; always '' for an encrypted fragment. */
  readonly text: string
}

/**
 * One `reasoning_details` element, in an official or a compatibility shape.
 *
 * The official shapes are the ones agent-core-v2's
 * `bases/openai/reasoning-key.ts` reads: `type` is absent or `'summary'` for a
 * visible summary (payload in `summary`), or `'encrypted'` for opaque provider
 * state (payload in `encrypted`). Its `toReasoningDetailsElement` keeps
 * `record.index` when that is a number and otherwise the element's position, so
 * every element has an index; this function does the same, and replays it.
 *
 * Its `convertReasoningDetails` then walks each element twice, in this order:
 * a non-encrypted element with a `summary` produces visible thinking, and a
 * non-summary element with `encrypted` produces opaque thinking. A type-less
 * element carrying BOTH therefore yields two fragments — the visible summary
 * first, then the opaque state. An encrypted payload is never text: it is
 * provider state, and printing it would show a blob as if the model had thought
 * it.
 *
 * The `reasoning.text` / `reasoning.summary` gateway spellings this route
 * already accepted stay readable, and are replayed under the type they arrived
 * with. Anything else — an unknown `type`, a missing payload, a non-object — is
 * ignored rather than mistaken for body text.
 */
function reasoningDetailElement(entry: Record<string, unknown>, position: number): ReasoningFragment[] {
  const type = asString(entry.type)
  const rawIndex = entry.index
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
    ? rawIndex
    : position
  const shape = { key: 'reasoning_details', ...(type === undefined ? {} : { wireType: type }), index }
  if (type === 'reasoning.text') {
    const text = asString(entry.text)
    return text === undefined || text === '' ? [] : [{ ...shape, form: 'text', text }]
  }
  const summary = asString(entry.summary)
  const encrypted = asString(entry.encrypted)
  const fragments: ReasoningFragment[] = []
  // The official two-step read, restricted to the shapes it defines: a summary
  // unless this IS the encrypted shape, then the opaque state unless this IS the
  // summary shape. Unknown types reach neither step.
  if (type === undefined || type === 'summary' || type === 'reasoning.summary') {
    if (summary !== undefined && summary !== '') fragments.push({ ...shape, form: 'summary', text: summary })
  }
  if (type === undefined || type === 'encrypted') {
    if (encrypted !== undefined && encrypted !== '') {
      fragments.push({ ...shape, form: 'encrypted', encrypted, text: '' })
    }
  }
  return fragments
}

/**
 * Fragments carried by one `reasoning_details` value.
 *
 * A bare string — the older gateway spelling, and already a learned dialect here
 * — is one `string` fragment. An array keeps its arrival order, exactly as the
 * official `extractReasoningDetails` does: elements are pushed in the order they
 * appear and nothing is re-sorted. `index` is metadata (defaulted to the
 * position), never an ordering key here.
 */
function reasoningDetailFragments(value: unknown): ReasoningFragment[] {
  if (typeof value === 'string') return value === '' ? [] : [{ key: 'reasoning_details', form: 'string', text: value }]
  if (!Array.isArray(value)) return []
  const fragments: ReasoningFragment[] = []
  value.forEach((entry, position) => {
    if (!isRecord(entry)) return
    fragments.push(...reasoningDetailElement(entry, position))
  })
  return fragments
}

/**
 * Every reasoning fragment one inbound object (a stream delta or a message)
 * carries, in a fixed, documented order.
 *
 * `reasoning_content` comes first and `reasoning` last because that is the
 * order of {@link KNOWN_REASONING_KEYS}: the Kimi field is the one this route is
 * documented against and `reasoning` is the newer vLLM rename, so a delta
 * carrying both keeps its text in the order a single-key endpoint would have
 * produced it in. A `reasoning_details` array keeps its arrival order; `index` is
 * carried as metadata and never reorders it (see reasoningDetailFragments).
 */
export function reasoningFragmentsOf(source: unknown): ReasoningFragment[] {
  if (typeof source !== 'object' || source === null) return []
  const record = source as Record<string, unknown>
  const fragments: ReasoningFragment[] = []
  for (const key of KNOWN_REASONING_KEYS) {
    const value = record[key]
    if (key === 'reasoning_details') {
      fragments.push(...reasoningDetailFragments(value))
      continue
    }
    if (typeof value !== 'string' || value === '') continue
    fragments.push({ key, text: value })
  }
  return fragments
}

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

  /**
   * Every reasoning fragment one inbound delta carries, remembering the dialect.
   *
   * The FIRST string-shaped fragment names the key this endpoint speaks, which is
   * exactly the field the earlier single-match read picked: an endpoint answering
   * under `reasoning_content` keeps that outbound key even when the same delta
   * also carries a sibling field, so learning does not change just because a peer
   * became chattier.
   *
   * An element of a `reasoning_details` ARRAY never teaches the dialect: the
   * outbound key must be a field that takes a plain string, and array elements
   * could only teach `reasoning_details`, which on that wire is an array. A bare
   * string `reasoning_details` still teaches it, because that spelling really is
   * a string.
   */
  observeAll(source: unknown): ReasoningFragment[] {
    const fragments = reasoningFragmentsOf(source)
    const teaching = fragments.find((fragment) => fragment.form === undefined || fragment.form === 'string')
    if (teaching !== undefined) {
      this.detected = teaching.key
      return fragments
    }
    // An empty string is still evidence of the field this endpoint uses, so the
    // dialect keeps learning from a delta whose only reasoning is blank - and
    // non-string values are still skipped: vLLM emits a compatibility
    // placeholder `reasoning_content: null`, and `reasoning_details` is
    // usually an array.
    if (typeof source === 'object' && source !== null) {
      const record = source as Record<string, unknown>
      for (const key of KNOWN_REASONING_KEYS) {
        if (typeof record[key] === 'string') {
          this.detected = key
          break
        }
      }
    }
    return fragments
  }

  /** First reasoning fragment on an inbound message or delta, remembering its key. */
  observe(source: unknown): string | undefined {
    return this.observeAll(source)[0]?.text
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
   * Hosted references this request already uploaded, keyed by ATTACHMENT ID.
   *
   * The value is the `ms://<id>` reference the upload returned, and citing it
   * instead of the bytes is the whole point: the service reads the stored file,
   * so the body carries a ~20-byte URL where it used to carry a megabyte of
   * base64. Only the OpenAI-compatible surface documents this; the Anthropic
   * one keeps its inline block (see anthropicUserContent).
   *
   * A miss is not an error: an occurrence with no entry here is sent exactly as
   * it always was (inline when readable, the unavailable placeholder when not),
   * which is what makes a per-media upload failure degrade instead of fail.
   */
  imageReferences?: ReadonlyMap<string, string>
  /** Hosted video references, keyed by attachment id; see imageReferences. */
  videoReferences?: ReadonlyMap<string, string>
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
 *
 * A hosted reference is honoured here too, because a `read_image` result or a
 * screenshot is exactly the kind of image that would otherwise inline a
 * megabyte into a request the conversation already made large. Sending base64
 * for an image this request uploaded would also contradict the reference it
 * cites elsewhere.
 */
function toolResultImageBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
  media: RequestMediaOptions = {},
): OpenAIMessage[] {
  if (!Array.isArray(blocks)) return []
  const out: OpenAIMessage[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const reference = hostedReference(media.imageReferences, block)
      if (reference !== undefined) {
        out.push({ type: 'image_url', image_url: { url: reference } })
        continue
      }
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        out.push({ type: 'text', text: unavailableImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...toolResultImageBlocks(block.content, images, media))
  }
  return out
}

/** Scheme under which this route cites a file it uploaded. */
const HOSTED_FILE_SCHEME = 'ms://'

/**
 * The attachment id one block cites, when it cites a durable attachment.
 *
 * Only a durable occurrence can have been uploaded: a block carrying its own
 * `data:` URL has no id, so it is never looked up here and always keeps its
 * bytes.
 */
function attachmentIdOf(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  const id = attachment === undefined ? undefined : asString(attachment.attachmentId)
  return id === undefined || id === '' ? undefined : id
}

/**
 * The hosted reference for one block, when this request uploaded it.
 *
 * A value that is not an `ms://` reference is IGNORED rather than sent. This is
 * the one place a per-account cache key could reach the wire, so a bare id, an
 * empty string or an http URL is dropped instead of being trusted; the
 * occurrence then falls back to its inline bytes, which always work.
 */
function hostedReference(
  references: ReadonlyMap<string, string> | undefined,
  block: Record<string, unknown>,
): string | undefined {
  if (references === undefined) return undefined
  const id = attachmentIdOf(block)
  if (id === undefined) return undefined
  const reference = references.get(id)
  if (reference === undefined) return undefined
  const trimmed = reference.trim()
  return trimmed.startsWith(HOSTED_FILE_SCHEME) && trimmed.length > HOSTED_FILE_SCHEME.length
    ? trimmed
    : undefined
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


/**
 * One `reasoning_details` element, rebuilt from the provenance the stream
 * recorded.
 *
 * Each variant is written back in the shape it arrived in: `text` and `summary`
 * keep the wire `type` they were sent with (a summary may legitimately have
 * none), `encrypted` keeps the opaque payload verbatim, and no variant invents
 * an `index` the wire did not carry.
 */
export type ReplayedReasoningDetail =
  | { readonly form: 'text'; readonly text: string; readonly index?: number }
  | { readonly form: 'summary'; readonly summary: string; readonly wireType?: string; readonly index?: number }
  | { readonly form: 'encrypted'; readonly encrypted: string; readonly wireType?: string; readonly index?: number }

/**
 * Reasoning of one assistant message, split by the wire shape it arrived in.
 *
 * `fields` holds text that belongs under a plain string field, `detailsString`
 * is the older bare-string `reasoning_details` value (which must stay a
 * string), and `details` holds array elements; `joined` is everything
 * concatenated, which is what a message with no provenance still sends.
 */
export interface ReplayedReasoning {
  /** Text per plain string field, in first-seen order. */
  readonly fields: ReadonlyArray<{ readonly key: string; readonly text: string }>
  /** The legacy bare-string `reasoning_details` value, when one was recorded. */
  readonly detailsString?: string
  /** `reasoning_details` elements rebuilt from their provenance, in wire order. */
  readonly details: ReadonlyArray<ReplayedReasoningDetail>
  /** Every reasoning block concatenated, used when no provenance survives. */
  readonly joined: string
}

const NO_REASONING: ReplayedReasoning = { fields: [], details: [], joined: '' }

/** Form tag read back from persisted provenance; undefined for an unknown one. */
function readReasoningForm(value: unknown): ReasoningForm | undefined {
  return value === 'string' || value === 'text' || value === 'summary' || value === 'encrypted'
    ? value
    : undefined
}

/**
 * Provenance recorded for one reasoning block by the stream.
 *
 * Every shape that cannot be verified returns undefined, so a block written by
 * an older generation of this file - or one whose metadata was lost in transit -
 * falls back to the single dialect key instead of being split on a guess.
 */
function reasoningRunsAt(message: Message, blockIndex: number): ReasoningRun[] | undefined {
  const state = message.source?.replayState
  if (!isRecord(state) || !Array.isArray(state.blocks)) return undefined
  const entry = state.blocks[blockIndex]
  if (!isRecord(entry) || !Array.isArray(entry.reasoning)) return undefined
  const runs: ReasoningRun[] = []
  for (const raw of entry.reasoning) {
    if (!isRecord(raw)) return undefined
    const key = asString(raw.key)
    const length = raw.length
    if (key === undefined || typeof length !== 'number' || !Number.isInteger(length) || length < 0) return undefined
    const form = readReasoningForm(raw.form)
    const wireType = asString(raw.wireType)
    const index = typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 0
      ? raw.index
      : undefined
    const encrypted = asString(raw.encrypted)
    runs.push({
      key,
      ...(form === undefined ? {} : { form }),
      ...(wireType === undefined ? {} : { wireType }),
      ...(index === undefined ? {} : { index }),
      ...(encrypted === undefined ? {} : { encrypted }),
      length,
    })
  }
  return runs.length === 0 ? undefined : runs
}

/**
 * Split one message's reasoning back onto the shapes it arrived in.
 *
 * The block text stays authoritative: the recorded runs only say where its
 * slices belong. Their total must equal the block's length exactly, and one
 * mismatch abandons the split for that block rather than writing a truncated
 * prefix under the wrong field. An encrypted run has length 0, so it changes
 * neither the total nor the offsets while still producing its element.
 *
 * `fallbackKey` is the learned dialect, used for reasoning with no surviving
 * provenance - every message written before this provenance existed, and any
 * message whose metadata was dropped in transit.
 */
function replayedReasoning(message: Message, fallbackKey: string): ReplayedReasoning {
  if (!Array.isArray(message.content)) return NO_REASONING
  const order: string[] = []
  const byKey = new Map<string, string[]>()
  const details: ReplayedReasoningDetail[] = []
  let detailsString: string | undefined
  let joined = ''
  const put = (key: string, text: string): void => {
    let parts = byKey.get(key)
    if (parts === undefined) {
      parts = []
      order.push(key)
      byKey.set(key, parts)
    }
    parts.push(text)
  }
  for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
    const block = message.content[blockIndex]
    if (!isRecord(block) || block.type !== 'reasoning' || typeof block.text !== 'string') continue
    const text = sanitizeText(block.text)
    joined += text
    const runs = reasoningRunsAt(message, blockIndex)
    const total = runs === undefined ? -1 : runs.reduce((sum, run) => sum + run.length, 0)
    if (runs === undefined || total !== text.length) {
      if (text !== '') put(fallbackKey, text)
      continue
    }
    let offset = 0
    for (const run of runs) {
      const slice = text.slice(offset, offset + run.length)
      offset += run.length
      if (run.key !== 'reasoning_details') {
        if (slice !== '') put(run.key, slice)
        continue
      }
      if (run.form === 'encrypted') {
        // No text to slice: the payload IS the fragment, which is why an
        // encrypted-only block still replays even with an empty text.
        if (run.encrypted !== undefined && run.encrypted !== '') {
          details.push({
            form: 'encrypted',
            encrypted: run.encrypted,
            ...(run.wireType === undefined ? {} : { wireType: run.wireType }),
            ...(run.index === undefined ? {} : { index: run.index }),
          })
        }
        continue
      }
      if (slice === '') continue
      if (run.form === 'text') {
        details.push({ form: 'text', text: slice, ...(run.index === undefined ? {} : { index: run.index }) })
        continue
      }
      if (run.form === 'summary') {
        details.push({
          form: 'summary',
          summary: slice,
          ...(run.wireType === undefined ? {} : { wireType: run.wireType }),
          ...(run.index === undefined ? {} : { index: run.index }),
        })
        continue
      }
      // A run with no recorded form is read as the bare-string spelling rather
      // than invented as an element.
      detailsString = (detailsString ?? '') + slice
    }
  }
  return {
    fields: order.map((key) => ({ key, text: byKey.get(key)!.join('') })),
    ...(detailsString === undefined ? {} : { detailsString }),
    details,
    joined,
  }
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

/**
 * Names of the tools one developer message adds at its own history position.
 *
 * The harness states an addition as a name only; the definition it activates
 * lives in the request's declaration list, which is why the two are resolved
 * together rather than the block carrying a schema of its own.
 */
function toolAdditionNames(message: Message): string[] {
  const names: string[] = []
  for (const block of message.content as unknown as readonly Record<string, unknown>[]) {
    if (block.type !== 'tool-addition') continue
    const name = block.toolName
    if (typeof name !== 'string' || name.trim() === '') continue
    names.push(name.trim())
  }
  return names
}

/**
 * Names of the tools one developer message revokes at its own history position.
 *
 * `in-history` is the only mode that emits these; a route declaring
 * `addition-only` never sees one, because the harness removes the declaration
 * from the list instead.
 */
function toolRemovalNames(message: Message): string[] {
  const names: string[] = []
  for (const block of message.content as unknown as readonly Record<string, unknown>[]) {
    if (block.type !== 'tool-removal') continue
    const name = block.toolName
    if (typeof name !== 'string' || name.trim() === '') continue
    names.push(name.trim())
  }
  return names
}

/**
 * The model-facing note that revokes one or more tools.
 *
 * Imperative and unambiguous on purpose: the tool is still in the declaration
 * list (that is what keeps the prefix intact), so the only thing standing
 * between the model and a call that would fail is this sentence.
 */
function removalNotice(names: readonly string[]): string {
  const list = names.map((name) => '"' + name + '"').join(', ')
  return names.length === 1
    ? '[' + list + ' is no longer available. Do not call it again: any call will fail.]'
    : '[' + list + ' are no longer available. Do not call them again: any call will fail.]'
}

/**
 * Resolve additions against the declaration list the harness sent.
 *
 * A deferred definition keeps `deferLoading` for the top-level filter and loses
 * it here: a message-level declaration has no such field, and passing it on
 * would be a property the service documented a stricter shape for.
 */
function declarationsFor(
  names: readonly string[],
  tools: GenerateOptions['tools'],
): DynamicToolDeclaration[] {
  if (tools === undefined || names.length === 0) return []
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const declarations: DynamicToolDeclaration[] = []
  for (const name of names) {
    const tool = byName.get(name)
    if (tool === undefined) continue
    declarations.push({
      name: tool.name,
      description: tool.description ?? '',
      parameters: stripMetaSchema(tool.parameters) as Record<string, unknown>,
    })
  }
  return declarations
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
      // A reference this account already uploaded is cited INSTEAD of the
      // bytes, never alongside them: the service reads the stored file, and
      // sending both would charge the request for the megabyte it was trying to
      // avoid while asking the model to read the picture twice.
      const reference = hostedReference(media.imageReferences, block)
      if (reference !== undefined) {
        hasRichPart = true
        parts.push({ type: 'image_url', image_url: { url: reference } })
      } else {
        const inline = imageBlockToInline(block, images)
        if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
          hasRichPart = true
          parts.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
        } else {
          parts.push({ type: 'text', text: unavailableImageText(block) })
        }
      }
    } else if (block.type === 'video') {
      // The OpenAI-compatible surface carries video as a sibling of image_url.
      // A clip the selected model or protocol cannot take degrades to the
      // ordinary text fallback, so the turn still runs and the model learns why
      // the video is absent instead of answering about an empty message.
      //
      // A hosted reference short-circuits the inline resolution for the same
      // reason as an image: a single clip inlined as base64 is what the body
      // ceiling cannot survive, and this route uploaded it precisely to avoid
      // that. A miss falls through to the unchanged path below.
      const reference = hostedReference(media.videoReferences, block)
      if (reference !== undefined) {
        hasRichPart = true
        parts.push({ type: 'video_url', video_url: { url: reference } })
        continue
      }
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
  reasoningKey: string,
): { content: string; toolCalls: OpenAIMessage[]; reasoning: ReplayedReasoning } {
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
  return { content: textParts.join(''), toolCalls, reasoning: replayedReasoning(message, reasoningKey) }
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
    if (message.role === 'developer') {
      // The harness appends a tool change as a developer message at the point in
      // history where it happened, which is exactly where it must be replayed:
      // Kimi matches prefixes, so a change kept at its original position leaves
      // everything before it cached.
      const additions = declarationsFor(toolAdditionNames(message), options.tools)
      const entries: OpenAIMessage[] = []
      if (additions.length > 0) {
        entries.push(media.messageTools === true
          ? { role: 'system', tools: additions.map(openAIDynamicTool) }
          : { role: 'system', content: declarationNotice(options.model, additions.length, 'capability') })
      }
      // A removal has no wire form of its own — the dynamic-tool schema defines
      // no "revoke" — so it travels as the note the `in-history` mode is for.
      // The declaration stays in the top-level list (dropping it would rewrite
      // the prefix); the note is what tells the model the tool is gone.
      const removals = toolRemovalNames(message)
      if (removals.length > 0) entries.push({ role: 'system', content: removalNotice(removals) })
      if (entries.length > 0) slots.push({ beforeIndex, entries })
      beforeIndex += 1
      continue
    }
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

/**
 * Write one assistant turn's reasoning under the field it arrived under.
 *
 * Two rules are in tension here and both matter:
 *
 * - Preserved Thinking requires a reasoning field on every assistant message, so
 *   the learned dialect key is ALWAYS written, with an empty string when the
 *   turn produced no reasoning. Omitting it is the documented cause of
 *   "thinking is enabled but reasoning_content is missing in assistant tool call
 *   message at index N".
 * - A replayed fragment must not be written under a key it did not come from, so
 *   each surviving field is written on its own and nothing is concatenated onto
 *   the dialect key. `reasoning_details` goes back in the shape it arrived in: a
 *   bare string stays a string, elements stay an array.
 */
function applyReplayedReasoning(
  entry: OpenAIMessage,
  reasoning: ReplayedReasoning,
  dialectKey: string,
): void {
  const fields = reasoning.fields.length === 0
    ? [{ key: dialectKey, text: '' }]
    : reasoning.fields
  for (const field of fields) entry[field.key] = field.text
  // The dialect key stays present even when this turn's reasoning was replayed
  // under another field: the service demands its own field, and an empty string
  // is the value it asks for when a turn carried no reasoning.
  if (fields.every((field) => field.key !== dialectKey)) entry[dialectKey] = ''
  if (reasoning.details.length > 0) {
    const elements = reasoning.details.map(replayedDetailElement)
    // A message that mixed the bare-string spelling with element form keeps its
    // text: the string is projected into an official type-less summary element,
    // which is the shape a summary without a `type` already has - no `index` and
    // no `type` is invented for it.
    if (reasoning.detailsString !== undefined && reasoning.detailsString !== '') {
      elements.unshift({ summary: reasoning.detailsString })
    }
    entry.reasoning_details = elements
  } else if (reasoning.detailsString !== undefined) {
    entry.reasoning_details = reasoning.detailsString
  }
}

/**
 * One replayed element, in the shape the peer sent it in.
 *
 * `type` is echoed only when the wire carried one (a summary may have none), and
 * `index` is echoed only when the wire carried one - neither is invented.
 */
function replayedDetailElement(detail: ReplayedReasoningDetail): Record<string, unknown> {
  const index = detail.index === undefined ? {} : { index: detail.index }
  // An element that carried no `type` keeps none: the opaque shape is recognized
  // by its `encrypted` payload, so adding a type here would invent one.
  if (detail.form === 'encrypted') {
    return { ...(detail.wireType === undefined ? {} : { type: detail.wireType }), encrypted: detail.encrypted, ...index }
  }
  if (detail.form === 'summary') {
    return { ...(detail.wireType === undefined ? {} : { type: detail.wireType }), summary: detail.summary, ...index }
  }
  return { type: 'reasoning.text', text: detail.text, ...index }
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
        imageBlocks.push(...toolResultImageBlocks(current.content, images, media))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) messages.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      // The dialect key is read once per request: it is process-wide state, and
      // reading it per message could change it mid-build if another turn closes
      // a stream concurrently, which would send one request under two spellings.
      const reasoningKey = reasoningDialect.outboundKey()
      const { content, toolCalls, reasoning } = openAIAssistantContent(message, toolCallIds, reasoningKey)
      // An assistant turn with neither text, nor calls, nor reasoning carries nothing on this wire.
      if (content === '' && toolCalls.length === 0 && reasoning.fields.length === 0 && reasoning.details.length === 0) continue
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
      if (thinkingOn) applyReplayedReasoning(entry, reasoning, reasoningKey)
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

  // A deferred definition travels through a message-level addition instead.
  // Leaving it in the top-level list would put it back inside the very prefix
  // this route is holding still, which is the entire cost being avoided.
  const topLevelTools = (options.tools ?? []).filter((tool) => tool.deferLoading !== true)
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
    ...(topLevelTools.length > 0
      ? {
          tools: topLevelTools.map((tool) => ({
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
  const cause = trackPrefixStability(options)
  // An image the budget gave back rewrites the retained prefix, so a miss that
  // would otherwise have been attributed to the service is the offload's doing.
  // The prefix was otherwise stable, which is the only case this overrides:
  // a broken system prompt or a changed tool set is the better explanation.
  const drift: PrefixDriftCause = cause === 'stable'
    && (pendingImageOffloads.get(cacheScopeKey(options.sessionId)) ?? 0) > 0
    ? 'image-offload'
    : cause
  recordDriftCause(drift, options.sessionId)
  return wire === 'anthropic'
    ? buildAnthropicRequest(options, images, media)
    : buildOpenAIRequest(options, images, preserveThinking, media)
}

/**
 * What the body-fit loop actually did, so the remedy can describe it.
 *
 * Optional by design: a caller that has not run the loop leaves it undefined and
 * gets the composition-based message, so every direct assertion of this guard
 * keeps its exact text.
 */
export interface BodyFitContext {
  /** How many image occurrences the loop already replaced with a placeholder. */
  readonly droppedImages: number
  /** How many sendable image occurrences the body still carries. */
  readonly sendableImagesRemaining: number
  /** The overflow that remained after the last drop. */
  readonly excessBytes: number
}

/**
 * Reject a request the service would refuse for its size.
 *
 * This is the most frequently reported 400 on the coding endpoint, and it is
 * worth catching locally for two reasons: the message can name the actual
 * remedy (DSH's compaction), and a request that cannot succeed should not be
 * sent at all. The measured size is the real serialized body, so it accounts
 * for tool schemas and inlined images the caller cannot easily estimate.
 *
 * The ceiling is the caller's when it passes one, because the text/image tier is
 * graded by model and only the caller knows which model the turn is for; omitted,
 * the guard resolves the model-less default (or the video tier) itself.
 *
 * The error code is CONTEXT_OVERFLOW_CODE, not PROVIDER_ERROR, because naming the
 * remedy in prose is not the same as being able to act on it: DSH forces a
 * compaction and retries the same step only for that one code, and every other
 * 400-shaped failure ends the turn. A byte ceiling is answered by the same
 * compression a token ceiling is — the conversation shrinks either way — so the
 * body of the message stays as specific as it was while the code becomes one the
 * host can recover from.
 *
 * @param body the request body about to be serialized and sent.
 * @param carriesVideo whether the request attaches video, which has its own tier.
 * @param context what the body-fit loop already did, when it ran.
 * @param limit the ceiling already resolved for this request's model.
 * @returns the serialized body, so a caller that is about to send it does not
 * serialize a body of up to tens of megabytes a second time.
 */
export function assertRequestBodyFits(
  body: Record<string, unknown>,
  carriesVideo = false,
  context?: BodyFitContext,
  limit?: number,
): string {
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
  //
  // `limit` is the caller's own already-resolved ceiling, and it is preferred
  // over re-deriving one here because the text/image tier is graded by model: a
  // caller that asked maxRequestBodyBytesFor for THAT model must not have the
  // answer replaced by the model-less fallback, and the refusal has to quote the
  // number the request was really measured against. Omitted, the derivation
  // below is exactly what this guard always did, so every existing caller keeps
  // its behaviour byte for byte.
  const ceiling = limit ?? (carriesVideo ? MAX_VIDEO_MESSAGE_BODY_BYTES : maxMessageBodyBytes())
  if (bytes <= ceiling) return serialized
  throw new LlmError(oversizedBodyMessage(bytes, ceiling, body, context), CONTEXT_OVERFLOW_CODE)
}

/**
 * How a request body splits into the parts that share the ceiling.
 *
 * The body ceiling — 2 MB on the 256K tier, larger on the 1M tier — covers
 * images, conversation text, tool schemas and the system prompt together, but
 * only the first is compressible by dropping something. A
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

/**
 * What the loop DID, which is not always what the byte composition SUGGESTS.
 *
 * A caller that ran the loop passes what it did, and the message then names the action
 * that actually happened. One that did not — every direct assertion of the guard —
 * gets the composition-based text below, unchanged.
 *
 * Three states rather than two: an image can still be attached while omitting every
 * remaining one still cannot close the gap. That case used to be described with the
 * same sentence as a request the loop had just fixed by dropping images.
 */
function bodyFitRemedy(parts: RequestBodyBreakdown, context: BodyFitContext | undefined): string {
  if (context === undefined) {
    // Two failures that look identical from outside need different remedies, and
    // the old single message sent everyone to compaction even when their images
    // were the whole problem.
    return parts.imageBytes >= parts.otherBytes
      ? 'Older images are omitted first; drop or re-attach fewer images, or start a new session.'
      : 'The conversation text and tool schemas dominate, so no image budget can fix this: '
        + 'compact the conversation or start a new session.'
  }
  const dropped = context.droppedImages === 1
    ? '1 image was'
    : `All ${context.droppedImages} images were`
  if (context.sendableImagesRemaining === 0) {
    return context.droppedImages === 0
      ? 'This request carries no images, so no image budget can fix this: compact the conversation or start a new session.'
      : `${dropped} already omitted and the body is still over the limit, so no image budget can fix this: compact the conversation or start a new session.`
  }
  // An image is still attached and dropping all of them still cannot close a gap
  // wider than they are. Saying older images are omitted first would promise an
  // action the loop has already exhausted.
  const prior = context.droppedImages === 0 ? '' : ` (${dropped} omitted first)`
  return `The images still attached weigh less than the ${context.excessBytes}-byte overflow, so omitting all of them cannot fit this request${prior}: compact the conversation or start a new session.`
}

function oversizedBodyMessage(
  bytes: number,
  limit: number,
  body: Record<string, unknown>,
  context?: BodyFitContext,
): string {
  const parts = requestBodyBreakdown(body)
  const composition = `images ${parts.imageBytes} bytes, tool schemas ${parts.toolSchemaBytes} bytes, `
    + `conversation text and system prompt ${parts.otherBytes} bytes`
  // Two failures that look identical from outside need different remedies, and
  // the old single message sent everyone to compaction even when their images
  // were the whole problem.
  const remedy = bodyFitRemedy(parts, context)
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

/**
 * One run of reasoning and how it arrived.
 *
 * Length, not text: the run describes where a slice of the block came from
 * without storing the thinking twice, which keeps the persisted replay state
 * small and keeps it a plain JSON value. An encrypted run has `length: 0` — it
 * carries no visible text, only the opaque payload that must be handed back.
 */
export interface ReasoningRun {
  /** Wire field the slice arrived under. */
  readonly key: string
  /** Wire form, only meaningful when `key` is `reasoning_details`. */
  readonly form?: ReasoningForm
  /** Element `type` exactly as received; absent when the element carried none. */
  readonly wireType?: string
  /** Element index: the wire's own number, else the element's position. */
  readonly index?: number
  /** Opaque encrypted provider state (`form: 'encrypted'`); never text. */
  readonly encrypted?: string
  /** Length of the slice in the assembled block's text; 0 when there is none. */
  readonly length: number
}

export interface KimiCodeStreamState {
  wire: KimiCodeWire
  blocks: OutboundContentBlock[]
  current: { index: number; type: 'text' | 'reasoning'; text: string } | null
  /**
   * Which wire field the reasoning text of each block arrived under.
   *
   * One block can mix fields: a delta may carry `reasoning_content` and
   * `reasoning` together, and consecutive deltas may alternate spellings without
   * the block boundary moving. Each run records the key and the LENGTH of its
   * slice rather than the slice itself, so the provenance never duplicates the
   * thinking it describes and a replay can put every slice back under the field
   * it came from. Keyed by block index and serialized by
   * {@link reasoningReplayState}.
   */
  reasoningRuns: Map<number, ReasoningRun[]>
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
  /**
   * How the cache write above splits across the two TTL tiers.
   *
   * Read from the RESPONSE HEADERS rather than from the body: the service states
   * the totals in `usage`, and the per-tier split only in
   * `Msh-Usage-Cache-Write-Tokens-5m` / `...-1h`. The adapter reads them off the
   * `Response` it just received (the only place they exist) and writes them here,
   * so the rolling totals below have both halves. Absent headers leave both at
   * 0, which the contract defines as silence rather than as a claim.
   */
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
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
    reasoningRuns: new Map(),
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
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
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
    // `prompt_tokens` on this dialect is the TOTAL input: the hit and the write
    // are both inside it, and the three parts are disjoint
    // ("`cached_tokens`、`cache_write_tokens` 与未缓存部分互斥，三者之和等于
    // `input_tokens`"). A fresh count that subtracts only the hit would report the written
    // tokens a second time, so both are taken out — and `max(0, …)` guards a
    // service whose parts do not add up rather than emitting a negative count.
    const written = details ? numberOr(details.cache_write_tokens, 0) : 0
    state.inputTokens = Math.max(0, prompt - cached - written)
    state.cacheReadTokens = cached
    state.cacheWriteTokens = written
    state.outputTokens = numberOr(usage.completion_tokens, state.outputTokens)
    if (isRecord(usage.completion_tokens_details)) {
      state.reasoningTokens = numberOr(usage.completion_tokens_details.reasoning_tokens, state.reasoningTokens)
    }
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = isRecord(choice?.delta) ? (choice as Record<string, unknown>).delta as Record<string, unknown> : undefined

  if (delta) {
    // Read EVERY reasoning field this delta carries, in a fixed order, instead
    // of stopping at the first one. `reasoning_content` is Kimi's,
    // `reasoning_details` is the gateway spelling (an array of text/summary/
    // encrypted elements, or a bare string on older gateways), and `reasoning`
    // is newer vLLM's; a peer that sends two of them is stating two pieces of
    // thinking, so dropping the later one silently loses text the service
    // already charged for. Reading them all also keeps the learned dialect
    // pointing at the field the endpoint leads with, which is what the outbound
    // key still echoes.
    for (const fragment of reasoningDialect.observeAll(delta)) {
      const text = sanitizeText(fragment.text)
      // An encrypted fragment has no text at all, but it still has to own a
      // block: its opaque payload is replayed from that block's provenance, so a
      // turn whose only reasoning is encrypted must still produce the record.
      if (text === '' && fragment.form !== 'encrypted') continue
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'reasoning') out.push(...openTextBlock(state, 'reasoning'))
      if (text !== '') {
        state.current!.text += text
        state.hasContent = true
        out.push({ type: 'reasoning-delta', index: state.current!.index, text })
      }
      // Record how this slice arrived, so a later replay can write it back in the
      // same shape instead of collapsing the block onto one key. The payload of
      // an encrypted fragment is recorded verbatim; it never becomes text.
      const runs = state.reasoningRuns.get(state.current!.index) ?? []
      runs.push({
        key: fragment.key,
        ...(fragment.form === undefined ? {} : { form: fragment.form }),
        ...(fragment.wireType === undefined ? {} : { wireType: fragment.wireType }),
        ...(fragment.index === undefined ? {} : { index: fragment.index }),
        ...(fragment.encrypted === undefined ? {} : { encrypted: fragment.encrypted }),
        length: text.length,
      })
      state.reasoningRuns.set(state.current!.index, runs)
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
  | 'image-offload'

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
 * Image identities this session has given back to the image budget.
 *
 * Scoped per session for the same reason the prefix snapshots are: DSH runs
 * several conversations — and subagents — at once, so one process-wide set
 * would let one conversation's omission replace another conversation's image.
 */
const sessionDroppedImageKeys = new Map<string, Set<string>>()

/**
 * What the most recent request of one session carried, in image bytes.
 */
const sessionImageBudgetStats = new Map<string, KimiCodeSessionImageBudgetStats>()

/**
 * Images the request CURRENTLY BEING BUILT has already dropped.
 *
 * Separate from {@link sessionDroppedImageKeys} because the two answer
 * different questions: the set is what the session remembers, and this counter
 * is what the request in flight did. The counter is what lets the drift
 * attribution name the offload, whichever order the build and the recording
 * happen in.
 */
const pendingImageOffloads = new Map<string, number>()

/**
 * What one session's last request carried of images.
 */
export interface KimiCodeSessionImageBudgetStats {
  /** Base64 image bytes the most recent request carried. */
  requestImageBytes: number
  /** Image occurrences the most recent request replaced with a placeholder. */
  droppedImages: number
  /** Every image identity this session has dropped so far. */
  droppedKeys: string[]
}

/**
 * The image identities this session has already dropped.
 *
 * `durableDropped` seeds the memory the first time a session is asked about,
 * so a session that ran before the restart keeps the omissions it made: the
 * budget is sticky, and a picture that was given back must stay given back.
 */
export function getSessionDroppedImageKeys(
  sessionId?: string,
  durableDropped?: readonly string[],
): ReadonlySet<string> {
  // An UNNAMED request has no session to be sticky within. It drops what its
  // own budget says and remembers nothing, because a shared unscoped bucket
  // would let one caller's omission reach another caller's request: a probe
  // that dropped a picture would silently drop the same picture id from an
  // unrelated conversation that happened to send no session either.
  if (sessionId === undefined || sessionId.trim() === '') return new Set<string>()
  const scope = cacheScopeKey(sessionId)
  const existing = sessionDroppedImageKeys.get(scope)
  if (existing !== undefined) return existing
  const seeded = new Set<string>()
  for (const key of durableDropped ?? []) {
    if (typeof key === 'string' && key !== '') seeded.add(key)
  }
  rememberScoped(sessionDroppedImageKeys, scope, seeded)
  return seeded
}

/**
 * Note that the request being built has dropped images, before its body is built.
 *
 * The drift attribution reads this back when the prefix is fingerprinted, so
 * the order of the two does not matter: a request that drops an image is
 * attributed to the offload whether the body was built before or after the
 * drop was recorded.
 */
export function markPendingImageOffload(sessionId: string | undefined, newlyDroppedCount: number): void {
  const scope = cacheScopeKey(sessionId)
  if (newlyDroppedCount <= 0) {
    pendingImageOffloads.delete(scope)
    return
  }
  rememberScoped(pendingImageOffloads, scope, newlyDroppedCount)
}

/**
 * Record what one request's image budget did.
 *
 * The dropped identities are kept for the whole session: the budget is sticky,
 * so an image given back stays given back, and the next turn has to know
 * which ones those are.
 */
export function recordSessionImageBudget(
  sessionId: string | undefined,
  input: {
    allDroppedKeys: Iterable<string>
    newlyDroppedCount: number
    requestImageBytes: number
    droppedImages: number
  },
): void {
  const scope = cacheScopeKey(sessionId)
  // The dropped identities are remembered only for a NAMED session: the budget
  // is sticky WITHIN a conversation, and an unnamed request has no conversation
  // to be sticky in. Its own numbers are still recorded, so a status card that
  // asks about "whatever ran last" can still answer.
  const named = sessionId !== undefined && sessionId.trim() !== ''
  const keys = named ? (sessionDroppedImageKeys.get(scope) ?? new Set<string>()) : new Set<string>()
  if (named) {
    for (const key of input.allDroppedKeys) {
      if (typeof key === 'string' && key !== '') keys.add(key)
    }
    rememberScoped(sessionDroppedImageKeys, scope, keys)
  }
  rememberScoped(sessionImageBudgetStats, scope, {
    requestImageBytes: input.requestImageBytes,
    droppedImages: input.droppedImages,
    droppedKeys: named ? [...keys] : [],
  })
  markPendingImageOffload(sessionId, input.newlyDroppedCount)
  // An image the budget gave back rewrites the retained prefix, so the miss it
  // causes is the offload's doing rather than the service's.
  if (input.newlyDroppedCount > 0 && getLastDriftCause(sessionId) === 'stable') {
    recordDriftCause('image-offload', sessionId)
  }
}

/**
 * What one session's last request carried of images, when it is known.
 *
 * `undefined` for a session that has not sent a request, rather than a zeroed
 * answer: "no request yet" and "a request that carried no images" are
 * different facts.
 */
export function getSessionImageBudgetStats(sessionId?: string): KimiCodeSessionImageBudgetStats | undefined {
  return sessionImageBudgetStats.get(cacheScopeKey(sessionId))
}

/**
 * One request whose disabled-thinking level had to be raised.
 *
 * The service answers HTTP 400 for "thinking off" on a model that cannot stop
 * reasoning, and the user's real intent there is "spend less", not "fail the
 * turn" — so the latch lifts the level to the model's own default (see
 * coerceThinkingEffort). Lifting it silently would spend more quota than was
 * asked for with nothing saying why, which is why the lift is both RECORDED here
 * (so a caller can read it back per session, the way the drift cause is read
 * back) and ANNOUNCED on the process warning channel.
 */
export interface KimiCodeThinkingCoercion {
  /** Model whose declaration forbade the requested level. */
  model: string
  /** Wire the request was built for, since the gate runs for both. */
  wire: KimiCodeWire
  /** The level that could not be sent. Only 'none' is ever lifted. */
  from: 'none'
  /** The level actually sent; undefined means "no level at all". */
  to: KimiCodeReasoningEffort | undefined
}

/** Last lift per session. */
const thinkingCoercions = new Map<string, KimiCodeThinkingCoercion>()

/**
 * Record one lift, and make it visible.
 *
 * `process.emitWarning` rather than a thrown error or a silently swallowed
 * value: the request must still go out (that is the whole point of the lift),
 * but a diagnostic that reaches stderr with a stable code is what keeps it from
 * being invisible. It is emitted once per turn, and only for a model that
 * actually declares thinking-only, so a deployment that never asks for 'none'
 * never sees one.
 */
export function recordThinkingCoercion(coercion: KimiCodeThinkingCoercion, sessionId?: string): void {
  rememberScoped(thinkingCoercions, cacheScopeKey(sessionId), coercion)
  const target = coercion.to === undefined ? 'the service default' : '"' + coercion.to + '"'
  process.emitWarning(
    '[kimi-code] model "' + coercion.model + '" cannot disable thinking; sending ' + target
      + ' instead of "none" on the ' + coercion.wire + ' wire.',
    { code: 'KIMI_CODE_THINKING_COERCED' },
  )
}

/**
 * The lift recorded for one session, if any.
 *
 * `undefined` for a session that never asked for a disabled level, rather than a
 * default value: "no lift happened" and "a lift happened to the same value" are
 * different facts and only the absent case can say the first.
 */
export function getLastThinkingCoercion(sessionId?: string): KimiCodeThinkingCoercion | undefined {
  return thinkingCoercions.get(cacheScopeKey(sessionId))
}

/**
 * Response headers that split a cache write across its two TTL tiers.
 *
 * The service states the write TOTAL in 'usage' and the per-tier split only in
 * these headers, so the split has to be read off the HTTP response — there is no
 * body field for it. Both are decimal integers; a missing or non-numeric value
 * means the header said nothing, which is recorded as 0 rather than guessed at
 * (see KimiCodeCacheStatsDto.cacheWrite5mTokens: an absent header is silence,
 * not a claim that nothing was written to that tier).
 */
export const CACHE_WRITE_5M_HEADER = 'Msh-Usage-Cache-Write-Tokens-5m'
export const CACHE_WRITE_1H_HEADER = 'Msh-Usage-Cache-Write-Tokens-1h'

/** Decimal whole-token count from one response header, or 0 when it is silent. */
function headerCount(headers: Headers, name: string): number {
  const raw = headers.get(name)
  if (raw === null) return 0
  const text = raw.trim()
  // A strict integer spelling only: Number('') is 0 and Number('1e3') is 1000,
  // and neither describes a token count the service meant to state.
  if (!/^\d+$/.test(text)) return 0
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : 0
}

/** The two tier counts one response's headers state. */
export function cacheWriteTiers(headers: Headers): { write5m: number; write1h: number } {
  return {
    write5m: headerCount(headers, CACHE_WRITE_5M_HEADER),
    write1h: headerCount(headers, CACHE_WRITE_1H_HEADER),
  }
}

/**
 * File one response's tier counts on the stream state that will close it.
 *
 * Called by the adapter on the Response itself, which is the only place the
 * headers exist; the totals are then filed with the rest of the usage when the
 * stream closes, so one turn's numbers stay one turn's numbers.
 */
export function applyCacheWriteTiers(state: KimiCodeStreamState, headers: Headers): void {
  const tiers = cacheWriteTiers(headers)
  state.cacheWrite5mTokens = tiers.write5m
  state.cacheWrite1hTokens = tiers.write1h
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
  /**
   * Prompt tokens the provider counted as cache writes.
   *
   * Reported by both wires this line speaks: `cache_creation_input_tokens` on
   * the Anthropic surface and `prompt_tokens_details.cache_write_tokens` on
   * chat-completions. Never derived from the read count — a write is a
   * different billed event.
   */
  cacheWriteTokens: number
  /** Share of the writes above the service attributed to the 5m tier (headers). */
  cacheWrite5mTokens: number
  /** Share of the writes above the service attributed to the 1h tier (headers). */
  cacheWrite1hTokens: number
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
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
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
    cacheWrite5mTokens: previous.cacheWrite5mTokens + state.cacheWrite5mTokens,
    cacheWrite1hTokens: previous.cacheWrite1hTokens + state.cacheWrite1hTokens,
  })
}

/** Add one entry into an accumulator. */
function accumulate(totals: KimiCodeCacheStats, stats: KimiCodeCacheStats): void {
  totals.requests += stats.requests
  totals.cachedTokens += stats.cachedTokens
  totals.freshTokens += stats.freshTokens
  totals.outputTokens += stats.outputTokens
  totals.cacheWriteTokens += stats.cacheWriteTokens
  totals.cacheWrite5mTokens += stats.cacheWrite5mTokens
  totals.cacheWrite1hTokens += stats.cacheWrite1hTokens
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
    thinkingCoercions.clear()
    sessionDroppedImageKeys.clear()
    sessionImageBudgetStats.clear()
    pendingImageOffloads.clear()
    return
  }
  dropSession(cacheStatsByScope, sessionId)
  dropSession(prefixSnapshots, sessionId)
  dropSession(driftCauses, sessionId)
  dropSession(thinkingCoercions, sessionId)
  dropSession(sessionDroppedImageKeys, sessionId)
  dropSession(sessionImageBudgetStats, sessionId)
  dropSession(pendingImageOffloads, sessionId)
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

/**
 * Replay metadata: which wire field every reasoning slice arrived under.
 *
 * The envelope is the only channel this route has for provenance. The harness's
 * `ReasoningBlock` is `{type, text}`, and its assembler rebuilds a streamed
 * reasoning block from the accumulated deltas, so a field added to the block
 * would be dropped before the message is stored. A terminal `finish` chunk's
 * `replayState` is persisted verbatim onto the assembled message's model
 * source, which is where the request builder reads it back - the Claude route in
 * this package relies on the same seam.
 *
 * Shape: one entry per emitted block, because assembly discards an envelope
 * whose block list does not match the emitted block count. A text or tool-call
 * block is therefore an explicit `null` rather than a skipped slot, and a
 * reasoning block is `{ reasoning: [{key, form?, wireType?, index?, encrypted?,
 * length}] }`. Only lengths are stored, never the text, and an encrypted run
 * carries `length: 0` plus the opaque payload — the one thing that must be
 * handed back to the provider unchanged. Everything here is plain JSON (strings,
 * numbers, arrays, nulls), which is what the harness's lossless-JSON check
 * requires.
 */
function reasoningReplayState(
  state: KimiCodeStreamState,
): { response: unknown; blocks: unknown[] } | undefined {
  if (state.reasoningRuns.size === 0) return undefined
  const blocks = state.blocks.map((block, index) => {
    const runs = state.reasoningRuns.get(index)
    if (runs === undefined || runs.length === 0 || block.type !== 'reasoning') return null
    return {
      reasoning: runs.map((run) => ({
        key: run.key,
        ...(run.form === undefined ? {} : { form: run.form }),
        ...(run.wireType === undefined ? {} : { wireType: run.wireType }),
        ...(run.index === undefined ? {} : { index: run.index }),
        ...(run.encrypted === undefined ? {} : { encrypted: run.encrypted }),
        length: run.length,
      })),
    }
  })
  return { response: { wire: state.wire }, blocks }
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
  const replayState = reasoningReplayState(state)
  out.push({
    type: 'finish',
    reason: finishReasonFor(state),
    ...(replayState === undefined ? {} : { replayState }),
  })
  return out
}

/** Model families whose stream never carried a terminal event. */
export function assertStreamComplete(state: KimiCodeStreamState): void {
  if (!state.done && state.finishReason === null) {
    // An answer that was cut off, not a request the provider refused: the
    // connection ended cleanly inside the stream, which is the transport failing
    // in the one shape that leaves no exception behind. TRANSPORT is what makes
    // the harness ask for the same step again instead of ending the turn on half
    // an answer — the sibling shape of undici's `TypeError: terminated`, raised at
    // the mapper because only here is it visible that nothing terminal arrived.
    throw new LlmError('Kimi Code stream ended before its terminal event', 'TRANSPORT')
  }
}
