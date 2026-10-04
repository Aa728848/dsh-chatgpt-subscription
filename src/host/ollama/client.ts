import {
  CATALOG_TIMEOUT_MS,
  CLOUD_BASE_URL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  NATIVE_CHAT_PATH,
  NATIVE_TAGS_PATH,
  OPENAI_CHAT_PATH,
  OPENAI_MODELS_PATH,
  ollamaHeaders,
  type OllamaCatalogModel,
  type OllamaWire,
} from './types.ts'
import type { OllamaCredentials } from './token-store.ts'

/** One message on the wire, in either surface's shape. */
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Image parts this turn carries; the OpenAI surface takes an array, the native one too. */
  images?: string[]
  /** Tool call id a `tool` result answers. */
  toolCallId?: string
  /** Assistant tool calls that produced this turn. */
  toolCalls?: OllamaToolCall[]
}

export interface OllamaToolCall {
  id: string
  name: string
  /** Raw JSON the model produced for the arguments. */
  arguments: string
}

export interface OllamaRequest {
  model: string
  messages: OllamaChatMessage[]
  tools?: { name: string; description?: string; parameters: unknown }[]
  maxOutputTokens?: number
  temperature?: number
  /**
   * Thinking control, in Ollama's own vocabulary: a boolean for on/off, or a
   * model-defined level name taken from that model's metadata. It is never
   * guessed here — the adapter only sends a value the model declares.
   */
  think?: boolean | string
  signal?: AbortSignal
}

/**
 * Token accounting one completed turn reports.
 *
 * These are the counts Ollama's own OpenAPI documents on the chat response
 * (`prompt_eval_count` and `eval_count`), so they measure what this key has
 * actually spent rather than anything inferred from the text.
 *
 * They are NOT a quota. The service publishes no account limit, no remaining
 * balance and no reset time anywhere in its API: upstream issues #15132 and
 * #15663 asked for one and both were closed. So nothing here can say how much
 * is left - only what has been consumed.
 */
export interface OllamaUsage {
  inputTokens: number
  outputTokens: number
}

export type OllamaStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: OllamaToolCall }
  | { type: 'done'; finishReason?: string }
  | { type: 'usage'; usage: OllamaUsage }
  | { type: 'error'; message: string }

export interface OllamaCallResult {
  events: AsyncGenerator<OllamaStreamEvent>
  /** Resolves the HTTP status once the response headers arrive. */
  status: Promise<number>
}

/** Headers both surfaces require, per docs/api/authentication. */
export function headersFor(credentials: OllamaCredentials, accept: string): Record<string, string> {
  return { ...ollamaHeaders(credentials.apiKey), accept }
}

/**
 * Build the request body for one wire shape.
 *
 * The two surfaces are not translations of each other — the native API nests the
 * assistant's tool calls under `message.tool_calls` and expects results under a
 * `tool` role without ids, while the OpenAI surface uses `tool_calls` and
 * `tool_call_id`. Mapping them through one shared builder would have to guess at
 * the fields the other surface does not carry, so each is written out where its
 * own rules stay visible.
 */
export function buildBody(wire: OllamaWire, request: OllamaRequest): unknown {
  if (wire === 'openai') return buildOpenAIBody(request)
  return buildNativeBody(request)
}

export function toBareBase64(image: string): string {
  const match = /^data:[^;]+;base64,(.+)$/.exec(image)
  return match ? match[1]! : image
}

export function toDataUrl(image: string, defaultMediaType = 'image/png'): string {
  if (image.startsWith('data:') || image.startsWith('http://') || image.startsWith('https://')) {
    return image
  }
  return `data:${defaultMediaType};base64,${image}`
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (raw === undefined || raw === null || raw === '') {
    return {}
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '{}') return {}
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    throw new Error(`Tool call arguments must be a JSON object, got ${typeof parsed}`)
  }
  throw new Error(`Invalid tool call arguments: ${String(raw)}`)
}

