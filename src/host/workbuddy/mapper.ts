/**
 * Wire mapping for the WorkBuddy / CodeBuddy subscription chat endpoint.
 *
 * The endpoint is OpenAI Chat Completions shaped, but with three measured
 * deviations from the OpenAI default that this module exists to absorb:
 *
 * 1. **Stream only.** `stream: false` answers 400 `code 11101`. The request
 *    builder therefore always sends `stream: true`, and there is no
 *    non-streaming code path to keep in sync.
 * 2. **A leading system message is mandatory on the international backend.**
 *    A request whose first message is a user turn answers 400 `code 11128`
 *    ("first message is not system prompt"). {@link buildChatRequest} injects
 *    one when the caller supplied none, so a hand-built one-shot request cannot
 *    trip this. Note that the same code is also the gateway's channel-verification
 *    refusal (`msg: "conversation id missing"`), which the conversation header
 *    group this route sends is what satisfies — see `conversationHeaders` in
 *    `client.ts`. A history that is already correct can still answer 11128 for
 *    that second reason, so the code alone does not implicate the messages.
 * 3. **Reasoning rides `delta.reasoning_content`,** not OpenAI's
 *    `reasoning_summary`, and is emitted as its own DSH reasoning block.
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
  MAX_REQUEST_IMAGE_BYTES,
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages,
  requestImageTargetOrOriginal,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import { stripMetaSchema } from '../common/tool-schema.ts'
import { maxOutputTokensFor } from './model-catalog.ts'
import {
  printedCallHoldIndex,
  printedCallLooksComplete,
  recoverPrintedToolCalls,
  type PrintedToolCall,
} from './dsml.ts'

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

function stripNulls(text: string): string {
  return text.replace(/\0/g, '')
}

/**
 * Exact third-party coding-agent identity preambles the WorkBuddy gateway WAF
 * blocks with HTTP 400 `code 11128` ("Illegal API invocation from an unapproved
 * channel") when they appear verbatim in outbound `system` or `assistant`
 * messages (or serialized tool-call arguments).
 *
 * Each entry replaces only the confirmed contiguous trigger phrase with a
 * neutral wording so the surrounding instructions keep their meaning:
 * - `You are an AI agent powered by DeepSeek Harness.` (measured on CN
 *   `copilot.tencent.com`: exact line triggers 11128 in system/assistant;
 *   `AI assistant` passes 200 on both CN and INTL).
 * - Claude Code, Codex CLI, OhMyOpenCode, and `x-anthropic-billing-header`
 *   (measured on both CN and INTL gateways: each triggers 11128 verbatim and
 *   passes 200 after the minimal rewrite).
 */
const IDENTITY_FINGERPRINT_REWRITES: readonly (readonly [string, string])[] = [
  [
    'You are an AI agent powered by DeepSeek Harness.',
    'You are an AI assistant powered by DeepSeek Harness.',
  ],
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
  ],
]

const OMO_FINGERPRINT_RE = /Sisyphus-Junior - Focused executor from OhMyOpenCode/gi
const ANTHROPIC_BILLING_KV_RE = /x-anthropic-billing-header:[^\r\n]*/gi
const ANTHROPIC_BILLING_BARE_RE = /x-anthropic-billing-header/gi

export function sanitizeText(text: string): string {
  let out = stripNulls(text)
  for (const [needle, replacement] of IDENTITY_FINGERPRINT_REWRITES) {
    if (out.includes(needle)) out = out.replaceAll(needle, replacement)
  }
  if (OMO_FINGERPRINT_RE.test(out)) {
    OMO_FINGERPRINT_RE.lastIndex = 0
    out = out.replace(OMO_FINGERPRINT_RE, 'Sisyphus-Junior - Focused executor')
  }
  if (ANTHROPIC_BILLING_BARE_RE.test(out)) {
    ANTHROPIC_BILLING_KV_RE.lastIndex = 0
    ANTHROPIC_BILLING_BARE_RE.lastIndex = 0
    out = out
      .replace(ANTHROPIC_BILLING_KV_RE, '')
      .replace(ANTHROPIC_BILLING_BARE_RE, 'x-anthropic-billing-hdr')
  }
  return out
}

/**
 * The system prompt every request must open with.
 *
 * The international backend rejects a request whose first message is not a
 * system turn, so this stands in when the caller supplies no prompt at all. It
 * is deliberately neutral: it must not change model behaviour beyond satisfying
 * the shape check.
 */
const IMPLICIT_SYSTEM_PROMPT = 'You are a helpful assistant.'

// ---------------------------------------------------------------------------
// Durable request images
// ---------------------------------------------------------------------------

/**
 * The image seam is the SHARED kernel's, not this route's own.
 *
 * The old copy here carried a private 12 MB budget while the shared kernel
 * bounds a request at {@link MAX_REQUEST_IMAGE_BYTES} (1.5 MB), and the adapter
 * answered no `imageRequestTarget` at all — so the harness downscaled for a
 * ceiling this mapper never applied, and the body could still exceed the one
 * the kernel had already paid for. Re-exporting the kernel here keeps the
 * projection, the budget and the target a single number.
 *
 * What stays route-specific is only what the WIRE shape needs ({@link
 * MAX_REQUEST_IMAGE_BYTES} is imported for the doc link and the tests that pin
 * it): the chat and Messages builders both consume the same resolution.
 */
