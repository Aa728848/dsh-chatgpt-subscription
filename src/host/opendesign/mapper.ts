/**
 * OpenDesign wire mapping: the harness conversation in, an OpenAI-compatible
 * `chat/completions` body out; decoded SSE frames in, harness stream chunks out.
 *
 * The request order rules matter more than they look: an assistant message
 * carrying `tool_calls` must be followed immediately by one `tool` message per
 * call id, or a validating gateway rejects the whole request with "insufficient
 * tool messages following tool_calls message". Everything that would otherwise
 * land inside that run is held back until the group closes.
 *
 * @module dsh-chatgpt-subscription/opendesign-mapper
 */
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  ToolCallId,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock as CompatContentBlock, GenerateOptions, Message } from '../common/llm-compat.ts'
import {
  imageBlockToInline,
  unavailableImageText,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import { isRecord } from './client.ts'
import { PROVIDER_NAME } from './types.ts'

/** The sentence a no-content finish carries, shared with the sibling lines. */
export const NO_ANSWER_PHRASE = 'ended the turn without an answer or a tool call'

/** One OpenAI wire message. */
export interface OpenDesignWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>>
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** One request body, as sent to the gateway. */
export interface OpenDesignWireBody {
  model: string
  messages: OpenDesignWireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  temperature?: number
  max_tokens?: number
  stop?: readonly string[]
  reasoning_effort?: string
  /**
   * DeepSeek's own spelling for "do not think". Sent INSTEAD of
   * `reasoning_effort`, never beside it.
   */
  thinking?: { type: 'disabled' }
}

/** Lead-in text for the user message that carries images recovered from tool results. */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Join a message's text blocks. */
function flattenText(blocks: readonly CompatContentBlock[] | undefined): string {
  return (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Convert one assistant message, keeping tool calls and reasoning. */
function serializeAssistant(message: Message): OpenDesignWireMessage {
  const content = message.content ?? []
  const text = flattenText(content)
  const reasoning = content.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
  const toolCalls = content.filter((block) => block.type === 'tool-call').map((block) => ({
    id: block.id,
    type: 'function' as const,
    function: { name: block.name, arguments: block.arguments },
  }))
  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/** One image content part, or a visible placeholder when it cannot be sent. */
function imagePart(block: unknown, images: ResolvedRequestImages): Record<string, unknown> {
  const record = isRecord(block) ? block : {}
  const inline = imageBlockToInline(record, images)
  if (inline === undefined) return { type: 'text', text: unavailableImageText(record) }
  return { type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } }
}

/** Recursively collect image parts from blocks, including nested tool results. */
function collectImageParts(blocks: unknown, images: ResolvedRequestImages, target: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!Array.isArray(blocks)) return target
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') target.push(imagePart(block, images))
    else if (block.type === 'tool-result') collectImageParts(block.content, images, target)
  }
  return target
}

/** Names of the tools one developer message adds at its own history position. */
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

/** Names of the tools one developer message revokes at its own history position. */
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
 * The model-facing note that announces tools a conversation just gained.
 *
 * This route declares `toolUpdate: 'in-history'`, so the harness states an
 * addition as a block at its own history position instead of rewriting the whole
 * request's tool list. OpenAI has no message-level tool declaration, so the
 * change travels as this sentence: it costs one short system turn and leaves the
 * top-level `tools` array — and therefore the prefix cache — intact.
 */
function additionNotice(names: readonly string[]): string {
  const list = names.map((name) => '"' + name + '"').join(', ')
  return names.length === 1
    ? '[' + list + ' is now available. Call it when it helps with the task.]'
    : '[' + list + ' are now available. Call them when they help with the task.]'
}

/**
 * The model-facing note that revokes one or more tools.
 *
 * Imperative and unambiguous on purpose: the tool is still in the declaration
 * list, so this sentence is the only thing between the model and a call that
 * would fail.
 */
function removalNotice(names: readonly string[]): string {
  const list = names.map((name) => '"' + name + '"').join(', ')
  return names.length === 1
    ? '[' + list + ' is no longer available. Do not call it again: any call will fail.]'
    : '[' + list + ' are no longer available. Do not call them again: any call will fail.]'
}

/**
 * Convert the harness conversation to wire messages.
 *
 * Tool results become standalone `role: 'tool'` messages. A user message
 * carrying an image switches to the OpenAI content-part array; a text-only one
 * keeps the plain-string form. An image nested in a tool result has no OpenAI
 * `tool` wire spelling, so it rides a following user message instead — the same
 * shape the shipped adapters use. Deferring that message until the next non-tool
 * message keeps a parallel group's answers contiguous.
 *
 * `developer` becomes `system`: the newer OpenAI spelling is not accepted by
 * every OpenAI-compatible gateway, while `system` is. A tool addition or
 * removal carried by such a message is replayed as its own system sentence —
 * the `in-history` shape this route declares — and ordinary text is kept
 * beside it. A message that contributes neither is dropped rather than sent as
 * an empty system turn.
 *
 * A user message that carries no text and no image contributes nothing to a
 * chat request, so it is dropped too; a pure tool-result message never took that
 * path, because its answers travel as `tool` messages.
 */
export function serializeMessages(messages: readonly Message[], images: ResolvedRequestImages): OpenDesignWireMessage[] {
  const wire: OpenDesignWireMessage[] = []
  let pendingToolImages: Array<Record<string, unknown>> = []
  /** Call ids of the most recent assistant tool_calls still awaiting an answer. */
  let awaiting: string[] = []
  /** Messages held back so they cannot split the group; emitted in order. */
  let deferred: OpenDesignWireMessage[] = []

  const flushDeferred = (): void => {
    if (deferred.length === 0) return
    for (const held of deferred) wire.push(held)
    deferred = []
  }
  /** Emit a non-tool message; a message that cannot close a group waits. */
  const emit = (message: OpenDesignWireMessage): void => {
    if (awaiting.length > 0) deferred.push(message)
    else wire.push(message)
  }
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    const message: OpenDesignWireMessage = {
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    }
    pendingToolImages = []
    emit(message)
  }
  /** A tool answer: it closes its own id, and the group when it was the last. */
  const answer = (callId: string, content: readonly CompatContentBlock[] | undefined): void => {
    // A `tool` message no assistant `tool_calls` introduced is an illegal
    // OpenAI sequence: a validating gateway rejects the whole request with an
    // error that names no cause. Refuse it here, before anything is sent, and
    // name the id — durable history is not touched, exactly as it is not
    // touched when an image is dropped for the image budget.
    if (!awaiting.includes(callId)) {
      throw new LlmError(
        `OpenDesign request is invalid: the tool result for call id "${callId}" has no pending tool call to answer, `
        + 'so the message list would carry a tool message that no assistant tool_calls message introduced. Nothing was sent.',
        'INVALID_REQUEST',
      )
    }
    wire.push({ role: 'tool', tool_call_id: callId, content: flattenText(content) || '(no output)' })
    collectImageParts(content, images, pendingToolImages)
    awaiting = awaiting.filter((id) => id !== callId)
    if (awaiting.length === 0) flushDeferred()
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      flushToolImages()
      const text = flattenText(message.content)
      if (text.length > 0) emit({ role: 'system', content: text })
      const additions = toolAdditionNames(message)
      if (additions.length > 0) emit({ role: 'system', content: additionNotice(additions) })
      const removals = toolRemovalNames(message)
      if (removals.length > 0) emit({ role: 'system', content: removalNotice(removals) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      // A turn boundary. Anything still held belongs before the new turn, and an
      // unanswered group from the previous turn can no longer be answered.
      flushDeferred()
      wire.push(serializeAssistant(message))
      awaiting = (message.content ?? []).filter((block) => block.type === 'tool-call').map((block) => block.id)
      continue
    }
    const toolResults = (message.content ?? []).filter((block) => block.type === 'tool-result')
    const parts: Array<Record<string, unknown>> = []
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') parts.push(imagePart(block, images))
    }
    const hasImage = parts.some((part) => part.type === 'image_url')
    const text = parts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('')
    // Neither text nor an image means there is nothing a chat request can say
    // here; the answers below still travel as `tool` messages.
    if (hasImage || text.length > 0) {
      flushToolImages()
      emit({ role: 'user', content: hasImage ? parts : text })
    }
    for (const result of toolResults) {
      answer(result.toolCallId, result.content)
    }
  }
  flushToolImages()
  // A group the history never closed leaves nothing to wait for; whatever was
  // held still belongs in the request, just after the answers that do exist.
  flushDeferred()
  return wire
}