function buildOpenAIBody(request: OllamaRequest): unknown {
  const messages: Record<string, unknown>[] = []
  let pendingToolImages: string[] = []

  const flushToolImages = () => {
    if (pendingToolImages.length > 0) {
      messages.push({
        role: 'user',
        content: pendingToolImages.map((image) => ({
          type: 'image_url',
          image_url: { url: toDataUrl(image) },
        })),
      })
      pendingToolImages = []
    }
  }

  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      })
      // Chat Completions tool message schema only allows text content;
      // images accumulate across consecutive tool messages and ride on
      // one synthetic user message flushed after the tool group ends.
      if (message.images !== undefined && message.images.length > 0) {
        pendingToolImages.push(...message.images)
      }
      continue
    }

    flushToolImages()

    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        })),
      })
      continue
    }
    messages.push(openAIContent(message))
  }
  flushToolImages()
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
  // Ollama's OpenAI surface carries thinking as a top-level `reasoning_effort`;
  // the native one carries `think`. Only a value the caller resolved from the
  // model's own metadata is sent.
  if (typeof request.think === 'string') body.reasoning_effort = request.think
  else if (request.think === true) body.reasoning_effort = 'auto'
  else if (request.think === false) body.reasoning_effort = 'none'
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters },
    }))
  }
  // Ollama does not document a per-model temperature ceiling, and a reasoning
  // model may reject one, so it is sent only when the caller asked for it.
  if (request.temperature !== undefined) body.temperature = request.temperature
  return body
}

function buildNativeBody(request: OllamaRequest): unknown {
  const messages = request.messages.map((message) => {
    if (message.role === 'tool') {
      const item: Record<string, unknown> = { role: 'tool', content: message.content }
      if (message.images !== undefined && message.images.length > 0) {
        item.images = message.images.map(toBareBase64)
      }
      return item
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: parseArguments(call.arguments) },
        })),
      }
    }
    return nativeContent(message)
  })
  const body: Record<string, unknown> = { model: request.model, messages, stream: true }
  // The native surface takes `think` directly, and unlike the OpenAI alias it
  // accepts a boolean, which is the only form some models take.
  if (request.think !== undefined) body.think = request.think
  const options: Record<string, unknown> = {
    num_predict: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  }
  if (request.temperature !== undefined) options.temperature = request.temperature
  body.options = options
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters },
    }))
  }
  return body
}

/**
 * A user turn on the OpenAI surface: text stays text, images become parts.
 *
 * Ollama's OpenAI compatibility takes the standard `image_url` part with a data URL.
 */
function openAIContent(message: OllamaChatMessage): Record<string, unknown> {
  if (message.images === undefined || message.images.length === 0) {
    return { role: message.role, content: message.content }
  }
  return {
    role: message.role,
    content: [
      { type: 'text', text: message.content },
      ...message.images.map((image) => ({ type: 'image_url', image_url: { url: toDataUrl(image) } })),
    ],
  }
}

/**
 * A user turn on the native surface, where images are a sibling array of raw
 * base64 strings rather than data URLs or interleaved content parts.
 */
function nativeContent(message: OllamaChatMessage): Record<string, unknown> {
  if (message.images === undefined || message.images.length === 0) {
    return { role: message.role, content: message.content }
  }
  return { role: message.role, content: message.content, images: message.images.map(toBareBase64) }
}

/** The endpoint one request goes to. */
export function chatUrl(wire: OllamaWire): string {
  return wire === 'openai'
    ? `${CLOUD_BASE_URL}${OPENAI_CHAT_PATH}`
    : `${CLOUD_BASE_URL}${NATIVE_CHAT_PATH}`
}

/**
 * Start one streaming chat call.
 *
 * The HTTP status is surfaced through a promise rather than by handing back the
 * Response, because the caller has to decide between retrying this account and
 * failing the turn, and both need the status before any body is read.
 */