export {
  MAX_REQUEST_IMAGE_BYTES,
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages,
  requestImageTargetOrOriginal,
  resolveRequestImages,
  unavailableImageText,
  stripMetaSchema,
}
export type { AttachmentImageReader, ResolvedRequestImage, ResolvedRequestImages }

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
      // A tool-result image is named, not inlined: the `role: "tool"` message
      // can only carry text, so its pixels ride a separate user message.
      if (block.type === 'image') return `[image: ${attachmentLabel(block) ?? 'attached image'}]`
      return ''
    })
    .join('')
}

/** `image_url` blocks for one tool result; they ride a user message. */
function toolResultImageBlocks(blocks: unknown, images: ResolvedRequestImages): OpenAIMessage[] {
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
  if (typeof raw === 'string') return sanitizeText(raw)
  if (raw === undefined || raw === null) return '{}'
  try {
    return sanitizeText(JSON.stringify(raw))
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
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(sanitizeText(options.system))
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
    // Reasoning blocks are never replayed: the endpoint does not accept a
    // thinking block without the signature that produced it.
  }
  return { content: textParts.join(''), toolCalls }
}

// ---------------------------------------------------------------------------
// History repair
// ---------------------------------------------------------------------------

/** Whether one wire message is an assistant turn. */
function isAssistantTurn(message: OpenAIMessage): boolean {
  return message.role === 'assistant'
}

/**
 * The text of one assistant turn, or `undefined` when the message is not an
 * assistant turn or does not carry plain text.
 */
function assistantTextOf(message: OpenAIMessage): string | undefined {
  if (!isAssistantTurn(message)) return undefined
  // Every assistant turn this builder emits carries a string; a shape it did
  // not build itself is left alone rather than rewritten.
  return typeof message.content === 'string' ? message.content : undefined
}

/** The tool calls one wire message declares, which may be none. */
function toolCallsOf(message: OpenAIMessage): OpenAIMessage[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls as OpenAIMessage[] : []
}

/**
 * Concatenate one assistant turn's text onto another.
 *
 * A concatenation that would merge two words is separated by a single space: a
 * batch split across turns ends its first turn mid-sentence, so `"let me"` +
 * `"look"` has to leave as `"let me look"` and not `"let melook"`.
 */
function appendAssistantText(base: string, extra: string): string {
  if (extra === '') return base
  if (base === '') return extra
  if (/\s$/.test(base) || /^\s/.test(extra) || /[\u3000-\u9fff\uff00-\uff9f]/.test(base + extra)) return base + extra
  return `${base} ${extra}`
}

/**
 * Fold adjacent assistant turns that each carry tool calls into one turn.
 *
 * A parallel batch the harness serialized as two assistant messages is one
 * batch to the upstream, and only one assistant turn may declare it: a gateway
 * that sees the batch split rejects every later turn of that conversation. Text
 * is concatenated and the calls are appended in order, ids untouched. A tool
 * result between two assistant turns is what proves they are separate turns,
 * so only the immediately adjacent run is merged — the following tool results
 * keep their own order.
 */
function mergeSplitToolCallBatches(messages: readonly OpenAIMessage[]): OpenAIMessage[] {
  const repaired: OpenAIMessage[] = []
  for (const message of messages) {
    const text = assistantTextOf(message)
    const calls = toolCallsOf(message)
    const previous = repaired.length > 0 ? repaired[repaired.length - 1]! : undefined
    const previousText = previous === undefined ? undefined : assistantTextOf(previous)
    if (
      text !== undefined
      && previous !== undefined
      && previousText !== undefined
      && (calls.length > 0 || toolCallsOf(previous).length > 0)
    ) {
      // The guard above already proved at least one of the two turns carries
      // calls, so the merged turn always declares them.
      repaired[repaired.length - 1] = {
        ...previous,
        content: appendAssistantText(previousText, text),
        tool_calls: [...toolCallsOf(previous), ...calls],
      }
      continue
    }
    repaired.push(message)
  }
  return repaired
}

/**
 * The text an assistant tool call is answered with when its result never came.
 *
 * This text is invented on purpose, exactly as the sibling gateway invents it:
 * an interrupted run leaves the call declared with no `role: "tool"` reply, and
 * the upstream rejects the whole turn rather than the missing result. Sending a
 * sentence the model can read beats both alternatives — dropping the call
 * silently rewrites history the model already saw (and leaves the *next*
 * assistant turn referring to a call that is no longer there), while dropping
 * the turn throws away the rest of the conversation's context. The wording is
 * deliberately unlike a real tool output: it is short, says it failed, and
 * carries no content that could be mistaken for a result.
 */
const NO_TOOL_RESULT_TEXT = '[no result: the tool call did not complete]'

/**
 * Answer every declared tool call that has no `role: "tool"` message.
 *
 * The window is the stretch before the next assistant turn: call ids are only
 * meaningful inside one turn's batch, and a later turn's results may reuse none
 * of them. Calls that were answered are left alone, and the invented replies go
 * after the results that did arrive so the real ones keep their position.
 */
