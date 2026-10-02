/**
 * Reusable request diagnostics wrapper for model provider calls.
 *
 * Implements W5 usage, latency, and transport diagnostics:
 * - First-byte chunk latency (firstByteMs) and total duration
 * - Request payload bytes (null when unknown stream, not 0)
 * - Safe runtime-validated enum-only endpoint and provider classification
 * - Ephemeral keyed-HMAC fingerprints scoped per provider+endpoint
 * - Disjoint token usage mapping with missing vs zero differentiation and endpoint-awareness
 * - Complete SSE line and NDJSON streaming parser merging start/delta usage
 * - Stream proxy with backpressure preservation (highWaterMark: 0) and early cancel/abort
 * - Isolated failure boundary (diagnostics sink failures never break generation)
 *
 * @module dsh-chatgpt-subscription/request-diagnostics
 */

import { createHmac, randomBytes } from 'node:crypto'

export const DIAGNOSTIC_PROVIDERS = [
  'codex-chatgpt',
  'claude-subscription',
  'antigravity',
  'kimi-code',
  'minimax-code',
  'command-code',
  'workbuddy-subscription',
  'ollama',
  'claude',
  'workbuddy',
  'codex',
] as const

export type DiagnosticProviderId = (typeof DIAGNOSTIC_PROVIDERS)[number]

export const KNOWN_WIRE_ENDPOINTS = [
  'messages',
  'responses',
  'chat_completions',
  'generate_content',
  'stream_generate_content',
  'ollama_chat',
  'ollama_generate',
  'workbuddy_chat',
  'unknown',
] as const

export type KnownWireEndpoint = (typeof KNOWN_WIRE_ENDPOINTS)[number]

export function isValidProvider(provider: unknown): provider is DiagnosticProviderId {
  return typeof provider === 'string' && (DIAGNOSTIC_PROVIDERS as readonly string[]).includes(provider)
}

export function isValidEndpoint(endpoint: unknown): endpoint is KnownWireEndpoint {
  return typeof endpoint === 'string' && (KNOWN_WIRE_ENDPOINTS as readonly string[]).includes(endpoint)
}

export type HttpStatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'error'

export interface DisjointUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface FingerprintComparison {
  prefixFingerprint?: string
  toolFingerprint?: string
  modelFingerprint?: string
  authFingerprint?: string
  prefixChanged?: boolean
  toolChanged?: boolean
  modelChanged?: boolean
  authChanged?: boolean
}

export interface RequestDiagnosticRecord {
  provider: DiagnosticProviderId
  endpoint: KnownWireEndpoint
  requestBytes: number | null
  firstByteMs: number | null
  ttftMs: null // Plain byte chunking cannot prove token semantics; strictly null
  durationMs: number
  statusCode: number | null
  statusClass: HttpStatusClass
  outcome: 'completed' | 'canceled' | 'error'
  usage?: DisjointUsage
  retries?: number
  fingerprints?: FingerprintComparison
}

export interface CorrelationOptions {
  sessionId?: string
  retryCount?: number
}

export interface DiagnosticFetchOptions {
  provider?: DiagnosticProviderId
  endpoint?: KnownWireEndpoint
  enabled?: boolean
  onRecord?: (record: RequestDiagnosticRecord) => unknown
  classifyEndpoint?: (url: string, pathname: string) => KnownWireEndpoint | null
  correlation?: CorrelationOptions
}

export type FetchLike = typeof fetch
export type FetchInput = Parameters<FetchLike>[0]
export type FetchInit = Parameters<FetchLike>[1]

// Ephemeral per-process key for HMAC fingerprints (never stored, uncorrelatable across runs)
const EPHEMERAL_HMAC_KEY = randomBytes(32)

export function computeHmacPrefix(data: string): string {
  return createHmac('sha256', EPHEMERAL_HMAC_KEY).update(data).digest('hex').slice(0, 16)
}

const MAX_SESSION_CACHE_SIZE = 500

interface SessionFingerprints {
  authFingerprint?: string
  modelFingerprint?: string
  toolFingerprint?: string
  prefixFingerprint?: string
}

const sessionCache = new Map<string, SessionFingerprints>()

export function clearDiagnosticSessionState(): void {
  sessionCache.clear()
}