export function startChat(
  fetchFn: typeof fetch,
  credentials: OllamaCredentials,
  wire: OllamaWire,
  request: OllamaRequest,
): OllamaCallResult {
  let resolveStatus: (status: number) => void = () => undefined
  let rejectStatus: (error: unknown) => void = () => undefined
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve
    rejectStatus = reject
  })
  // The request is issued EAGERLY, before anything pulls the generator.
  // A generator body does not run until its first `next()`, so opening the
  // connection inside it would leave a caller that awaits `status` first
  // waiting forever for a response that was never requested - and the account
  // failover path awaits exactly that, so the deadlock would fire on the 429 and
  // 403 branches that exist to recover from a bad key.
  const opened = fetchFn(chatUrl(wire), {
    method: 'POST',
    headers: headersFor(credentials, 'text/event-stream'),
    body: JSON.stringify(buildBody(wire, request)),
    signal: request.signal,
  }).then(
    (response) => {
      resolveStatus(response.status)
      return response
    },
    (error) => {
      rejectStatus(error)
      throw error
    },
  )
  const events = (async function* run(): AsyncGenerator<OllamaStreamEvent> {
    const response = await opened
    if (!response.ok) {
      const detail = await safeErrorText(response)
      yield { type: 'error', message: `Ollama request failed (${response.status}): ${detail}` }
      return
    }
    yield* readStream(response, wire)
  })()
  return { events, status }
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 500)
  } catch {
    return ''
  }
}

/** Parse the SSE stream of either surface. */
async function* readStream(response: Response, wire: OllamaWire): AsyncGenerator<OllamaStreamEvent> {
  const body = response.body
  if (body === null) return
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  // Partial tool-call argument text accumulates across deltas, keyed by the
  // index the stream uses to pair them. Both surfaces number their deltas.
  const pending = new Map<number, OllamaToolCall>()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '' || !line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        for (const event of parseEvent(payload, wire, pending)) yield event
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  // A call the stream never terminated still has to reach the caller, or the turn
  // would end with the model having asked for a tool and nothing acting on it.
  for (const call of pending.values()) {
    yield { type: 'tool_call', call: call.arguments === '' ? { ...call, arguments: '{}' } : call }
  }
}

function parseEvent(
  payload: string,
  wire: OllamaWire,
  pending: Map<number, OllamaToolCall>,
): OllamaStreamEvent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const record = parsed as Record<string, unknown>
  if (typeof record.error === 'string') return [{ type: 'error', message: record.error }]
  return wire === 'openai'
    ? parseOpenAIChunk(record, pending)
    : parseNativeChunk(record, pending)
}

function parseOpenAIChunk(record: Record<string, unknown>, pending: Map<number, OllamaToolCall>): OllamaStreamEvent[] {
  const events: OllamaStreamEvent[] = []
  const choices = Array.isArray(record.choices) ? record.choices : []
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const entry = choice as Record<string, unknown>
    const delta = entry.delta
    if (typeof delta === 'object' && delta !== null) {
      const fields = delta as Record<string, unknown>
      if (typeof fields.content === 'string' && fields.content !== '') {
        events.push({ type: 'text', text: fields.content })
      }
      const thinking = typeof fields.thinking === 'string'
        ? fields.thinking
        : typeof fields.reasoning === 'string'
          ? fields.reasoning
          : typeof fields.reasoning_content === 'string'
            ? fields.reasoning_content
            : ''
      if (thinking !== '') events.push({ type: 'thinking', text: thinking })
      if (Array.isArray(fields.tool_calls)) {
        for (const raw of fields.tool_calls) accumulateToolCall(raw, pending, true)
      }
    }
    if (typeof entry.finish_reason === 'string' && entry.finish_reason !== '') {
      events.push({ type: 'done', finishReason: entry.finish_reason })
    }
  }
  // Read the counts off the terminal chunk, where OpenAI-compatible streams put
  // them. Only the last chunk carries them, so taking them per-chunk would
  // double-count every turn.
  const usage = readUsage(record)
  if (usage !== null) events.push({ type: 'usage', usage })
  return events
}