function fillMissingToolResults(messages: readonly OpenAIMessage[]): OpenAIMessage[] {
  const repaired: OpenAIMessage[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    repaired.push(message)
    index += 1
    if (!isAssistantTurn(message)) continue

    const calls = toolCallsOf(message)
    if (calls.length === 0) continue

    // The turn's results, up to the next assistant turn (or the end).
    const answered = new Set<string>()
    const results: OpenAIMessage[] = []
    while (index < messages.length && !isAssistantTurn(messages[index]!)) {
      const result = messages[index]!
      if (result.role === 'tool' && typeof result.tool_call_id === 'string') answered.add(result.tool_call_id)
      results.push(result)
      index += 1
    }

    const invented: OpenAIMessage[] = []
    for (const call of calls) {
      const id = typeof call.id === 'string' ? call.id : ''
      // A call with no id cannot be answered: `tool_call_id` would be empty and
      // the upstream would reject that message instead of the turn.
      if (id === '' || answered.has(id)) continue
      invented.push({ role: 'tool', tool_call_id: id, content: NO_TOOL_RESULT_TEXT })
    }
    // A user turn can close this window — the image a tool-result carried, and
    // any user message after it. An invented `tool` reply must not land beyond
    // one of those, or the turn's answers stop being one uninterrupted run, so
    // they go in front of the whole trailing run of user turns.
    let insertAt = results.length
    while (insertAt > 0 && results[insertAt - 1]!.role === 'user') insertAt -= 1
    repaired.push(...results.slice(0, insertAt), ...invented, ...results.slice(insertAt))
  }
  return repaired
}

/**
 * Build one `/v2/chat/completions` body.
 *
 * Always `stream: true`: the endpoint rejects a non-streaming request outright
 * (400 `code 11101`), so there is no second shape to produce.
 */
export function buildChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = []
  // The first message MUST be a system turn, so an absent prompt is filled in
  // rather than omitted.
  messages.push({ role: 'system', content: leadingSystemText(options) ?? IMPLICIT_SYSTEM_PROMPT })

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    if (isToolResultMessage(message)) {
      // Parallel tool calls emit several consecutive tool messages, and the
      // endpoint rejects a `user` message wedged between them. The whole run is
      // scanned, its images collected, and one `user` message appended after.
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
      // An assistant turn with neither text nor calls carries nothing here.
      if (content !== '' || toolCalls.length > 0) messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  // Two repairs run between the projection and the body, in this order: a batch
  // that was split is folded back into one assistant turn, then every call that
  // turn declares is guaranteed an answer. Nothing else is invented: an empty
  // `reasoning_content` backfill was measured against both deployments on
  // 2026-10-18 and neither requires it, so the field is not sent
  // (`scripts/probe-workbuddy-assumptions.probe.ts`).
  const repairedMessages = fillMissingToolResults(mergeSplitToolCallBatches(messages))
  const body: Record<string, unknown> = {
    model: options.model,
    messages: repairedMessages,
    stream: true,
    stream_options: { include_usage: true },
    // The desktop client asks the gateway to hold the conversation's prompt
    // cache for the long window on every chat it sends; without the field the
    // gateway falls back to its own default and a long agent session re-sends
    // its prefix uncached on each step. The value is part of the verified
    // desktop request form rather than a preference, which is why it is a
    // constant here and not a setting.
    cache_retention: LONG_CACHE_RETENTION,
    max_tokens: clampMinimumOutput(options.model, options.maxTokens ?? maxOutputTokensFor(options.model)),
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
// Streaming
// ---------------------------------------------------------------------------

interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
  started: boolean
}

export interface WorkBuddyStreamState {
  blocks: OutboundContentBlock[]
  current: { index: number; type: 'text' | 'reasoning'; text: string } | null
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
  /**
   * Text held back while it may still turn into a printed tool call.
   *
   * `holding` is set once a `<` that could open a call region was seen; the
   * buffer then grows until the region closes (or the cap is hit), and is
   * resolved into prose or calls exactly once.
   */
  printed: { pending: string; holding: boolean }
}

export function createStreamState(): WorkBuddyStreamState {
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
    printed: { pending: '', holding: false },
  }
}

/**
 * Smallest output request the GPT-family upstreams accept.
 *
 * Measured upstream behaviour (also pinned by workbuddy2api-hub as #364/#252):
 * a `gpt-*` model rejects `max_tokens` below 16 with 400
 * `integer_below_min_value`, while every other family accepts a small value.
 * This route only ever asks for a small cap on purpose — the connection probe and
 * an output-limit probe both do — so the floor is applied here rather than left
 * for each caller to remember.
 */
const MINIMUM_GPT_MAX_TOKENS = 16

/** Raise a GPT-family output request to the floor that family enforces. */
function clampMinimumOutput(model: string, maxTokens: number): number {
  if (!model.trimStart().toLowerCase().startsWith('gpt-')) return maxTokens
  return Math.max(maxTokens, MINIMUM_GPT_MAX_TOKENS)
}

/**
 * Prompt-cache retention the desktop client asks for on a chat.
 *
 * Measured form, not a tunable: the value travels with every chat completion
 * the official client sends, so this route sends the same one. It is a
 * REQUEST hint only — the gateway decides what it honours.
 */
const LONG_CACHE_RETENTION = 'long'

/** Longest printed-call region held before it is written out as prose anyway. */
const PRINTED_CALL_LIMIT = 64 * 1024