export function getDiagnosticSessionCacheSize(): number {
  return sessionCache.size
}

function updateSessionFingerprints(
  scopedSessionKey: string,
  current: SessionFingerprints,
): FingerprintComparison {
  const prev = sessionCache.get(scopedSessionKey)

  const comparison: FingerprintComparison = {
    ...current,
    authChanged:
      current.authFingerprint !== undefined && prev?.authFingerprint !== undefined
        ? current.authFingerprint !== prev.authFingerprint
        : undefined,
    modelChanged:
      current.modelFingerprint !== undefined && prev?.modelFingerprint !== undefined
        ? current.modelFingerprint !== prev.modelFingerprint
        : undefined,
    toolChanged:
      current.toolFingerprint !== undefined && prev?.toolFingerprint !== undefined
        ? current.toolFingerprint !== prev.toolFingerprint
        : undefined,
    prefixChanged:
      current.prefixFingerprint !== undefined && prev?.prefixFingerprint !== undefined
        ? current.prefixFingerprint !== prev.prefixFingerprint
        : undefined,
  }

  if (sessionCache.has(scopedSessionKey)) {
    sessionCache.delete(scopedSessionKey)
  } else if (sessionCache.size >= MAX_SESSION_CACHE_SIZE) {
    const oldestKey = sessionCache.keys().next().value
    if (oldestKey) {
      sessionCache.delete(oldestKey)
    }
  }

  sessionCache.set(scopedSessionKey, {
    authFingerprint: current.authFingerprint ?? prev?.authFingerprint,
    modelFingerprint: current.modelFingerprint ?? prev?.modelFingerprint,
    toolFingerprint: current.toolFingerprint ?? prev?.toolFingerprint,
    prefixFingerprint: current.prefixFingerprint ?? prev?.prefixFingerprint,
  })

  return comparison
}

function isDiagnosticsEnabled(options?: DiagnosticFetchOptions): boolean {
  if (options?.enabled !== undefined) {
    return Boolean(options.enabled)
  }
  return process.env.DSH_PROVIDER_DIAGNOSTICS === '1'
}

function classifyHttpStatus(statusCode: number | null): HttpStatusClass {
  if (statusCode === null) return 'error'
  if (statusCode >= 200 && statusCode < 300) return '2xx'
  if (statusCode >= 300 && statusCode < 400) return '3xx'
  if (statusCode >= 400 && statusCode < 500) return '4xx'
  if (statusCode >= 500 && statusCode < 600) return '5xx'
  return 'error'
}

export function isDefaultModelPath(pathname: string): KnownWireEndpoint | null {
  const path = pathname.toLowerCase()
  if (path.endsWith('/messages')) return 'messages'
  if (path.endsWith('/responses')) return 'responses'
  if (
    path.endsWith('/chat/completions') ||
    path.endsWith('/chatcompletion_v2') ||
    path.endsWith('/conversation') ||
    path.endsWith('/latents/chat')
  ) {
    return 'chat_completions'
  }
  if (path.includes(':streamgeneratecontent')) return 'stream_generate_content'
  if (path.includes(':generatecontent')) return 'generate_content'
  if (path.endsWith('/api/chat')) return 'ollama_chat'
  if (path.endsWith('/api/generate')) return 'ollama_generate'
  return null
}

function getUrlAndPathname(input: FetchInput): { fullUrl: string; pathname: string } {
  let fullUrl = ''
  if (typeof input === 'string') {
    fullUrl = input
  } else if (input instanceof URL) {
    fullUrl = input.toString()
  } else if (typeof input === 'object' && input !== null && 'url' in input) {
    fullUrl = String(input.url)
  }

  try {
    const parsed = new URL(fullUrl, 'http://127.0.0.1')
    return { fullUrl, pathname: parsed.pathname }
  } catch {
    return { fullUrl, pathname: '' }
  }
}

function getHeaderValue(
  headers: FetchInit extends { headers?: infer H } ? H : unknown,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const target = name.toLowerCase()

  if (headers instanceof Headers) {
    return headers.get(target) ?? undefined
  }

  if (Array.isArray(headers)) {
    for (const [key, val] of headers) {
      if (key.toLowerCase() === target) return val
    }
    return undefined
  }

  if (typeof headers === 'object') {
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === target) {
        return typeof val === 'string' ? val : undefined
      }
    }
  }

  return undefined
}

