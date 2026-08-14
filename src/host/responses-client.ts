import {
  CallId,
  LlmError,
  ProviderRequestId,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { CODEX_RESPONSES_URL } from '../compat.ts'
import { OAuthService } from './oauth-service.ts'
import { buildResponsesPayload } from './responses-mapper.ts'
import { codexHeaders, retryAfterMs, stableSessionId } from './wire-auth.ts'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

type FetchLike = typeof fetch

export interface ResponsesClientOptions {
  fetchFn?: FetchLike
  onGenerationFinished?: () => void
}

export class ResponsesClient {
  private readonly fetchFn: FetchLike
  private readonly onGenerationFinished: () => void

  constructor(
    private readonly oauth: OAuthService,
    private readonly attachments: Pick<AttachmentStore, 'readImage'>,
    options: ResponsesClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch
    this.onGenerationFinished = options.onGenerationFinished ?? (() => undefined)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const payload = await buildResponsesPayload(options, this.attachments)
    const sessionId = stableSessionId(options.sessionId)
    try {
      const response = await this.send(payload, sessionId, options.signal)
      yield* parseResponsesStream(response, options.signal)
    } finally {
      this.onGenerationFinished()
    }
  }

  private async send(payload: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<Response> {
    let credentials = await this.oauth.credentials()
    let response = await this.request(payload, credentials, sessionId, signal)
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      credentials = await this.oauth.credentials(true)
      response = await this.request(payload, credentials, sessionId, signal)
    }
    if (!response.ok) throw await responseError(response)
    return response
  }

  private async request(
    payload: Record<string, unknown>,
    credentials: Awaited<ReturnType<OAuthService['credentials']>>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchFn(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          ...codexHeaders(credentials, sessionId),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      throw new LlmError('Codex could not be reached.', 'NETWORK', { cause })
    }
  }
}

interface ToolState {
  index: number
  id: string
  itemId?: string
  name: string
  arguments: string
  started: boolean
}

export async function* parseResponsesStream(response: Response, signal?: AbortSignal): AsyncIterable<StreamChunk> {
  if (response.body === null) throw new LlmError('Codex returned no response stream.', 'PROVIDER_ERROR')
  const reader = response.body.getReader()
  const abortReader = (): void => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', abortReader, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let nextIndex = 0
  let textIndex: number | null = null
  let reasoningIndex: number | null = null
  let text = ''
  let reasoning = ''
  let terminal: FinishReason | null = null
  let usage: TokenUsage | null = null
  let replayOutput: Array<Record<string, unknown>> = []
  const tools = new Map<string, ToolState>()

  const toolFor = (event: Record<string, unknown>, item?: Record<string, unknown>): ToolState => {
    const itemId = string(event.item_id) ?? string(item?.id)
    const outputIndex = number(event.output_index)
    const key = itemId ?? (outputIndex === undefined ? `tool-${tools.size}` : `index-${outputIndex}`)
    let tool = tools.get(key)
    if (tool === undefined) {
      tool = {
        index: nextIndex++,
        id: string(item?.call_id) ?? string(event.call_id) ?? `call_${key}`,
        itemId,
        name: string(item?.name) ?? string(event.name) ?? '',
        arguments: '',
        started: false,
      }
      tools.set(key, tool)
    }
    return tool
  }

  const consume = async function* (event: Record<string, unknown>): AsyncIterable<StreamChunk> {
    const type = string(event.type)
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = string(event.delta) ?? ''
      if (textIndex === null) {
        textIndex = nextIndex++
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      text += delta
      if (delta) yield { type: 'text-delta', index: textIndex, text: delta }
      return
    }
    if (type === 'response.reasoning_summary_text.delta') {
      const delta = string(event.delta) ?? ''
      if (reasoningIndex === null) {
        reasoningIndex = nextIndex++
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      reasoning += delta
      if (delta) yield { type: 'reasoning-delta', index: reasoningIndex, text: delta }
      return
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(event.item)
      if (item !== null && type === 'response.output_item.done') replayOutput.push(structuredClone(item))
      if (string(item?.type) !== 'function_call') return
      const tool = toolFor(event, item ?? undefined)
      tool.id = string(item?.call_id) ?? tool.id
      tool.name = string(item?.name) ?? tool.name
      const initial = string(item?.arguments) ?? ''
      if (!tool.started) {
        tool.started = true
        yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: tool.index,
          id: CallId(tool.id),
          name: tool.name || undefined,
          argumentsDelta: initial,
        }
        tool.arguments = initial
      } else if (type === 'response.output_item.done' && initial !== '') {
        tool.arguments = initial
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const tool = toolFor(event)
      const delta = string(event.delta) ?? ''
      if (!tool.started) {
        tool.started = true
        yield { type: 'block-start', index: tool.index, blockType: 'tool-call' }
      }
      tool.arguments += delta
      yield {
        type: 'tool-call-delta',
        index: tool.index,
        id: CallId(tool.id),
        name: tool.name || undefined,
        argumentsDelta: delta,
      }
      return
    }
    if (type === 'response.function_call_arguments.done') {
      const tool = toolFor(event)
      const finalArguments = string(event.arguments)
      if (finalArguments !== undefined) tool.arguments = finalArguments
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const completed = record(event.response)
      usage = mapUsage(record(completed?.usage))
      const output = completed?.output
      if (Array.isArray(output)) {
        replayOutput = output.filter((item): item is Record<string, unknown> => record(item) !== null)
          .map((item) => structuredClone(item))
      }
      terminal = type === 'response.incomplete'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' }
      return
    }
    if (type === 'response.failed' || type === 'error') {
      const error = record(event.error) ?? record(record(event.response)?.error)
      throw new LlmError(string(error?.message) ?? 'Codex generation failed.', string(error?.code) ?? 'PROVIDER_ERROR')
    }
  }

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data === '' || data === '[DONE]') continue
        let event: unknown
        try {
          event = JSON.parse(data)
        } catch {
          throw new LlmError('Codex returned malformed streaming JSON.', 'PROTOCOL_ERROR')
        }
        const valueRecord = record(event)
        if (valueRecord !== null) yield* consume(valueRecord)
      }
    }
  } finally {
    signal?.removeEventListener('abort', abortReader)
    reader.releaseLock()
  }

  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (terminal === null) throw new LlmError('Codex stream ended before a terminal event.', 'PROTOCOL_ERROR')
  if (reasoningIndex !== null) {
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } }
  }
  if (textIndex !== null) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  }
  let validToolCount = 0
  for (const tool of tools.values()) {
    if (!tool.started) continue
    if (!isSafeJsonArguments(tool.arguments) || tool.name === '') {
      throw new LlmError(`Codex returned invalid JSON arguments for tool ${tool.name || '(unnamed)'}.`, 'INVALID_TOOL_ARGUMENTS')
    }
    validToolCount++
    yield {
      type: 'block-end',
      index: tool.index,
      block: { type: 'tool-call', id: CallId(tool.id), name: tool.name, arguments: tool.arguments },
    }
  }
  if (usage !== null) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: validToolCount > 0 ? { kind: 'tool-calls' } : terminal,
    replayState: { outputItems: replayOutput },
  }
}