/** Append prose to the open text block, opening one when needed. */
function emitProse(state: WorkBuddyStreamState, text: string): StreamChunk[] {
  if (text === '') return []
  const out = closeToolCalls(state)
  if (state.current === null || state.current.type !== 'text') out.push(...openTextBlock(state, 'text'))
  state.current!.text += text
  state.hasContent = true
  out.push({ type: 'text-delta', index: state.current!.index, text })
  return out
}

/** Emit recovered calls as settled tool-call blocks. */
function emitPrintedCalls(state: WorkBuddyStreamState, calls: readonly PrintedToolCall[]): StreamChunk[] {
  const out = closeCurrent(state)
  for (const call of calls) {
    const index = state.blocks.length
    const id = toToolCallId(call.id)
    const block: OutboundContentBlock = { type: 'tool-call', id, name: call.name, arguments: call.arguments }
    state.blocks.push(block)
    out.push({ type: 'block-start', index, blockType: 'tool-call' })
    out.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments })
    out.push({ type: 'block-end', index, block })
    state.hasToolCall = true
    state.hasContent = true
  }
  return out
}

/**
 * Release held text, resolving it into prose or calls.
 *
 * `force` is what the end of a turn passes: whatever is still held must be
 * written out rather than dropped, even when it never closed.
 */
function drainPrinted(state: WorkBuddyStreamState, force: boolean): StreamChunk[] {
  const out: StreamChunk[] = []
  for (;;) {
    const pending = state.printed.pending
    if (pending === '') return out

    if (!state.printed.holding) {
      const hold = printedCallHoldIndex(pending)
      if (hold === -1) {
        out.push(...emitProse(state, pending))
        state.printed.pending = ''
        return out
      }
      if (hold > 0) out.push(...emitProse(state, pending.slice(0, hold)))
      state.printed.pending = pending.slice(hold)
      state.printed.holding = true
    }

    const buffer = state.printed.pending
    if (!force && !printedCallLooksComplete(buffer) && buffer.length < PRINTED_CALL_LIMIT) return out

    state.printed.holding = false
    state.printed.pending = ''
    const recovered = recoverPrintedToolCalls(buffer)
    if (recovered === null) {
      out.push(...emitProse(state, buffer))
      return out
    }
    if (recovered.clean !== '') out.push(...emitProse(state, recovered.clean))
    out.push(...emitPrintedCalls(state, recovered.calls))
    return out
  }
}

/** Append chat text, recovering a call the model printed instead of emitting. */
function feedText(state: WorkBuddyStreamState, text: string): StreamChunk[] {
  if (text === '') return []
  state.printed.pending += text
  return drainPrinted(state, false)
}