function measureRequestBytes(
  body: unknown,
  input: FetchInput,
  init?: FetchInit,
): number | null {
  if (body === null || body === undefined) {
    if (input instanceof Request && input.body) {
      const cl = input.headers.get('content-length')
      if (cl) {
        const parsed = parseInt(cl, 10)
        if (!Number.isNaN(parsed) && parsed >= 0) return parsed
      }
      return null
    }
    const cl = getHeaderValue(init?.headers, 'content-length')
    if (cl) {
      const parsed = parseInt(cl, 10)
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed
    }
    return 0
  }

  if (typeof body === 'string') {
    return Buffer.byteLength(body, 'utf-8')
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.size
  }

  return null
}

const MAX_JSON_PARSE_BYTES = 512 * 1024

function extractBodyFingerprints(body: unknown): {
  modelFingerprint?: string
  toolFingerprint?: string
  prefixFingerprint?: string
} {
  if (typeof body !== 'string' || body.length > MAX_JSON_PARSE_BYTES) {
    return {}
  }

  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return {}

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    let modelFingerprint: string | undefined
    if (typeof parsed.model === 'string' && parsed.model) {
      modelFingerprint = computeHmacPrefix(parsed.model)
    }

    let toolFingerprint: string | undefined
    if (Array.isArray(parsed.tools)) {
      toolFingerprint = computeHmacPrefix(JSON.stringify(parsed.tools))
    }

    let prefixFingerprint: string | undefined
    let prefixCandidate = ''
    if (typeof parsed.instructions === 'string' && parsed.instructions) {
      prefixCandidate = parsed.instructions
    } else if (typeof parsed.system === 'string' && parsed.system) {
      prefixCandidate = parsed.system
    } else if (Array.isArray(parsed.system) && parsed.system.length > 0) {
      prefixCandidate = JSON.stringify(parsed.system)
    } else if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      const first = parsed.messages[0]
      if (first && typeof first === 'object') {
        const f = first as Record<string, unknown>
        if (f.role === 'system' || f.role === 'developer') {
          prefixCandidate = typeof f.content === 'string' ? f.content : JSON.stringify(f.content)
        } else {
          prefixCandidate = JSON.stringify(f)
        }
      }
    }

    if (prefixCandidate) {
      prefixFingerprint = computeHmacPrefix(prefixCandidate)
    }

    return { modelFingerprint, toolFingerprint, prefixFingerprint }
  } catch {
    return {}
  }
}

function parseFiniteNonNegativeNumber(val: unknown): number | undefined {
  if (typeof val === 'number') {
    if (Number.isFinite(val) && val >= 0) return Math.floor(val)
    return undefined
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const num = Number(val)
    if (Number.isFinite(num) && num >= 0) return Math.floor(num)
  }
  return undefined
}