function mapUsage(value: Record<string, unknown> | null): TokenUsage | null {
  if (value === null) return null
  const totalInput = number(value.input_tokens) ?? 0
  const outputTokens = number(value.output_tokens) ?? 0
  const cached = number(record(value.input_tokens_details)?.cached_tokens) ?? 0
  const reasoning = number(record(value.output_tokens_details)?.reasoning_tokens)
  return {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function isSafeJsonArguments(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

async function responseError(response: Response): Promise<LlmError> {
  const requestId = response.headers.get('x-request-id')
  const detail = (await response.text().catch(() => '')).slice(0, 500)
  const options = {
    status: response.status,
    ...(requestId ? { requestId: ProviderRequestId(requestId) } : {}),
    ...(response.status === 429 ? { providerRetryAfterMs: retryAfterMs(response.headers) } : {}),
  }
  if (response.status === 401) return new LlmError('ChatGPT sign-in has expired. Sign in again.', 'AUTH', options)
  if (response.status === 429) return new LlmError('Codex rate limit reached.', 'RATE_LIMIT', options)
  if (response.status >= 500) return new LlmError(`Codex service error (${response.status}).`, 'SERVER_ERROR', options)
  return new LlmError(`Codex request failed (${response.status})${detail ? `: ${detail}` : '.'}`, 'PROVIDER_ERROR', options)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
