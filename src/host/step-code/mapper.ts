/**
 * Wire mapping for the Step Code (Step Plan subscription) chat endpoint.
 *
 * The endpoint is OpenAI Chat Completions shaped — every Step profile
 * (`step_plan`, `step_plan_oversea`, `platform_cn`, `platform_oversea`)
 * answers `{base}/v1/chat/completions` with the standard SSE frames (official
 * `step-provider/index.ts:88` pins one dialect, `STEP_MODEL_API =
 * "openai-completions"`, for every model). This module therefore looks like its
 * GLM sibling and exists to absorb the places where Step is not
 * OpenAI:
 *
 * 1. **The output cap is `max_tokens`, never `max_completion_tokens`.**
 *    Step's Chat Completions documentation defines only `max_tokens`. The
 *    official client picks the field from a detected `compat.maxTokensField`
 *    (`openai-completions.ts:816-819`); this route hardwires the documented one
 *    instead of running detection per request.
 * 2. **Cache reads are reported at the TOP LEVEL as `usage.cached_tokens`.**
 *    That is the field Step's own documentation names as the hit criterion
 *    (`cached_tokens > 0`), and it is NOT in this repository's shared diagnostic
 *    parse chain (`common/request-diagnostics.ts:406-409` reads
 *    `prompt_tokens_details.cached_tokens` → `cache_read_input_tokens` →
 *    `cache_read_tokens`). So this route carries its own chain, driven by the
 *    frozen `STEP_CODE_CACHE_READ_FIELD_ORDER`; see {@link parseStepCodeUsage}.
 * 3. **Caching is automatic and parameterless.** The server keeps an automatic
 *    prefix cache (a prefix of at least 256 tokens hits, LRU eviction, no request
 *    field). The official client sends nothing at all to a Step endpoint:
 *    `prompt_cache_key` is gated on `baseUrl.includes("api.openai.com")`
 *    (`openai-completions.ts:799-801`), session-affinity headers are off for Step,
 *    and `cache_control` only exists on the Anthropic wire. This module follows
 *    that default exactly and adds `prompt_cache_key` only behind an explicit
 *    caller flag; see {@link stepCodePromptCacheKey}.
 * 4. **There is no cache write to report, and no price to report.** Automatic
 *    prefix caching has no client-visible write step, so `cacheWriteTokens` is 0
 *    on this route and the route says so out loud
 *    (`STEP_CODE_CACHE_WRITE_NOTE`). Every Step model lists all-zero prices
 *    (`MODEL_DEFAULTS.cost`, `step-provider/index.ts:102`), so money is derived
 *    from that table instead of a guessed rate — see
 *    {@link STEP_CODE_PRICE_PER_MILLION_TOKENS}.
 *
 * ## Why the constants are imported, not restated
 *
 * Every ladder, ceiling and default below comes from `./types.ts`,
 * `./model-catalog.ts` or `../../shared/step-code-contracts.ts`. Writing a
 * second copy of a value is how a route starts lying: upstream moves one step of
 * a ladder and this file keeps sending the old one, with no test and no compile
 * error pointing at it. `STEP_CODE_CACHE_READ_FIELD_ORDER` is even walked at
 * runtime rather than transcribed, so adding a rung upstream changes the parse
 * here without a second edit.
 *
 * ## Division of labour
 *
 * The request URL is NOT assembled here: the caller owns the base URL because the
 * region profile decides it, and this file performs no network I/O at all (fetch,
 * SSE reading and byte decoding belong to the transport layer). Like the sibling
 * routes the adapter owns the transport: it builds the body with
 * {@link buildChatRequest}, feeds SSE lines to {@link processStreamLine}, flushes
 * with {@link closeStream}, checks {@link assertStreamComplete}, and turns a
 * non-2xx response into an `LlmError` with {@link classifyStepCodeFailure}.
 *
 * @module dsh-chatgpt-subscription/step-code-mapper
 */

