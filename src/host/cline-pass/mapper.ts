/**
 * Cline Pass wire mapping: the harness conversation in, an OpenAI-compatible
 * `chat/completions` body out; decoded SSE frames in, harness stream chunks out.
 *
 * The request order rules matter more than they look: an assistant message
 * carrying `tool_calls` must be followed immediately by one `tool` message per
 * call id, or a validating gateway rejects the whole request with "insufficient
 * tool messages following tool_calls message". Everything that would otherwise
 * land inside that run is held back until the group closes.
 *
 * @module dsh-chatgpt-subscription/cline-pass-mapper
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
import { errorText, isAuthenticationError, isRecord, unwrapEnvelope } from './protocol.ts'

/** One OpenAI wire message. */
export interface ClinePassWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>>
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** One request body, as sent after pin injection. */
export interface ClinePassWireBody {
  model: string
  messages: ClinePassWireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>
  temperature?: number
  max_tokens?: number
  stop?: readonly string[]
  reasoning_effort?: string
  provider?: Record<string, unknown>
  providerOptions?: Record<string, unknown>
}

/** Lead-in text for the user message that carries images recovered from tool results. */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Join a message's text blocks. */
function flattenText(blocks: readonly CompatContentBlock[] | undefined): string {
  return (blocks ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Convert one assistant message, keeping tool calls and reasoning. */
function serializeAssistant(message: Message): ClinePassWireMessage {
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
 * every OpenAI-compatible gateway, while `system` is.
 */
export function serializeMessages(messages: readonly Message[], images: ResolvedRequestImages): ClinePassWireMessage[] {
  const wire: ClinePassWireMessage[] = []
  let pendingToolImages: Array<Record<string, unknown>> = []
  /** Call ids of the most recent assistant tool_calls still awaiting an answer. */
  let awaiting: string[] = []
  /** Messages held back so they cannot split the group; emitted in order. */
  let deferred: ClinePassWireMessage[] = []

  const flushDeferred = (): void => {
    if (deferred.length === 0) return
    for (const held of deferred) wire.push(held)
    deferred = []
  }
  /** Emit a non-tool message; a message that cannot close a group waits. */
  const emit = (message: ClinePassWireMessage): void => {
    if (awaiting.length > 0) deferred.push(message)
    else wire.push(message)
  }
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    const message: ClinePassWireMessage = {
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    }
    pendingToolImages = []
    emit(message)
  }
  /** A tool answer: it closes its own id, and the group when it was the last. */
  const answer = (callId: string, content: readonly CompatContentBlock[] | undefined): void => {
    wire.push({ role: 'tool', tool_call_id: callId, content: flattenText(content) || '(no output)' })
    collectImageParts(content, images, pendingToolImages)
    awaiting = awaiting.filter((id) => id !== callId)
    if (awaiting.length === 0) flushDeferred()
  }

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      flushToolImages()
      emit({ role: 'system', content: flattenText(message.content) })
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
    if (hasImage || text.length > 0 || toolResults.length === 0) {
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
 * Build the wire request for one harness call, before pinning.
 * @param options - the harness request (model, system, history, tools, sampling).
 * @param connection - resolved connection facts (default output budget).
 * @param images - attachmentId → prepared request version.
 */
export function buildClinePassBody(
  options: GenerateOptions,
  connection: { maxTokens: number },
  images: ResolvedRequestImages,
): ClinePassWireBody {
  const messages: ClinePassWireMessage[] = []
  if (options.system !== undefined && options.system !== '') messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages, images))
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const maxTokens = options.maxTokens ?? connection.maxTokens
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(maxTokens === undefined || maxTokens <= 0 ? {} : { max_tokens: maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: String(options.reasoningEffort) }),
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

/** Map a gateway error payload to a stable harness code. */
export function streamErrorCode(message: string, status?: number): string {
  const detail = String(message ?? '')
  // The harness vocabulary covers balances, but Cline also refuses spent
  // subscription windows. Require exhaustion, not just a window name, so a
  // temporary error fetching weekly usage does not stand an account down.
  const windowDetail = detail.replace(/[_-]/g, ' ')
  const spentWindow = /\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,80}?\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*|spent)\b|\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*)\b[\s\S]{0,80}?\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,40}?\b(?:limit|cap|quota|credits|budget|allowance)\b/i.test(windowDetail)
  if (status === 402 || spentWindow) return 'QUOTA'
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
 * @param body - a web ReadableStream of UTF-8 bytes.
 * @returns every `data:` payload up to `[DONE]`.
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
 * are all deferred to the `[DONE]` sentinel, so no chunk ever follows `finish`.
 * A completion with no content at all becomes an `EMPTY_RESPONSE` error finish
 * rather than a silent empty message.
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
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { type: 'finish' as const, reason: { kind: 'stop' as const } }
      yield {
        type: 'finish',
        reason: reason.reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason.reason,
      }
      return
    }
    const chunk = unwrapEnvelope(payload)
    // A 200 response whose body is an error object must fail the attempt, so a
    // pin that the router refuses still fails over to the next candidate.
    if (chunk.error !== undefined && chunk.choices === undefined) {
      throw new LlmError(errorText(chunk.error), streamErrorCode(errorText(chunk.error)))
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const delta = isRecord(choice.delta) ? choice.delta : {}
      // Two spellings carry the same thinking. The Cline gateway streams
      // `reasoning` (plus `reasoning_details`); `reasoning_content` is the
      // DeepSeek-native name some OpenAI-compatible backends use instead.
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
  throw new LlmError('stream ended without [DONE]', 'STREAM_CLOSED')
}