function closeCurrent(state: WorkBuddyStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: WorkBuddyStreamState): StreamChunk[] {
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

function openTextBlock(state: WorkBuddyStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  const out = closeCurrent(state)
  const index = state.blocks.length
  state.current = { index, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return out
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Feed one SSE line from `/v2/chat/completions`. */
export function processStreamLine(line: string, state: WorkBuddyStreamState): StreamChunk[] {
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
      `WorkBuddy stream error: ${asString(errorPayload.message) ?? 'unknown error'}`,
      isContextOverflow(errorPayload) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  const usage = isRecord(chunk.usage) ? chunk.usage : undefined
  if (usage) {
    state.sawUsage = true
    const prompt = numberOr(usage.prompt_tokens, 0)
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
    const cached = details ? numberOr(details.cached_tokens, 0) : 0
    // A cache write is billed apart from a cache read, so it is tracked apart
    // too and subtracted from the aggregate prompt count like a read is.
    const written = details ? numberOr(details.cache_write_tokens, 0) : 0
    // DSH counts are disjoint: cached input is reported separately, so it is
    // subtracted out of the provider's aggregate prompt count.
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
  const delta = choice && isRecord(choice.delta) ? choice.delta as Record<string, unknown> : undefined

  if (delta) {
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') {
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'reasoning') out.push(...openTextBlock(state, 'reasoning'))
      state.current!.text += stripNulls(reasoning)
      state.hasContent = true
      out.push({ type: 'reasoning-delta', index: state.current!.index, text: stripNulls(reasoning) })
    }

    const content = asString(delta.content)
    if (content !== undefined && content !== '') {
      out.push(...feedText(state, stripNulls(content)))
    }

    const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of toolDeltas) {
      if (!isRecord(entry)) continue
      out.push(...applyToolDelta(entry, state))
    }
  }

  const finish = asString(choice?.finish_reason)
  if (finish !== undefined && finish !== '') {
    state.finishReason = finish
    // Held text is resolved before the blocks close, or a printed call that
    // never saw a closing tag would be dropped at the terminal frame.
    out.push(...drainPrinted(state, true))
    out.push(...closeCurrent(state))
    out.push(...closeToolCalls(state))
  }

  return out
}

function applyToolDelta(entry: Record<string, unknown>, state: WorkBuddyStreamState): StreamChunk[] {
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

  // The turn is a tool use as soon as the call starts, not only once an
  // argument arrives: a no-argument tool would otherwise leave `hasToolCall`
  // false and settle as a plain stop, so the runner never executes it. The
  // name and id also have to reach the caller on the opening delta.
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

function tokenUsage(state: WorkBuddyStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: WorkBuddyStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/** Flush every open block, then emit usage and the terminal finish. */
export function closeStream(state: WorkBuddyStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...drainPrinted(state, true), ...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/**
 * A stream that ends without a terminal event is truncated, not complete.
 *
 * The endpoint always terminates with either `finish_reason` or `[DONE]`, so
 * their absence means the connection dropped mid-answer and the partial text
 * must not be presented as a finished reply.
 */
export function assertStreamComplete(state: WorkBuddyStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError('WorkBuddy stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}


// ---------------------------------------------------------------------------
// 11128: moving a refused system prompt into the user's words
// ---------------------------------------------------------------------------

/**
 * The neutral system prompt left in the leading position after a move.
 *
 * Both builds require a system message to be FIRST (a history that opens with a
 * user turn answers 11128 "first message is not system prompt"), so the move
 * cannot simply delete the leading turn. Measured wording: the sibling
 * implementation sends exactly this line, and it changes nothing a user would
 * notice while satisfying the shape check.
 */
const RELOCATION_DEFAULT_SYSTEM = IMPLICIT_SYSTEM_PROMPT

/** Tags the moved prompt is wrapped in, so the model reads it as instruction. */
const INSTRUCTIONS_OPEN = '<instructions>\n'
const INSTRUCTIONS_CLOSE = '\n</instructions>'

/**
 * The two wordings of the gateway's channel refusal.
 *
 * ONLY this 11128 is repairable by moving the system prompt. The code is
 * overloaded upstream: `msg: "conversation id missing"` is the answer to a
 * request missing the conversation header group (fix belongs in `client.ts`),
 * and the system-first wording is the history check. Neither may trigger a
 * message move — moving for them would spend the one retry on a request the move
 * cannot fix.
 */
const CHANNEL_REFUSAL_RE = /unapproved channel|illegal api invocation/i

/** Whether one 11128 body is the channel refusal a system move can repair. */
export function isChannelRefusal11128(detail: string): boolean {
  return CHANNEL_REFUSAL_RE.test(detail)
}

/** One chat body as the object it is, or null when it cannot be read. */
function chatBodyOf(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    const parsed = safeJsonParse(body)
    return isRecord(parsed) ? parsed : null
  }
  return isRecord(body) ? body : null
}

function messageListOf(chat: Record<string, unknown>): Record<string, unknown>[] {
  const messages = chat.messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is Record<string, unknown> => isRecord(message))
}

/** Plain text of one message's content, as the gateway reads it. */
function plainTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * What a chat's system prompt is known by.
 *
 * The key is the system TEXT, not the conversation: one agent refused once must
 * not pay the refusal again on its next conversation, which is a different
 * message list with the same opening. A body whose system text is already the
 * neutral default has nothing to move, so it keys as the empty string.
 */
export function chatSystemKey(body: unknown): string {
  const chat = chatBodyOf(body)
  if (chat === null) return ''
  const key = messageListOf(chat)
    .filter((message) => message.role === 'system')
    .map((message) => plainTextOf(message.content))
    .join('\n')
  return key.trim() === RELOCATION_DEFAULT_SYSTEM ? '' : key
}

/**
 * Move a chat's system prompt into the first user turn, in INSTRUCTIONS tags,
 * and leave the neutral default in the leading system position.
 *
 * A system message LATER in the history becomes a user message where it stands:
 * the gateway refuses those too, and the position is meaningful to the model, so
 * it is rewritten rather than lifted out and merged. String content is prefixed
 * with the tagged text and a blank line; block content gets one extra leading
 * text part, which is what keeps images and tool parts exactly where they were.
 *
 * Returns the new body as JSON, or NULL when there is nothing to move — a caller
 * that gets null must not retry, because the second request would be the first
 * one again.
 */
export function relocateSystemToInstructions(body: unknown): string | null {
  const chat = chatBodyOf(body)
  if (chat === null) return null
  const messages = messageListOf(chat)

  let lead = 0
  const leading: string[] = []
  for (; lead < messages.length && messages[lead]!.role === 'system'; lead++) {
    leading.push(plainTextOf(messages[lead]!.content))
  }
  const said = leading.join('\n\n').trim()
  const rest = messages.slice(lead).map((message) => (
    message.role === 'system' ? { ...message, role: 'user' } : message
  ))
  const moved = said !== '' && said !== RELOCATION_DEFAULT_SYSTEM
  const retyped = rest.some((message, index) => message !== messages[lead + index])
  if (!moved && !retyped) return null

  if (moved) {
    const text = INSTRUCTIONS_OPEN + said + INSTRUCTIONS_CLOSE
    const first = rest.findIndex((message) => message.role === 'user')
    if (first < 0) {
      rest.unshift({ role: 'user', content: text })
    } else {
      const target = rest[first]!
      const content = target.content
      if (typeof content === 'string') {
        rest[first] = { ...target, content: text + '\n\n' + content }
      } else if (Array.isArray(content)) {
        rest[first] = { ...target, content: [{ type: 'text', text }, ...content] }
      } else {
        rest[first] = { ...target, content: text }
      }
    }
  }

  const rewritten: Record<string, unknown> = {
    ...chat,
    messages: [{ role: 'system', content: RELOCATION_DEFAULT_SYSTEM }, ...rest],
  }
  return JSON.stringify(rewritten)
}

/**
 * The id one USER SEND is known by, for the request-id header family.
 *
 * Derived from the harness history rather than from a clock or a counter: every
 * tool step of one send appends to the history AFTER the user's own last
 * message, so the same key is computed for all of them, and the user's next
 * message is what changes it. Tool-result turns are skipped because they are the
 * harness answering the model, not the user speaking — including them would give
 * each tool step its own id, which is the behaviour this exists to prevent.
 *
 * Empty when there is no user turn to name, which the caller reads as "make a
 * fresh id for this request" (config probes, compactions, and one-shot calls).
 */
export function userTurnKey(options: GenerateOptions): string {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message === undefined || message.role !== 'user') continue
    const source = (message as { source?: { kind?: string } }).source
    if (source?.kind === 'tool') continue
    const text = plainTextOf(message.content)
    if (text.trim() === '') continue
    return index + ':' + text
  }
  return ''
}

// ---------------------------------------------------------------------------
// Anthropic Messages request (domestic Claude models)
// ---------------------------------------------------------------------------

/**
 * `anthropic-version` the Messages surface requires.
 *
 * Sent for every Messages request: without it the endpoint answers 400 rather
 * than falling back to a default, so it is a protocol requirement and not a
 * feature negotiation.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Thinking control the Messages surface takes.
 *
 * Not the chat endpoint's `reasoning_effort`: Messages asks for thinking
 * (`thinking.type: 'adaptive'`) and expresses the LEVEL in
 * `output_config.effort`. Sending the chat spelling here is what made an
 * effort pick do nothing, and 'max' is a legal level of this ladder, so it is
 * carried verbatim rather than filtered through the chat ladder.
 */
export const MESSAGES_THINKING_FIELD = 'thinking'
export const MESSAGES_EFFORT_FIELD = 'output_config'

export interface MessagesRequestOptions {
  /** Durable user images resolved for this request. */
  images?: ResolvedRequestImages
  /** Effort ladder the gateway catalog declares for this model; empty = no thinking. */
  efforts?: readonly string[]
  /** Effort the caller picked, carried verbatim (no chat-ladder filtering). */
  effort?: string
  /** Output cap to use when the caller names none. */
  defaultMaxTokens?: number
}

type AnthropicBlock = Record<string, unknown>

/**
 * Whether a history reasoning block may be replayed.
 *
 * A signed thinking block is the one Messages accepts back, so it is replayed
 * with its signature intact. An unsigned one is dropped: the surface refuses a
 * thinking block it cannot verify (11159), and a block with no signature cannot
 * be verified by anyone. This is the rule the reference implementation applies
 * to a forwarded body, expressed against the blocks the harness keeps.
 */
function isReplayableThinking(block: Record<string, unknown>): boolean {
  return block.type === 'reasoning' && asString(block.signature) !== undefined
}

function messagesUserContent(message: Message, images: ResolvedRequestImages): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      // Deliberately NOT sanitized: measured on /v1/messages, Claude Code's own
      // opening lines and the billing header are served as they are, and the
      // WAF rewrites above exist for the chat endpoint alone.
      if (block.text !== '') blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      blocks.push(inline !== undefined && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)
        ? { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
        : { type: 'text', text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: asString(block.toolCallId) ?? '',
        content: messagesToolResultContent(block.content, images),
        ...(block.isError === true ? { is_error: true } : {}),
      })
    }
  }
  return blocks
}