import {
  CHAT_COMPLETIONS_PATH,
  MODEL_DEFAULTS,
  PROVIDER_NAME,
  STEP_CODE_EFFORTS,
  convergeStepCodeEffort,
  defaultMaxTokens,
} from './types.ts'
import type { StepCodeModelEntry } from './model-catalog.ts'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER,
  STEP_CODE_CACHE_WRITE_NOTE,
  STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH,
  type StepCodeReasoningEffort,
} from '../../shared/step-code-contracts.ts'
import { CONTEXT_OVERFLOW_CODE, isContextOverflow, isHttpContextOverflow } from '../common/context-overflow.ts'
import {
  LlmError,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type OutboundContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '../common/llm-compat.ts'
import { toToolCallId } from '../common/brand-compat.ts'
import { stripMetaSchema } from '../common/tool-schema.ts'
import {
  MAX_REQUEST_IMAGE_BYTES as SHARED_IMAGE_BUDGET,
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages as offloadOldestImagesWithinBudget,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
} from '../common/request-images.ts'

// Re-exported so this line keeps one import surface for its own adapter: the
// path it must call, the ladder it may send, and the cache constants its card
// has to label honestly.
export { CHAT_COMPLETIONS_PATH, STEP_CODE_EFFORTS, STEP_CODE_CACHE_WRITE_NOTE }
export { STEP_CODE_CACHE_READ_FIELD_ORDER, STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH }
export { resolveRequestImages }
export type { AttachmentImageReader, ResolvedRequestImage, ResolvedRequestImages, StepCodeReasoningEffort }

/** One selectable thinking level on the Step endpoint. */
export type { StepCodeReasoningEffort as StepCodeEffort }

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

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

/** Drop NUL, which several gateways reject inside a prompt or an argument. */
function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

/** A finite non-negative provider counter, or undefined so a chain can skip it. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return optionalNumber(value) ?? fallback
}

/** Read a dotted path such as `prompt_tokens_details.cached_tokens`. */
function numberAtPath(source: Record<string, unknown>, path: string): number | undefined {
  let cursor: unknown = source
  for (const key of path.split('.')) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return optionalNumber(cursor)
}

// ---------------------------------------------------------------------------
// Route constants
// ---------------------------------------------------------------------------

/**
 * Price of one million tokens on every Step model: zero, read from the catalog.
 *
 * `MODEL_DEFAULTS.cost` hardwires `{ input: 0, output: 0, cacheRead: 0,
 * cacheWrite: 0 }` — the upstream table was never filled in, and Step Plan is a
 * subscription rather than a metered SKU. Deriving the number from that table
 * keeps this value honest if the table is ever completed: a route that
 * multiplied tokens by an invented rate would show a plausible, wrong number,
 * while zero is the only defensible one. The card shows the token dimension
 * alone (see `STEP_CODE_PRICING_STATUS` in the shared contracts).
 */
export const STEP_CODE_PRICE_PER_MILLION_TOKENS = MODEL_DEFAULTS.cost.input

/**
 * Base64 image payload one request may carry on this route.
 *
 * Step publishes no per-request image ceiling, so this is a defensive budget
 * rather than a documented limit: it mirrors the sibling OpenAI-shaped routes'
 * budget (12 MB) and exists so a runaway conversation degrades to placeholders
 * instead of growing a body the transport has to carry. Lower it once a real
 * Step ceiling has been measured — the offload mechanism itself is shared.
 */
export const STEP_CODE_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

/**
 * The shared image budget, for a caller that prefers the plugin's conservative
 * ceiling to {@link STEP_CODE_MAX_REQUEST_IMAGE_BYTES}.
 */
export const STEP_CODE_SHARED_IMAGE_BUDGET = SHARED_IMAGE_BUDGET

// ---------------------------------------------------------------------------
// Request images
// ---------------------------------------------------------------------------

/**
 * Replace the oldest inline images with a visible placeholder once one request
 * would exceed {@link STEP_CODE_MAX_REQUEST_IMAGE_BYTES}.
 *
 * Durable history is untouched; only the request about to be sent changes, and
 * the budget is passed in rather than inherited so this route's ceiling and the
 * shared default stay two separate decisions.
 */
export function offloadOldestStepCodeRequestImages(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): GenerateOptions {
  return offloadOldestImagesWithinBudget(options, STEP_CODE_MAX_REQUEST_IMAGE_BYTES, images)
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
      // A tool-result image is named, not inlined: a `role: "tool"` message can
      // only carry text, so its pixels ride a separate user message.
      if (block.type === 'image') return `[image: ${attachmentLabel(block) ?? 'attached image'}]`
      return ''
    })
    .join('')
}