export function parseUsageObject(
  raw: unknown,
  endpoint?: KnownWireEndpoint,
): DisjointUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>

  const totalInput =
    parseFiniteNonNegativeNumber(r.prompt_tokens) ??
    parseFiniteNonNegativeNumber(r.input_tokens)
  const outputTokens =
    parseFiniteNonNegativeNumber(r.completion_tokens) ??
    parseFiniteNonNegativeNumber(r.output_tokens)
  const totalTokens = parseFiniteNonNegativeNumber(r.total_tokens)

  const inputDetails =
    typeof r.prompt_tokens_details === 'object' && r.prompt_tokens_details !== null
      ? (r.prompt_tokens_details as Record<string, unknown>)
      : typeof r.input_tokens_details === 'object' && r.input_tokens_details !== null
        ? (r.input_tokens_details as Record<string, unknown>)
        : null

  const outputDetails =
    typeof r.completion_tokens_details === 'object' && r.completion_tokens_details !== null
      ? (r.completion_tokens_details as Record<string, unknown>)
      : typeof r.output_tokens_details === 'object' && r.output_tokens_details !== null
        ? (r.output_tokens_details as Record<string, unknown>)
        : null

  const cacheRead =
    parseFiniteNonNegativeNumber(inputDetails?.cached_tokens) ??
    parseFiniteNonNegativeNumber(r.cache_read_input_tokens) ??
    parseFiniteNonNegativeNumber(r.cache_read_tokens)

  const cacheWrite =
    parseFiniteNonNegativeNumber(inputDetails?.cache_write_tokens) ??
    parseFiniteNonNegativeNumber(r.cache_creation_input_tokens) ??
    parseFiniteNonNegativeNumber(r.cache_write_tokens)

  const reasoning =
    parseFiniteNonNegativeNumber(outputDetails?.reasoning_tokens) ??
    parseFiniteNonNegativeNumber(r.reasoning_tokens)

  if (
    totalInput === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined
  }

  let disjointInput: number | undefined
  if (totalInput !== undefined) {
    if (endpoint === 'messages') {
      disjointInput = totalInput
    } else {
      disjointInput = Math.max(0, totalInput - (cacheRead ?? 0) - (cacheWrite ?? 0))
    }
  }

  return {
    ...(disjointInput !== undefined ? { inputTokens: disjointInput } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

function mergeUsage(
  target: DisjointUsage | undefined,
  source: DisjointUsage | undefined,
): DisjointUsage | undefined {
  if (!target) return source ? { ...source } : undefined
  if (!source) return target ? { ...target } : undefined

  return {
    inputTokens: source.inputTokens ?? target.inputTokens,
    outputTokens: source.outputTokens ?? target.outputTokens,
    cacheReadTokens: source.cacheReadTokens ?? target.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens ?? target.cacheWriteTokens,
    reasoningTokens: source.reasoningTokens ?? target.reasoningTokens,
    totalTokens: source.totalTokens ?? target.totalTokens,
  }
}

const MAX_LINE_BUFFER_BYTES = 64 * 1024

class StreamingUsageParser {
  private lineBuffer = ''
  private accumulatedUsage: DisjointUsage | undefined

  constructor(private readonly endpoint: KnownWireEndpoint) {}

  private droppingLine = false

  feed(chunkText: string): void {
    let start = 0
    while (start < chunkText.length) {
      const newline = chunkText.indexOf('\n', start)
      const end = newline === -1 ? chunkText.length : newline
      if (!this.droppingLine) {
        if (this.lineBuffer.length + end - start > MAX_LINE_BUFFER_BYTES) {
          this.lineBuffer = ''
          this.droppingLine = true
        } else {
          this.lineBuffer += chunkText.slice(start, end)
        }
      }
      if (newline === -1) break
      if (!this.droppingLine) this.processLine(this.lineBuffer.trim())
      this.lineBuffer = ''
      this.droppingLine = false
      start = newline + 1
    }
  }

  flush(): DisjointUsage | undefined {
    const trailing = this.lineBuffer.trim()
    if (trailing) {
      this.processLine(trailing)
      this.lineBuffer = ''
    }
    return this.accumulatedUsage
  }

  private processLine(line: string): void {
    let payload = line
    if (payload.startsWith('data:')) {
      payload = payload.slice(5).trim()
    }
    if (!payload || payload === '[DONE]') {
      return
    }

    if (!payload.startsWith('{')) {
      return
    }

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return
      }

      if (parsed.type === 'message_start' && parsed.message && typeof parsed.message === 'object') {
        const msg = parsed.message as Record<string, unknown>
        if (msg.usage) {
          const parsedUsage = parseUsageObject(msg.usage, this.endpoint)
          this.accumulatedUsage = mergeUsage(this.accumulatedUsage, parsedUsage)
          return
        }
      }

      if (parsed.type === 'message_delta' && parsed.usage) {
        const parsedUsage = parseUsageObject(parsed.usage, this.endpoint)
        this.accumulatedUsage = mergeUsage(this.accumulatedUsage, parsedUsage)
        return
      }

      if (parsed.done === true) {
        const promptEval = parseFiniteNonNegativeNumber(parsed.prompt_eval_count)
        const evalCount = parseFiniteNonNegativeNumber(parsed.eval_count)
        if (promptEval !== undefined || evalCount !== undefined) {
          const ollamaUsage: DisjointUsage = {
            ...(promptEval !== undefined ? { inputTokens: promptEval } : {}),
            ...(evalCount !== undefined ? { outputTokens: evalCount } : {}),
            ...(promptEval !== undefined && evalCount !== undefined
              ? { totalTokens: promptEval + evalCount }
              : {}),
          }
          this.accumulatedUsage = mergeUsage(this.accumulatedUsage, ollamaUsage)
          return
        }
      }

      const rawUsage =
        parsed.usage ??
        (parsed.response && typeof parsed.response === 'object' ? (parsed.response as any).usage : undefined) ??
        (parsed.message && typeof parsed.message === 'object' ? (parsed.message as any).usage : undefined)

      if (rawUsage && typeof rawUsage === 'object') {
        const parsedUsage = parseUsageObject(rawUsage, this.endpoint)
        this.accumulatedUsage = mergeUsage(this.accumulatedUsage, parsedUsage)
      }
    } catch {
    }
  }
}