/**
 * Whether one model id is a DeepSeek model.
 *
 * The vendor prefix is stripped before the compare, so the bare wire id this
 * line ships (`deepseek-v4.1-flash`) and a vendor-qualified spelling
 * (`deepseek/deepseek-v4-pro`, as a sibling registry writes it) both match,
 * while an id that merely mentions the word — a gateway alias such as
 * `my-deepseek-proxy` — does not. Only DeepSeek's own chat endpoint documents
 * the `thinking` field, which is why the translation below is scoped to it
 * rather than applied to every model that offers a `none` level.
 */
export function isDeepSeekModel(model: string): boolean {
  const id = String(model ?? '').trim().toLowerCase()
  const bare = id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf(':')) + 1)
  return bare.startsWith('deepseek')
}

/**
 * Build the wire request for one harness call.
 * @param options - the harness request (model, system, history, tools, sampling).
 * @param connection - resolved connection facts (default output budget).
 * @param images - attachmentId → prepared request version.
 */
export function buildOpenDesignBody(
  options: GenerateOptions,
  connection: { maxTokens: number },
  images: ResolvedRequestImages,
): OpenDesignWireBody {
  const messages: OpenDesignWireMessage[] = []
  if (options.system !== undefined && options.system !== '') messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages, images))
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const maxTokens = options.maxTokens ?? connection.maxTokens
  const reasoningEffort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  // DeepSeek's own Chat Completions contract spells "do not think" as
  // `thinking: { type: 'disabled' }`, so the DSH `none` level is translated into
  // that field and `reasoning_effort` is left out of the same body instead of
  // being forwarded beside it. Every other model — and every other level on a
  // DeepSeek one — keeps the spelling it always had.
  const thinkingOff = reasoningEffort !== undefined
    && reasoningEffort.toLowerCase() === 'none'
    && isDeepSeekModel(options.model)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(maxTokens === undefined || maxTokens <= 0 ? {} : { max_tokens: maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(thinkingOff || reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(thinkingOff ? { thinking: { type: 'disabled' as const } } : {}),
  }
}

/** Map an OpenAI `finish_reason` to the harness finish reason. */
export function mapFinishReason(reason: string): StreamChunk & { type: 'finish' } {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { type: 'finish', reason: { kind: 'stop' } }
    case 'tool_calls':
    case 'tool-calls':
      return { type: 'finish', reason: { kind: 'tool-calls' } }
    case 'length':
    case 'max_tokens':
      return { type: 'finish', reason: { kind: 'max-tokens' } }
    default:
      return { type: 'finish', reason: { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } } }
  }
}