/** Text standing in for an image this request cannot send. */
function visionRefusalText(block: Record<string, unknown>, supportsImages: boolean): string {
  if (!supportsImages) {
    const label = attachmentLabel(block)
    const subject = label ? label : 'the attached image'
    return `[image omitted: ${subject} — the selected Step model does not declare image input (enable_vision_input).]`
  }
  return unavailableImageText(block)
}

/** `image_url` blocks for one tool result; they ride a user message. */
function toolResultImageBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
  supportsImages: boolean,
): OpenAIMessage[] {
  if (!Array.isArray(blocks)) return []
  const out: OpenAIMessage[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const inline = supportsImages ? imageBlockToInline(block, images) : undefined
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        out.push({ type: 'text', text: visionRefusalText(block, supportsImages) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...toolResultImageBlocks(block.content, images, supportsImages))
  }
  return out
}

/**
 * Tool arguments keep the model's own JSON text.
 *
 * Deliberately not parsed and re-serialized: large numbers, unicode escapes and
 * key order are evidence of what the model produced, and a round trip rewrites
 * all three while the execution side compares arguments as strings.
 */
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
  // A hand-built one-shot request may carry messages without provenance; only a
  // real tool-result message has one.
  return message.source?.kind === 'tool'
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

/** Collect every system contribution into the single leading system message. */
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

// ---------------------------------------------------------------------------
// OpenAI Chat Completions request
// ---------------------------------------------------------------------------

type OpenAIMessage = Record<string, unknown>

function openAIUserContent(
  message: Message,
  images: ResolvedRequestImages,
  supportsImages: boolean,
): string | OpenAIMessage[] {
  if (!Array.isArray(message.content)) return ''
  const parts: OpenAIMessage[] = []
  let hasImage = false
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const inline = supportsImages ? imageBlockToInline(block, images) : undefined
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        hasImage = true
        parts.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        parts.push({ type: 'text', text: visionRefusalText(block, supportsImages) })
      }
    }
  }
  // Without an image the wire prefers the plain-string form; the block-array
  // form is only needed once something other than text is present.
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
    // Reasoning blocks are never replayed: Chat Completions has no field for a
    // model to accept its own thinking back, so sending one would mean sending a
    // field the endpoint does not define.
  }
  return { content: textParts.join(''), toolCalls }
}

/**
 * Reasoning effort to put on the wire, or undefined to omit the field.
 *
 * Delegates to the line's own {@link convergeStepCodeEffort}, which snaps the
 * caller's effort onto the ladder THIS model declared in
 * `reasoning_effort_support_list` and answers null for an empty ladder. Two
 * outcomes matter here and both mean "do not send": an absent/blank request, and
 * a model that declares no effort field at all. Nothing outside the declared
 * ladder ever reaches the body — an effort the endpoint does not list is a
 * rejected request, not a rounded-down preference.
 */
export function resolveStepCodeReasoningEffort(
  requested: unknown,
  ladder: readonly string[],
): StepCodeReasoningEffort | undefined {
  if (typeof requested !== 'string') return undefined
  const effort = requested.trim()
  if (effort === '') return undefined
  return convergeStepCodeEffort(effort, ladder) ?? undefined
}

/**
 * `prompt_cache_key` for this request, or undefined to send no cache field.
 *
 * THE default is undefined. Step's server-side cache is automatic and takes no
 * parameter, and the official client sends no cache parameter to a Step endpoint
 * at all — `prompt_cache_key` is gated on
 * `baseUrl.includes("api.openai.com")` (`openai-completions.ts:799-801`),
 * session-affinity headers are disabled for Step, and `prompt_cache_retention`
 * (24h) is an undocumented field this route never sends either. The key is
 * therefore behind the caller's explicit `cacheRequestParams` flag, so a
 * deployment that measured the endpoint's acceptance can turn it on and one that
 * did not sends exactly what the official client sends.
 */
export function stepCodePromptCacheKey(
  options: GenerateOptions,
  request: StepCodeRequestOptions,
): string | undefined {
  // The single gate. Absent or false this returns undefined and the body carries
  // no cache field of any kind — no prompt_cache_key, no retention, no
  // Anthropic-style cache_control.
  if (request.cacheRequestParams !== true) return undefined
  return clampStepCodePromptCacheKey(options.sessionId)
}

/**
 * Clamp a session id to {@link STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH} code
 * points, or undefined when there is nothing to key on.
 */