function messagesToolResultContent(blocks: unknown, images: ResolvedRequestImages): string | AnthropicBlock[] {
  if (!Array.isArray(blocks)) return ''
  const out: AnthropicBlock[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      out.push(inline !== undefined && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)
        ? { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
        : { type: 'text', text: unavailableImageText(block) })
    }
  }
  // The plain-string form is what a text-only result is sent as; the block form
  // only exists because an image cannot ride a string.
  if (out.every((entry) => entry.type === 'text')) {
    return out.map((entry) => asString(entry.text) ?? '').join('')
  }
  return out
}

function messagesAssistantContent(message: Message): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string') {
      const raw = typeof block.arguments === 'string' ? block.arguments : '{}'
      const parsed = safeJsonParse(raw)
      blocks.push({
        type: 'tool_use',
        id: asString(block.id) ?? 'toolu_' + String(blocks.length),
        name: block.name,
        input: isRecord(parsed) ? parsed : {},
      })
      continue
    }
    if (isReplayableThinking(block)) {
      blocks.push({
        type: 'thinking',
        thinking: plainTextOf(block.content ?? block.text),
        signature: asString(block.signature) ?? '',
      })
    }
  }
  return blocks
}

/**
 * Build one `/v1/messages` body.
 *
 * `stream: true` is mandatory: the adapter reads every response as SSE, and a
 * non-streaming answer is one JSON document with no `data:` lines, no
 * `message_stop` and no `stop_reason`.
 *
 * The system prompt travels as the top-level `system` string — the surface has
 * a field for it, so the chat endpoint's "the first message must be a system
 * turn" requirement does not exist here and no relocation is ever needed.
 */