function parseNativeChunk(record: Record<string, unknown>, pending: Map<number, OllamaToolCall>): OllamaStreamEvent[] {
  const events: OllamaStreamEvent[] = []
  const message = record.message
  if (typeof message === 'object' && message !== null) {
    const fields = message as Record<string, unknown>
    if (typeof fields.content === 'string' && fields.content !== '') {
      events.push({ type: 'text', text: fields.content })
    }
    // Thinking streams in its own field on both surfaces and interleaves with
    // the answer, so it is a separate event rather than prefixed text.
    const thinking = typeof fields.thinking === 'string'
      ? fields.thinking
      : typeof fields.reasoning === 'string'
        ? fields.reasoning
        : typeof fields.reasoning_content === 'string'
          ? fields.reasoning_content
          : ''
    if (thinking !== '') events.push({ type: 'thinking', text: thinking })
    if (Array.isArray(fields.tool_calls)) {
      for (const raw of fields.tool_calls) accumulateToolCall(raw, pending, false)
    }
  }
  if (record.done === true) events.push({ type: 'done', finishReason: 'stop' })
  // The native surface reports the same two counts by their own names, on the
  // chunk it marks done.
  const usage = readNativeUsage(record)
  if (usage !== null) events.push({ type: 'usage', usage })
  return events
}

/**
 * Read token counts off an OpenAI-compatible chunk.
 *
 * Ollama names them the OpenAI way here (`prompt_tokens` / `completion_tokens`),
 * while the native surface uses `prompt_eval_count` / `eval_count`. Both are
 * accepted on both paths because the service documents the native names in its
 * own OpenAPI and an OpenAI-compatible alias in the compatibility layer, and a
 * counter that silently read zero on the wrong surface would be worse than none.
 *
 * Returns null when the chunk carries neither pair, which is every content chunk.
 */
function readUsage(record: Record<string, unknown>): OllamaUsage | null {
  const container = (typeof record.usage === 'object' && record.usage !== null
    ? record.usage as Record<string, unknown>
    : record)
  const input = firstNumber(container, ['prompt_tokens', 'prompt_eval_count', 'input_tokens'])
  const output = firstNumber(container, ['completion_tokens', 'eval_count', 'output_tokens'])
  if (input === undefined && output === undefined) return null
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}

/** The native surface's names, read from the chunk itself. */
function readNativeUsage(record: Record<string, unknown>): OllamaUsage | null {
  const input = firstNumber(record, ['prompt_eval_count', 'prompt_tokens', 'input_tokens'])
  const output = firstNumber(record, ['eval_count', 'completion_tokens', 'output_tokens'])
  if (input === undefined && output === undefined) return null
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    // A count the service omits is unknown, not zero; a negative or non-finite
    // value is a malformed response, and neither may lower a running total.
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  }
  return undefined
}

/**
 * Fold one streamed tool-call delta into the pending set.
 *
 * Nothing is emitted here: a call is only complete once the stream has ended, and
 * emitting a half-received argument string would have the caller act on a tool
 * invocation that does not exist yet. The native surface sends no id, so a stable
 * synthetic one is minted from the delta index — the only handle both surfaces
 * agree on for pairing a call with its result.
 */
function accumulateToolCall(
  raw: unknown,
  pending: Map<number, OllamaToolCall>,
  openaiShape: boolean,
): void {
  if (typeof raw !== 'object' || raw === null) return
  const record = raw as Record<string, unknown>
  const index = typeof record.index === 'number' ? record.index : 0
  const holder = typeof record.function === 'object' && record.function !== null
    ? record.function as Record<string, unknown>
    : record
  const name = typeof holder.name === 'string' ? holder.name : undefined
  const args = typeof holder.arguments === 'string' ? holder.arguments : undefined
  const id = openaiShape && typeof record.id === 'string' ? record.id : undefined
  if (name === undefined && args === undefined && id === undefined) return

  const existing = pending.get(index)
  const call: OllamaToolCall = existing ?? { id: id ?? `call_${index}`, name: '', arguments: '' }
  if (id !== undefined && id !== '') call.id = id
  if (name !== undefined && name !== '') call.name = name
  if (args !== undefined) call.arguments += args
  pending.set(index, call)
}