export function clampStepCodePromptCacheKey(sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  const trimmed = sessionId.trim()
  if (trimmed === '') return undefined
  // Array.from iterates code points, so an emoji or an astral CJK character is
  // counted once. A slice over UTF-16 units could split a surrogate pair and put
  // a lone surrogate on the wire, which the gateway rejects.
  const codePoints = Array.from(trimmed)
  if (codePoints.length <= STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH) return trimmed
  return codePoints.slice(0, STEP_CODE_PROMPT_CACHE_KEY_MAX_LENGTH).join('')
}

/** Per-request knobs the wire needs but the conversation does not carry. */
export interface StepCodeRequestOptions {
  /** Whether the selected model declares image input (`enable_vision_input`). */
  supportsImages?: boolean
  /**
   * Output ceiling to use when the caller stated none; normally the catalog
   * entry's `defaultMaxTokens`. Falls back to the line's own rule ("no reported
   * output cap, so equal to the input window").
   */
  defaultMaxTokens?: number
  /**
   * Efforts this model declared (`reasoning_effort_support_list`). Empty — the
   * undeclared-model row — means no effort field is sent at all.
   */
  reasoningEfforts?: readonly string[]
  /**
   * Whether to send the optional `prompt_cache_key`. Off by default, exactly
   * like the official client on a Step endpoint; see
   * {@link stepCodePromptCacheKey}. This is a per-settings capability bit, not a
   * model property, which is why {@link stepCodeRequestOptionsFor} leaves it to
   * the caller.
   */
  cacheRequestParams?: boolean
}

/** Factory defaults: images gated off, no cache parameter, no ladder. */
export const DEFAULT_STEP_CODE_REQUEST_OPTIONS: StepCodeRequestOptions = {
  supportsImages: false,
  cacheRequestParams: false,
}

/**
 * The wire knobs for one catalog row.
 *
 * Exists so the field-by-field copy from a catalog entry lives in exactly one
 * place: the adapter resolves the entry and only has to add the two things that
 * are not model properties — the cache capability bit and a caller override of
 * the output ceiling. An unknown model yields the undeclared row's facts (no
 * ladder, no images), which is what makes "never send a field the endpoint does
 * not declare" the default path rather than a special case.
 */
export function stepCodeRequestOptionsFor(
  entry: StepCodeModelEntry | undefined,
  overrides: { cacheRequestParams?: boolean; defaultMaxTokens?: number } = {},
): StepCodeRequestOptions {
  const base: StepCodeRequestOptions = entry === undefined
    ? { supportsImages: false, defaultMaxTokens: defaultMaxTokens(), reasoningEfforts: [] }
    : {
        supportsImages: entry.supportsImages,
        defaultMaxTokens: entry.defaultMaxTokens,
        reasoningEfforts: entry.reasoningEfforts,
      }
  return {
    ...base,
    ...(overrides.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: overrides.defaultMaxTokens }),
    ...(overrides.cacheRequestParams === undefined ? {} : { cacheRequestParams: overrides.cacheRequestParams }),
  }
}

/**
 * Build one `{base}/v1/chat/completions` body.
 *
 * Always `stream: true` with `stream_options: { include_usage: true }`: the
 * cache numbers this line exists to report arrive on the terminal frame, and
 * there is no non-streaming path to keep in sync. The output cap is
 * `max_tokens`, the field Step documents (see the module note).
 *
 * Session-folded tool history has no field on this wire, so the complete tool
 * declarations are sent every request — the documented behaviour of omitting
 * `toolHistory`, not a silent drop of it.
 */