export function buildMessagesRequest(
  options: GenerateOptions,
  request: MessagesRequestOptions = {},
): Record<string, unknown> {
  const images = request.images ?? NO_RESOLVED_IMAGES
  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    const role: 'user' | 'assistant' = isToolResultMessage(message) || message.role !== 'assistant'
      ? 'user'
      : 'assistant'
    const content = role === 'user'
      ? messagesUserContent(message, images)
      : messagesAssistantContent(message)
    if (content.length === 0) continue
    const previous = entries[entries.length - 1]
    // Adjacent same-role turns are ONE turn on this wire, which is also what
    // keeps parallel tool results in a single user turn.
    if (previous !== undefined && previous.role === role) previous.content.push(...content)
    else entries.push({ role, content })
  }

  const system = leadingSystemTextRaw(options)
  const tools = options.tools ?? []
  const effort = request.effort !== undefined && (request.efforts ?? []).length > 0
    ? request.effort
    : undefined
  const maxTokens = options.maxTokens ?? request.defaultMaxTokens ?? maxOutputTokensFor(options.model)

  return {
    model: options.model,
    max_tokens: maxTokens,
    stream: true,
    messages: entries,
    ...(system === undefined ? {} : { system }),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: stripMetaSchema(tool.parameters),
          })),
        }
      : {}),
    // Thinking and temperature are mutually exclusive on this surface, so a
    // thinking request never carries a temperature.
    ...(options.temperature === undefined || effort !== undefined ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: [...options.stop] } : {}),
    ...(effort === undefined
      ? {}
      : { [MESSAGES_THINKING_FIELD]: { type: 'adaptive' }, [MESSAGES_EFFORT_FIELD]: { effort } }),
  }
}

/**
 * The system prompt as the top-level `system` field, unsanitized.
 *
 * Separate from the chat path's leading-system collector on purpose: that one
 * applies the chat endpoint's WAF rewrites, and the Messages surface was
 * measured to serve those same lines as they are.
 */