/**
 * Map OpenAI usage fields to disjoint harness counts.
 *
 * `prompt_tokens` includes cache hits per the OpenAI convention, and the harness
 * counts are disjoint, so cached tokens are subtracted out of `inputTokens`.
 */
export function mapUsage(usage: Record<string, unknown> | null | undefined): TokenUsage {
  const promptDetails = isRecord(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const completionDetails = isRecord(usage?.completion_tokens_details) ? usage.completion_tokens_details : undefined
  const cacheRead = Number(promptDetails?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0) || 0
  const reasoning = completionDetails?.reasoning_tokens
  const input = Number.isSafeInteger(usage?.prompt_tokens) ? Number(usage?.prompt_tokens) : 0
  const output = Number.isSafeInteger(usage?.completion_tokens) ? Number(usage?.completion_tokens) : 0
  const combined = input + output
  const total = usage?.total_tokens
  const hasExactTotal = Number.isSafeInteger(total) ? Number(total) === combined : true
  return {
    inputTokens: input - cacheRead,
    outputTokens: output,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(typeof reasoning === 'number' && Number.isSafeInteger(reasoning) ? { reasoningTokens: reasoning } : {}),
  }
}

/** One streamed identity field: a later empty or null value never clears it. */
function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/**
 * Read one delta's reasoning text, tolerating both wire spellings.
 *
 * Prefers the string field, and falls back to joining the `reasoning_details`
 * parts, which is where a gateway that omits the flat field puts the same text.
 */
export function reasoningOf(delta: Record<string, unknown>): string | undefined {
  for (const field of ['reasoning', 'reasoning_content']) {
    const value = delta[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const details = delta.reasoning_details
  if (Array.isArray(details)) {
    const text = details.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
    if (text.length > 0) return text
  }
  return undefined
}

/** The gateway's error string, whichever envelope it arrived in. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message
    if (typeof error.code === 'string') return error.code
  }
  return String(error ?? '')
}

/** Whether the payload is a bare error object rather than a completion chunk. */
export function isErrorPayload(payload: unknown): payload is { error: unknown } {
  return isRecord(payload) && payload.error !== undefined && payload.choices === undefined
}

/** Whether one refusal is about the credential at all. */
export function isAuthenticationError(message: string, status?: number): boolean {
  if (status === 401 || status === 403) return true
  return /missing_api_key|invalid_api_key|unauthenticated|unauthorized|invalid\s*(?:api\s*key|token)|api key not found/i.test(message)
}

/**
 * Map a gateway error payload to a stable harness code.
 *
 * OpenDesign meters in dollar-denominated credits, so the exhausted state reads
 * as an insufficient-balance/credits refusal, not a window name: 402, or the
 * gateway's own wording about credits/balance running out, is QUOTA. Anything
 * merely mentioning a plan or a limit is NOT — a temporary billing-lookup
 * failure must not stand an account down.
 */
export function streamErrorCode(message: string, status?: number): string {
  const detail = String(message ?? '')
  const spent = /(?:insufficient|out of|exhaust\w*|deplet\w*|spent|used up|run out)[\s\S]{0,60}?(?:credit|balance|quota)|(?:credit|balance|quota)[\s\S]{0,60}?(?:insufficient|exhaust\w*|deplet\w*|spent|used up|run(?:ning)? out)/i.test(detail)
  if (status === 402 || spent) return 'QUOTA'
  if (isAuthenticationError(detail, status)) return 'AUTH'
  if (status === 429 || /429|rate limit|rate-?limited/i.test(detail)) return 'RATE_LIMIT'
  if (/context\s*(?:length|window)|too many tokens|maximum context/i.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status !== undefined && status >= 400) return `HTTP_${status}`
  return 'UPSTREAM'
}

/**
 * Parse an SSE body into decoded JSON frames.
 *
 * The parser's contract is the sibling line's and stays unsoftened: a body that
 * ends without `[DONE]` is reported by THROWING `STREAM_CLOSED` after its last
 * frame. An SSE parser cannot tell a gateway that closes politely after the
 * terminal frame from a truncated response, because it never interprets
 * `finish_reason` — so it must not decide that question for its callers either.
 * That verdict belongs to {@link translate}, which has the frames, and absorbs
 * this one code from its input.
 * @param body - a web ReadableStream of UTF-8 bytes.
 * @returns every `data:` payload up to `[DONE]`, then throws `STREAM_CLOSED`.
 */
export async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown | '[DONE]'> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.length === 0 || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          yield '[DONE]'
          return
        }
        try {
          yield JSON.parse(payload)
        } catch { /* an unparseable frame carries nothing to deliver */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload === '[DONE]') {
      yield '[DONE]'
      return
    }
    if (payload.length > 0) {
      try {
        yield JSON.parse(payload)
      } catch { /* see above */ }
    }
  }
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Whether one failure is the SSE parser's own "the body ended without [DONE]".
 *
 * Structural rather than `instanceof`: what has to match is the CODE the parser
 * assigns, and a second copy of this module (or a harness generation that ships
 * its own LlmError class) would fail an identity test on a value that is
 * otherwise exactly the signal this decision is about.
 */
function isMissingSentinel(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'STREAM_CLOSED'
}

/**
 * End the payload iteration instead of throwing when a body stops without the
 * sentinel.
 *
 * The parser can only report "no [DONE] arrived" by throwing, and that is NOT a
 * failure on its own: the gateway sometimes closes the response right after the
 * terminal frame. Whether the response actually completed is decided by the
 * frames that were seen, which is knowledge this generator does not have — so it
 * only removes the transport signal and leaves the verdict to {@link translate}.
 * Every other failure passes through untouched, including the error frames a 200
 * body can carry.
 */
async function* tolerateMissingSentinel(
  payloads: AsyncIterable<unknown | '[DONE]'>,
): AsyncGenerator<unknown | '[DONE]'> {
  try {
    for await (const payload of payloads) yield payload
  } catch (error) {
    if (!isMissingSentinel(error)) throw error
  }
}

/** Assemble the terminal content block for one open block. */
function closeBlock(block: { kind: 'text' | 'reasoning' | 'tool-call'; text: string; callId?: string; name?: string }): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    default:
      return { type: 'tool-call', id: ToolCallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text }
  }
}