/**
 * Why a catalog read came back without a list.
 *
 * These are the four things that can go wrong between the card asking for a sync
 * and the service answering, and they are kept apart because each one has a
 * different fix on the user's side: `auth` is a key Ollama refused, `upstream` is
 * Ollama refusing for some other reason, `unreachable` is a network or proxy
 * problem, and `malformed` is a reply that is not the documented `/api/tags`
 * document at all. Collapsing them into one "could not read the model list"
 * sentence leaves the user with nothing to act on, which is the complaint behind
 * issue #36.
 */
export type OllamaCatalogFailure = 'auth' | 'upstream' | 'unreachable' | 'malformed'

/** One catalog read, with the reason it produced no list. */
export interface OllamaCatalogResult {
  models: OllamaCatalogModel[]
  /** Absent on success. An account entitled to nothing succeeds with an empty list. */
  failure?: OllamaCatalogFailure
  /** The HTTP status behind an `auth` or `upstream` failure. */
  status?: number
}

/**
 * Read the model catalog.
 *
 * `/api/tags` is the native surface's own list and needs no translation; the
 * OpenAI `/models` endpoint would be a subset of it. Returns an empty list rather
 * than throwing, so a failed sync degrades to the cached selection instead of
 * making the line unusable.
 */
export async function loadCatalog(
  fetchFn: typeof fetch,
  credentials: OllamaCredentials,
): Promise<OllamaCatalogModel[]> {
  return (await fetchCatalog(fetchFn, credentials)).models
}

/**
 * The same read as {@link loadCatalog}, keeping the reason it failed.
 *
 * Never throws, for the reason its wrapper has always given. What it adds is that
 * "failed" stops being one opaque state, so the settings card can name the
 * cause instead of asking the user to guess.
 */
export async function fetchCatalog(
  fetchFn: typeof fetch,
  credentials: OllamaCredentials,
): Promise<OllamaCatalogResult> {
  let response: Response
  try {
    response = await fetchFn(`${CLOUD_BASE_URL}${NATIVE_TAGS_PATH}`, {
      method: 'GET',
      headers: headersFor(credentials, 'application/json'),
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
  } catch {
    // DNS, TLS, a proxy that refuses, or the timeout above. Each of them means
    // the request never reached a service that answered, which is a different
    // thing from the service answering "no".
    return { models: [], failure: 'unreachable' }
  }
  if (!response.ok) {
    return response.status === 401 || response.status === 403
      ? { models: [], failure: 'auth', status: response.status }
      : { models: [], failure: 'upstream', status: response.status }
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    // A 200 whose body is an HTML interstitial — a captive portal, a corporate
    // proxy, a CDN challenge. This is the same parse that used to throw straight
    // through the route and out of the web server.
    return { models: [], failure: 'malformed' }
  }
  if (typeof data !== 'object' || data === null) return { models: [], failure: 'malformed' }
  const record = data as Record<string, unknown>
  // A document without a `models` array is not `/api/tags`, whatever its status
  // line claimed.
  if (!Array.isArray(record.models)) return { models: [], failure: 'malformed' }
  const models = record.models
  const result: OllamaCatalogModel[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const fields = entry as Record<string, unknown>
    const name = typeof fields.name === 'string' ? fields.name : undefined
    const model = typeof fields.model === 'string' ? fields.model : undefined
    const id = name ?? model
    if (id === undefined || id === '') continue
    result.push({ id, name, fetchedAt: Date.now() })
  }
  return { models: result }
}

/** The OpenAI-compatible model list, for callers that prefer that surface's view. */
export async function loadOpenAIModels(
  fetchFn: typeof fetch,
  credentials: OllamaCredentials,
): Promise<string[]> {
  const response = await fetchFn(`${CLOUD_BASE_URL}${OPENAI_MODELS_PATH}`, {
    method: 'GET',
    headers: headersFor(credentials, 'application/json'),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) return []
  const data = await response.json() as unknown
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>
  const models = Array.isArray(record.data) ? record.data : []
  const ids: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as Record<string, unknown>).id
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}