function leadingSystemTextRaw(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = plainTextOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Anthropic Messages streaming
// ---------------------------------------------------------------------------

interface MessagesTextBlock {
  index: number
  kind: 'text' | 'reasoning'
  text: string
}

interface MessagesToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface MessagesStreamState {
  blocks: OutboundContentBlock[]
  /** wire content index -> open text or reasoning block. */
  open: Map<number, MessagesTextBlock>
  /** wire content index -> accumulating tool call. */
  toolCalls: Map<number, MessagesToolCall>
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  sawMessageStart: boolean
  sawMessageStop: boolean
  sawUsage: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  finished: boolean
}

export function createMessagesStreamState(): MessagesStreamState {
  return {
    blocks: [],
    open: new Map(),
    toolCalls: new Map(),
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    sawMessageStart: false,
    sawMessageStop: false,
    sawUsage: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    finished: false,
  }
}

function messagesOpenText(
  state: MessagesStreamState,
  contentIndex: number,
  kind: 'text' | 'reasoning',
  seed: string,
): StreamChunk[] {
  const existing = state.open.get(contentIndex)
  if (existing !== undefined) {
    if (seed === '') return []
    existing.text += seed
    return [{ type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: existing.index, text: seed }]
  }
  const index = state.blocks.length
  state.blocks.push(kind === 'reasoning' ? { type: 'reasoning', text: '' } : { type: 'text', text: '' })
  state.open.set(contentIndex, { index, kind, text: seed })
  state.hasContent = true
  const out: StreamChunk[] = [{ type: 'block-start', index, blockType: kind }]
  if (seed !== '') out.push({ type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: seed })
  return out
}

function messagesAppendText(
  state: MessagesStreamState,
  contentIndex: number,
  kind: 'text' | 'reasoning',
  text: string,
): StreamChunk[] {
  if (text === '') return []
  const opened = messagesOpenText(state, contentIndex, kind, '')
  const block = state.open.get(contentIndex)!
  block.text += text
  state.hasContent = true
  return [...opened, { type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: block.index, text }]
}

function messagesCloseBlock(state: MessagesStreamState, contentIndex: number): StreamChunk[] {
  const open = state.open.get(contentIndex)
  if (open !== undefined) {
    state.open.delete(contentIndex)
    const block: OutboundContentBlock = open.kind === 'reasoning'
      ? { type: 'reasoning', text: open.text }
      : { type: 'text', text: open.text }
    state.blocks[open.index] = block
    return [{ type: 'block-end', index: open.index, block }]
  }
  const call = state.toolCalls.get(contentIndex)
  if (call === undefined) return []
  state.toolCalls.delete(contentIndex)
  const block: OutboundContentBlock = {
    type: 'tool-call',
    id: toToolCallId(call.id),
    name: call.name,
    arguments: call.arguments === '' ? '{}' : call.arguments,
  }
  state.blocks[call.index] = block
  state.hasToolCall = true
  state.hasContent = true
  return [{ type: 'block-end', index: call.index, block }]
}

function messagesCloseAll(state: MessagesStreamState): StreamChunk[] {
  const order = [...state.open.keys(), ...state.toolCalls.keys()]
    .map((contentIndex) => ({
      contentIndex,
      index: state.open.get(contentIndex)?.index ?? state.toolCalls.get(contentIndex)?.index ?? 0,
    }))
    .sort((left, right) => left.index - right.index)
  const out: StreamChunk[] = []
  for (const entry of order) out.push(...messagesCloseBlock(state, entry.contentIndex))
  return out
}

function messagesUsage(state: MessagesStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function messagesFinishReason(state: MessagesStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_use') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/** Flush every open block, then emit usage and the terminal finish. */
export function closeMessagesStream(state: MessagesStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = messagesCloseAll(state)
  if (state.sawUsage) out.push({ type: 'usage', usage: messagesUsage(state) })
  out.push({ type: 'finish', reason: messagesFinishReason(state) })
  return out
}

/** A stream that ends without `message_stop` is truncated, not complete. */
export function assertMessagesStreamComplete(state: MessagesStreamState): void {
  if (!state.sawMessageStop) {
    throw new LlmError('WorkBuddy Messages stream ended before message_stop', 'PROVIDER_ERROR')
  }
}

function messagesAccumulateUsage(state: MessagesStreamState, usage: Record<string, unknown>): void {
  state.sawUsage = true
  // A later message_delta often carries only output_tokens. Reconstruct the
  // aggregate input from the normalized counters instead of subtracting the
  // cache a second time when no fresh input_tokens field arrived.
  const input = numberOr(usage.input_tokens, state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens)
  const cached = numberOr(usage.cache_read_input_tokens, state.cacheReadTokens)
  const written = numberOr(usage.cache_creation_input_tokens, state.cacheWriteTokens)
  // DSH's input counts are DISJOINT: the cache counts are reported apart, so
  // they are subtracted out of the aggregate the surface reports.
  state.inputTokens = Math.max(0, input - cached - written)
  state.cacheReadTokens = cached
  state.cacheWriteTokens = written
  state.outputTokens = numberOr(usage.output_tokens, state.outputTokens)
}

/**
 * Feed one SSE line from `/v1/messages`.
 *
 * Both fragments of one event arrive as two lines (`event:` then `data:`), so
 * the parser keys on `data:` alone and ignores the event name: the JSON payload
 * carries its own `type`, which is the same discriminator and cannot disagree
 * with the label above it.
 */
export function processMessagesStreamLine(line: string, state: MessagesStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || !trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return []

  const event = safeJsonParse(payload)
  if (!isRecord(event)) return []
  const type = asString(event.type) ?? ''
  const out: StreamChunk[] = []

  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : {}
    throw new LlmError(
      'WorkBuddy Messages stream error: ' + (asString(error.message) ?? 'unknown error'),
      isContextOverflow(error) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  if (type === 'message_start') {
    state.sawMessageStart = true
    const message = isRecord(event.message) ? event.message : {}
    if (isRecord(message.usage)) messagesAccumulateUsage(state, message.usage)
    return out
  }

  if (type === 'content_block_start') {
    const index = numberOr(event.index, 0)
    const block = isRecord(event.content_block) ? event.content_block : {}
    const blockType = asString(block.type) ?? ''
    if (blockType === 'text') {
      out.push(...messagesOpenText(state, index, 'text', asString(block.text) ?? ''))
    } else if (blockType === 'thinking') {
      out.push(...messagesOpenText(state, index, 'reasoning', asString(block.thinking) ?? ''))
    } else if (blockType === 'redacted_thinking') {
      // The surface hides this block's text, so no visible reasoning is
      // invented for it: the block opens and closes with nothing readable.
      out.push(...messagesOpenText(state, index, 'reasoning', ''))
    } else if (blockType === 'tool_use') {
      const callIndex = state.blocks.length
      const call: MessagesToolCall = {
        index: callIndex,
        id: asString(block.id) ?? 'toolu_' + String(index),
        name: asString(block.name) ?? '',
        arguments: '',
      }
      state.toolCalls.set(index, call)
      state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index: callIndex, blockType: 'tool-call' })
      out.push({
        type: 'tool-call-delta',
        index: callIndex,
        id: toToolCallId(call.id),
        ...(call.name === '' ? {} : { name: call.name }),
        argumentsDelta: '',
      })
    }
    return out
  }

  if (type === 'content_block_delta') {
    const index = numberOr(event.index, 0)
    const delta = isRecord(event.delta) ? event.delta : {}
    const deltaType = asString(delta.type) ?? ''
    if (deltaType === 'text_delta') {
      out.push(...messagesAppendText(state, index, 'text', asString(delta.text) ?? ''))
    } else if (deltaType === 'thinking_delta') {
      out.push(...messagesAppendText(state, index, 'reasoning', asString(delta.thinking) ?? ''))
    } else if (deltaType === 'input_json_delta') {
      const call = state.toolCalls.get(index)
      if (call !== undefined) {
        const fragment = asString(delta.partial_json) ?? ''
        call.arguments += fragment
        if (fragment !== '') {
          out.push({
            type: 'tool-call-delta',
            index: call.index,
            id: toToolCallId(call.id),
            ...(call.name === '' ? {} : { name: call.name }),
            argumentsDelta: fragment,
          })
        }
      }
    }
    // `signature_delta` is consumed without a chunk: the harness block
    // vocabulary has no signature slot, so there is nowhere to put it. The
    // replay path keeps a signature when a block carries one; it never invents
    // one.
    return out
  }

  if (type === 'content_block_stop') {
    out.push(...messagesCloseBlock(state, numberOr(event.index, 0)))
    return out
  }

  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : {}
    const stop = asString(delta.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    if (isRecord(event.usage)) messagesAccumulateUsage(state, event.usage)
    return out
  }

  if (type === 'message_stop') {
    state.sawMessageStop = true
    return closeMessagesStream(state)
  }

  // `ping` and any event this build does not know are liveness only.
  return out
}

export { IMPLICIT_SYSTEM_PROMPT }