/**
 * Translate decoded SSE payloads into harness stream chunks.
 *
 * Deltas stream through as they arrive; block ends, usage and the finish reason
 * are all deferred to the end of the answer, so no chunk ever follows `finish`.
 * A completion with no content at all becomes an `EMPTY_RESPONSE` error finish
 * rather than a silent empty message.
 *
 * The end of the answer is either the `[DONE]` sentinel or the end of the body
 * AFTER a terminal `finish_reason` arrived. Some gateways close the socket
 * instead of writing the sentinel, and failing such an answer threw away content
 * the caller had already received.
 *
 * The parser still raises `STREAM_CLOSED` for a body with no sentinel — that is
 * its contract and it is not widened here. The signal is absorbed where the
 * frames are available instead (see {@link tolerateMissingSentinel}), and only
 * then does the finish reason decide: a body that stated one closes like any
 * other, and a body that never stated one is truncation and still fails with
 * `STREAM_CLOSED`. No other input failure is absorbed.
 */
export async function* translate(payloads: AsyncIterable<unknown | '[DONE]'>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  type OpenText = { index: number; kind: 'text'; text: string }
  type OpenReasoning = { index: number; kind: 'reasoning'; text: string }
  type OpenTool = { index: number; kind: 'tool-call'; text: string; callId?: string; name?: string }
  type OpenBlock = OpenText | OpenReasoning | OpenTool
  let textBlock: OpenText | undefined
  let reasoningBlock: OpenReasoning | undefined
  const toolBlocks = new Map<number, OpenTool>()
  const order: OpenBlock[] = []
  let pendingFinish: (StreamChunk & { type: 'finish' }) | undefined
  let pendingUsage: TokenUsage | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = kind === 'text'
      ? { index: nextIndex++, kind: 'text', text: '' }
      : kind === 'reasoning'
        ? { index: nextIndex++, kind: 'reasoning', text: '' }
        : { index: nextIndex++, kind: 'tool-call', text: '' }
    order.push(block)
    return block
  }
  /** The terminal chunks of one completed answer, in the order the harness accepts. */
  const terminal = (reason: StreamChunk & { type: 'finish' }): StreamChunk[] => {
    const chunks: StreamChunk[] = []
    for (const block of order) chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
    if (pendingUsage !== undefined) chunks.push({ type: 'usage', usage: pendingUsage })
    const hasVisibleAnswer = toolBlocks.size > 0 || (textBlock !== undefined && textBlock.text.trim() !== '')
    chunks.push({
      type: 'finish',
      reason: reason.reason.kind === 'stop' && order.length === 0
        ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
        : reason.reason.kind === 'stop' && !hasVisibleAnswer
          ? { kind: 'error', failure: { message: PROVIDER_NAME + ' ' + NO_ANSWER_PHRASE + ' — the response stopped before it did anything', code: 'PROVIDER_ERROR' } }
          : reason.reason,
    })
    return chunks
  }
  for await (const payload of tolerateMissingSentinel(payloads)) {
    if (payload === '[DONE]') {
      const reason = pendingFinish ?? { type: 'finish' as const, reason: { kind: 'stop' as const } }
      for (const chunk of terminal(reason)) yield chunk
      return
    }
    // A 200 response whose body is an error object must fail the attempt: a
    // gateway that wraps a refusal this way still refused.
    if (isErrorPayload(payload)) {
      throw new LlmError(errorText(payload.error), streamErrorCode(errorText(payload.error)))
    }
    const chunk = isRecord(payload) ? payload : {}
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const delta = isRecord(choice.delta) ? choice.delta : {}
      // Two spellings carry the same thinking: `reasoning` (plus
      // `reasoning_details`) on some gateways, `reasoning_content` on others.
      const reasoning = reasoningOf(delta)
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning') as OpenReasoning
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text') as OpenText
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      for (const call of toolCalls) {
        if (!isRecord(call)) continue
        const index = Number(call.index ?? 0)
        let block = toolBlocks.get(index)
        if (block === undefined) {
          block = open('tool-call') as OpenTool
          toolBlocks.set(index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const fn = isRecord(call.function) ? call.function : {}
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, fn.name)
        const fragment = typeof fn.arguments === 'string' ? fn.arguments : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name === undefined ? {} : { name: block.name }),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (isRecord(chunk.usage)) pendingUsage = mapUsage(chunk.usage)
  }
  // The body ended without the sentinel. A response that already named its
  // finish reason is complete — only the sentinel was missing — so it closes
  // like any other. This also covers an input that ends without throwing at all
  // (a caller that hands over its own frames), which is why the EOF decision
  // lives here rather than only in the absorbed parser signal.
  if (pendingFinish !== undefined) {
    for (const chunk of terminal(pendingFinish)) yield chunk
    return
  }
  // No finish_reason was ever stated, so there is nothing that says the answer
  // finished — this is the truncation the code has always meant.
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}