export function buildChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  request: StepCodeRequestOptions = DEFAULT_STEP_CODE_REQUEST_OPTIONS,
): Record<string, unknown> {
  const supportsImages = request.supportsImages === true
  const messages: OpenAIMessage[] = []
  // A leading system turn is optional on this endpoint, so a request without a
  // prompt simply omits it rather
  // than inventing a neutral one that would change model behaviour.
  const system = leadingSystemText(options)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]
    if (isToolResultMessage(message)) {
      // Parallel tool calls emit several consecutive tool messages, and a user
      // turn wedged between them breaks the run. The whole run is scanned, its
      // images collected, and one user message appended after.
      const imageBlocks: OpenAIMessage[] = []
      while (index < conversation.length && isToolResultMessage(conversation[index])) {
        const current = conversation[index]
        const block = current.content[0]
        const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: callId, content: toolResultText(current.content) })
        imageBlocks.push(...toolResultImageBlocks(current.content, images, supportsImages))
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
      // An assistant turn with neither text nor calls carries nothing here.
      if (content !== '' || toolCalls.length > 0) messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images, supportsImages)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  const effort = resolveStepCodeReasoningEffort(options.reasoningEffort, request.reasoningEfforts ?? [])
  const cacheKey = stepCodePromptCacheKey(options, request)
  // No reported output cap on this endpoint, so the line's rule applies: equal to
  // the input window. Kept as the fallback rather than a second literal.
  const maxTokens = options.maxTokens ?? request.defaultMaxTokens ?? defaultMaxTokens()

  return {
    model: options.model,
    messages,
    stream: true,
    // The terminal usage frame is the only place this route's cache read numbers
    // appear.
    stream_options: { include_usage: true },
    // Step's Chat Completions documents `max_tokens`; `max_completion_tokens`
    // is OpenAI's o-series spelling and is never sent here.
    max_tokens: maxTokens,
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
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    // Present only when the caller turned the capability on; see the module note
    // for why the default body carries no cache field.
    ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** One usage frame read off the wire, already normalized. */
export interface StepCodeParsedUsage {
  /** The endpoint's aggregate prompt count, before the cache split. */
  promptTokens: number
  /** Uncached input, disjoint from the two cache buckets. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/**
 * Cache reads for one usage frame, walking the frozen
 * `STEP_CODE_CACHE_READ_FIELD_ORDER`.
 *
 * The order is NOT restated here — it is the shared contract's array, walked in
 * order — for two reasons. The third rung is the one this route lives or dies by:
 * top-level `usage.cached_tokens` is the field Step's documentation shows and
 * the one its hit criterion (`> 0`) is written against, while the repository's
 * shared diagnostic chain (`common/request-diagnostics.ts:406-409`) has no rung
 * for it. And a second hand-written list of the same four names is exactly the
 * shape that rots the first time upstream reorders or extends it.
 *
 * The fifth rung is `0`, meaning "the endpoint reported nothing" rather than
 * "nothing hit"; hit or miss is judged against the prefix length upstream.
 */
export function readCacheReadTokens(usage: Record<string, unknown>): number {
  for (const path of STEP_CODE_CACHE_READ_FIELD_ORDER) {
    const value = numberAtPath(usage, path)
    if (value !== undefined) return value
  }
  return 0
}

/**
 * Normalize one `usage` object into DSH's disjoint counters.
 *
 * Cache writes are read only from `prompt_tokens_details.cache_write_tokens`,
 * which this endpoint never reports (automatic prefix cache), so the value is 0
 * here — see {@link STEP_CODE_CACHE_WRITE_NOTE}. It still takes part in the
 * subtraction so an endpoint that does report one is accounted correctly.
 * Reasoning tokens are OpenAI's own detail field; completion_tokens already
 * includes them, so nothing is subtracted there.
 */
export function parseStepCodeUsage(raw: unknown): StepCodeParsedUsage | undefined {
  if (!isRecord(raw)) return undefined
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const promptTokens = numberOr(raw.prompt_tokens, 0)
  const cacheRead = readCacheReadTokens(raw)
  const cacheWrite = optionalNumber(details?.cache_write_tokens) ?? 0
  const outputDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined
  return {
    promptTokens,
    // DSH counts are disjoint: cached input is reported separately, so it comes
    // back out of the provider's aggregate prompt count.
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens: numberOr(raw.completion_tokens, 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: numberOr(outputDetails?.reasoning_tokens, 0),
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
  started: boolean
}

/** Accumulated state of one Step streaming response. */
export interface StepCodeStreamState {
  blocks: OutboundContentBlock[]
  current: OpenTextBlock | null
  /** wire tool index -> accumulating call. */
  toolCalls: Map<number, PendingToolCall>
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  /** The `[DONE]` sentinel arrived. */
  done: boolean
  /** Terminal chunks were already emitted. */
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
}

interface OpenTextBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

export function createStreamState(): StepCodeStreamState {
  return {
    blocks: [],
    current: null,
    toolCalls: new Map(),
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

function closeCurrent(state: StepCodeStreamState): StreamChunk[] {
  const current = state.current
  if (current === null) return []
  const { index, type, text } = current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: StepCodeStreamState): StreamChunk[] {
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

function openTextBlock(
  state: StepCodeStreamState,
  type: 'text' | 'reasoning',
): { chunks: StreamChunk[]; block: OpenTextBlock } {
  const out = closeCurrent(state)
  const index = state.blocks.length
  const block: OpenTextBlock = { index, type, text: '' }
  state.current = block
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return { chunks: out, block }
}

/**
 * Append one delta to the open block of `type`, opening one when the stream
 * switched kind.
 *
 * Reasoning and text stay separate DSH blocks because a model may think out loud
 * before answering, and a consumer that wants only the answer must be able to
 * drop the thinking without parsing it out of a text run.
 */
function appendTextDelta(
  state: StepCodeStreamState,
  type: 'text' | 'reasoning',
  text: string,
): StreamChunk[] {
  const out: StreamChunk[] = [...closeToolCalls(state)]
  let block = state.current
  if (block === null || block.type !== type) {
    const opened = openTextBlock(state, type)
    out.push(...opened.chunks)
    block = opened.block
  }
  block.text += text
  state.hasContent = true
  out.push(
    type === 'reasoning'
      ? { type: 'reasoning-delta', index: block.index, text }
      : { type: 'text-delta', index: block.index, text },
  )
  return out
}

function openToolCall(
  state: StepCodeStreamState,
  entry: Record<string, unknown>,
  wireIndex: number,
): { chunks: StreamChunk[]; call: PendingToolCall } {
  const out = closeCurrent(state)
  const blockIndex = state.blocks.length
  const fn = isRecord(entry.function) ? entry.function : undefined
  const call: PendingToolCall = {
    blockIndex,
    id: asString(entry.id) ?? `call_${wireIndex}`,
    name: asString(fn?.name) ?? '',
    arguments: '',
    started: false,
  }
  state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' })
  state.toolCalls.set(wireIndex, call)
  return { chunks: out, call }
}

function applyToolDelta(entry: Record<string, unknown>, state: StepCodeStreamState): StreamChunk[] {
  const wireIndex = typeof entry.index === 'number' ? entry.index : 0
  const fn = isRecord(entry.function) ? entry.function : undefined
  const out: StreamChunk[] = []

  let call = state.toolCalls.get(wireIndex)
  if (call === undefined) {
    const opened = openToolCall(state, entry, wireIndex)
    out.push(...opened.chunks)
    call = opened.call
  } else {
    if (call.id === `call_${wireIndex}`) {
      const id = asString(entry.id)
      if (id !== undefined) call.id = id
    }
    const name = asString(fn?.name)
    if (name !== undefined && name !== '') call.name = name
  }

  // Argument fragments are concatenated verbatim and parsed only once the call
  // is complete: fragment boundaries, escapes and key order are the model's own
  // output, and a parse/re-serialize round trip would rewrite all three.
  const argsDelta = asString(fn?.arguments) ?? ''
  if (argsDelta !== '') call.arguments += argsDelta

  // The turn is a tool use as soon as the call starts, not only once an argument
  // arrives: a no-argument tool would otherwise leave `hasToolCall` false and
  // settle as a plain stop, so the runner never executes it. The name and id
  // also have to reach the caller on the opening delta.
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
      ...(call.name === '' ? {} : { name: call.name }),
      argumentsDelta: argsDelta,
    })
  }
  return out
}

/**
 * Feed one SSE line from `{base}/v1/chat/completions`.
 *
 * Heartbeats and comment frames (": ping") carry no `data:` prefix and produce
 * nothing here. The caller pulses its idle watchdog on bytes and on complete
 * frames, so a keep-alive neither becomes content nor stalls the stream: an empty
 * payload and a frame with no choices both fall through to an empty chunk list,
 * which is a no-op rather than an end-of-stream.
 */
export function processStreamLine(line: string, state: StepCodeStreamState): StreamChunk[] {
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

  // A failure can arrive as an SSE frame rather than an HTTP status; without
  // this the severed reply would be flushed as a clean stop.
  const errorPayload = isRecord(chunk.error) ? chunk.error : undefined
  if (errorPayload !== undefined) {
    throw new LlmError(
      `${PROVIDER_NAME} stream error: ${asString(errorPayload.message) ?? 'unknown error'}`,
      isContextOverflow(errorPayload) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  // Usage is booked before any delta is read: the endpoint puts it on the last
  // frame, and that frame may also carry the finish reason.
  const usage = parseStepCodeUsage(chunk.usage)
  if (usage !== undefined) {
    state.sawUsage = true
    state.inputTokens = usage.inputTokens
    state.cacheReadTokens = usage.cacheReadTokens
    state.cacheWriteTokens = usage.cacheWriteTokens
    state.outputTokens = usage.outputTokens
    state.reasoningTokens = usage.reasoningTokens
  }

  const choices: unknown[] = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined

  if (delta !== undefined) {
    // Two wire names carry the same thing: Step answers `reasoning_content`, and
    // gateways in front of it have shipped `reasoning` (the newer vLLM spelling).
    // Both must be read, or a thinking model silently answers with no reasoning
    // block at all.
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') {
      out.push(...appendTextDelta(state, 'reasoning', sanitizeText(reasoning)))
    }

    const content = asString(delta.content)
    if (content !== undefined && content !== '') {
      out.push(...appendTextDelta(state, 'text', sanitizeText(content)))
    }

    const toolDeltas: unknown[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of toolDeltas) {
      if (!isRecord(entry)) continue
      out.push(...applyToolDelta(entry, state))
    }
  }

  const finish = choice === undefined ? undefined : asString(choice.finish_reason)
  if (finish !== undefined && finish !== '') {
    state.finishReason = finish
    // Blocks close here; usage and finish are emitted once, by closeStream, so
    // usage always precedes finish.
    out.push(...closeCurrent(state))
    out.push(...closeToolCalls(state))
  }

  return out
}

/** The DSH accounting for one response, with cache fields omitted when zero. */
export function streamTokenUsage(state: StepCodeStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: StepCodeStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Flush every open block, then emit usage and the terminal finish.
 *
 * Order is a hard requirement: DSH settles a call on `finish`, so usage that
 * arrives after it is never booked.
 */
export function closeStream(state: StepCodeStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: streamTokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/**
 * A stream that ends without a terminal event is truncated, not complete.
 *
 * Chat Completions always terminates with `finish_reason` or `[DONE]`, so their
 * absence means the connection dropped mid-answer and the partial text must not
 * be presented as a finished reply.
 */
export function assertStreamComplete(state: StepCodeStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError(`${PROVIDER_NAME} stream ended before its terminal event`, 'PROVIDER_ERROR')
  }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** How much of a failing body is quoted back in a message. */
const MAX_FAILURE_DETAIL_LENGTH = 600

/**
 * Classify one non-2xx response into a DSH failure.
 *
 * The codes are the harness's shared vocabulary rather than this line's own, so
 * the account pool recognises `AUTH` ("this account must sign in again") and no
 * retry set picks up an exhausted-plan verdict. Context overflow is reclassified
 * through `isHttpContextOverflow` so the harness can compact and retry instead
 * of showing the user a raw window error.
 */
export function classifyStepCodeFailure(status: number, detail: string): LlmError {
  const trimmed = detail.trim().slice(0, MAX_FAILURE_DETAIL_LENGTH)
  const suffix = trimmed === '' ? '' : `: ${trimmed}`

  if (status === 401 || status === 403) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the credential (${status}). Sign the account in again.${suffix}`,
      'AUTH',
      { status },
    )
  }
  if (status === 429) {
    return new LlmError(`${PROVIDER_NAME} rate limit or plan limit (${status}).${suffix}`, 'RATE_LIMIT', { status })
  }
  if (isHttpContextOverflow(status, detail)) {
    return new LlmError(
      `${PROVIDER_NAME} says the conversation no longer fits the model window.${suffix}`,
      CONTEXT_OVERFLOW_CODE,
      { status },
    )
  }
  if (status === 404) {
    return new LlmError(
      `${PROVIDER_NAME} does not know this model or route (${status}).${suffix}`,
      'NOT_FOUND',
      { status },
    )
  }
  if (status >= 500) {
    return new LlmError(`${PROVIDER_NAME} upstream error (${status}).${suffix}`, 'SERVER', { status })
  }
  return new LlmError(`${PROVIDER_NAME} request failed (${status}).${suffix}`, 'PROVIDER_ERROR', { status })
}