/**
 * Creates a diagnostic wrapper around fetch for model requests.
 */
export function createDiagnosticFetch(
  baseFetch: FetchLike,
  options?: DiagnosticFetchOptions,
): FetchLike {
  return async function diagnosticFetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    if (!isDiagnosticsEnabled(options)) {
      return baseFetch(input, init)
    }

    const method = (
      init?.method ??
      (input instanceof Request
        ? input.method
        : typeof input === 'object' && input !== null && 'method' in input
          ? String((input as any).method)
          : 'GET')
    ).toUpperCase()

    if (method !== 'POST') {
      return baseFetch(input, init)
    }

    const { fullUrl, pathname } = getUrlAndPathname(input)

    const rawEndpoint =
      options?.endpoint ??
      (options?.classifyEndpoint
        ? options.classifyEndpoint(fullUrl, pathname)
        : isDefaultModelPath(pathname))

    if (!rawEndpoint || !isValidEndpoint(rawEndpoint)) {
      return baseFetch(input, init)
    }

    const endpoint: KnownWireEndpoint = rawEndpoint
    const candidateProvider = options?.provider ?? 'codex-chatgpt'
    if (!isValidProvider(candidateProvider)) {
      return baseFetch(input, init)
    }
    const provider: DiagnosticProviderId = candidateProvider

    const requestBytes = measureRequestBytes(init?.body, input, init)
    const startTime = performance.now()

    const authHeader =
      getHeaderValue(init?.headers, 'authorization') ??
      getHeaderValue(init?.headers, 'x-api-key') ??
      (input instanceof Request ? input.headers.get('authorization') ?? input.headers.get('x-api-key') ?? undefined : undefined)
    const authFingerprint = authHeader ? computeHmacPrefix(authHeader) : undefined

    const sessionRaw =
      options?.correlation?.sessionId ??
      getHeaderValue(init?.headers, 'x-session-id') ??
      getHeaderValue(init?.headers, 'session_id') ??
      (input instanceof Request ? input.headers.get('x-session-id') ?? input.headers.get('session_id') ?? undefined : undefined)

    const scopedSessionKey = sessionRaw
      ? computeHmacPrefix(provider + ':' + endpoint + ':' + sessionRaw)
      : undefined

    let retries: number | undefined
    if (typeof options?.correlation?.retryCount === 'number') {
      retries = options.correlation.retryCount
    } else {
      const retryHeader =
        getHeaderValue(init?.headers, 'x-retry-count') ??
        getHeaderValue(init?.headers, 'retry-count') ??
        (input instanceof Request ? input.headers.get('x-retry-count') ?? input.headers.get('retry-count') ?? undefined : undefined)
      if (retryHeader) {
        const parsed = parseInt(retryHeader, 10)
        if (!Number.isNaN(parsed)) {
          retries = parsed
        }
      }
    }

    const bodyPayload = init?.body ?? (input instanceof Request ? undefined : undefined)
    const bodyFingerprints = extractBodyFingerprints(bodyPayload)
    const currentFingerprints: SessionFingerprints = {
      authFingerprint,
      ...bodyFingerprints,
    }

    let fingerprints: FingerprintComparison | undefined
    if (scopedSessionKey) {
      fingerprints = updateSessionFingerprints(scopedSessionKey, currentFingerprints)
    } else if (
      currentFingerprints.authFingerprint ||
      currentFingerprints.modelFingerprint ||
      currentFingerprints.toolFingerprint ||
      currentFingerprints.prefixFingerprint
    ) {
      fingerprints = { ...currentFingerprints }
    }

    const signal: AbortSignal | undefined =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)

    let firstByteMs: number | null = null
    let emitted = false
    const usageParser = new StreamingUsageParser(endpoint)
    const decoder = new TextDecoder('utf-8', { fatal: false })

    function emitRecord(
      outcome: 'completed' | 'canceled' | 'error',
      statusCode: number | null,
    ) {
      if (emitted) return
      emitted = true
      const durationMs = Math.max(0, Math.round(performance.now() - startTime))
      const usage = outcome === 'completed' ? usageParser.flush() : undefined

      const record: RequestDiagnosticRecord = {
        provider,
        endpoint,
        requestBytes,
        firstByteMs,
        ttftMs: null,
        durationMs,
        statusCode,
        statusClass: classifyHttpStatus(statusCode),
        outcome,
        ...(usage !== undefined ? { usage } : {}),
        ...(retries !== undefined ? { retries } : {}),
        ...(fingerprints !== undefined ? { fingerprints } : {}),
      }

      try {
        const res = options?.onRecord?.(record)
        if (res && typeof (res as Promise<void>).catch === 'function') {
          ;(res as Promise<void>).catch(() => {})
        }
      } catch {
      }
    }

    let response: Response
    try {
      response = await baseFetch(input, init)
    } catch (error) {
      const isAbort =
        Boolean(signal?.aborted) ||
        (error instanceof Error && error.name === 'AbortError')
      emitRecord(isAbort ? 'canceled' : 'error', null)
      throw error
    }

    if (signal?.aborted) {
      const reason = signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      emitRecord('canceled', response.status)
      if (response.body) {
        try {
          const r = response.body.getReader()
          await r.cancel(reason)
          r.releaseLock()
        } catch {}
      }
      throw reason
    }

    if (response.body === null || response.status === 204 || response.status === 304) {
      emitRecord(response.ok ? 'completed' : 'error', response.status)
      return response
    }

    const originalBody = response.body
    const reader = originalBody.getReader()
    let streamClosed = false
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

    const cleanup = () => {
      streamClosed = true
      if (signal) {
        try {
          signal.removeEventListener('abort', abortListener)
        } catch {}
      }
    }

    const abortListener = () => {
      if (streamClosed) return
      cleanup()
      const reason = signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      emitRecord('canceled', response.status)
      try {
        controllerRef?.error(reason)
      } catch {}
      reader
        .cancel(reason)
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock()
          } catch {}
        })
    }

    if (signal) {
      signal.addEventListener('abort', abortListener, { once: true })
    }

    const wrappedBody = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controllerRef = controller
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              cleanup()
              try {
                reader.releaseLock()
              } catch {}
              emitRecord('completed', response.status)
              controller.close()
              return
            }

            if (value && value.byteLength > 0) {
              if (firstByteMs === null) {
                firstByteMs = Math.max(0, Math.round(performance.now() - startTime))
              }
              const text = decoder.decode(value, { stream: true })
              if (text) {
                usageParser.feed(text)
              }
            }

            controller.enqueue(value)
          } catch (err) {
            cleanup()
            try {
              reader.releaseLock()
            } catch {}
            const isAbort =
              Boolean(signal?.aborted) ||
              (err instanceof Error && err.name === 'AbortError')
            emitRecord(isAbort ? 'canceled' : 'error', response.status)
            controller.error(err)
          }
        },
        async cancel(reason) {
          cleanup()
          emitRecord('canceled', response.status)
          try {
            await reader.cancel(reason)
          } finally {
            try {
              reader.releaseLock()
            } catch {}
          }
        },
      },
      { highWaterMark: 0 },
    )

    const wrappedResponse = new Response(wrappedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })

    try {
      Object.defineProperty(wrappedResponse, 'url', {
        value: response.url,
        writable: false,
        configurable: true,
      })
      Object.defineProperty(wrappedResponse, 'redirected', {
        value: response.redirected,
        writable: false,
        configurable: true,
      })
      Object.defineProperty(wrappedResponse, 'type', {
        value: response.type,
        writable: false,
        configurable: true,
      })
    } catch {}

    return wrappedResponse
  }
}
