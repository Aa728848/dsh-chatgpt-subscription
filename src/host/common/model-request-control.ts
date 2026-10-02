import { createHash } from 'node:crypto'
import { ConcurrencyGate } from './concurrency-gate.ts'

export const CONTROLLED_PROVIDERS = ['codex-chatgpt', 'claude', 'antigravity', 'kimi-code', 'minimax-code', 'command-code', 'workbuddy', 'ollama'] as const
export type ControlledProvider = typeof CONTROLLED_PROVIDERS[number]
export interface ModelRequestLimits {
  /** Per credential limits, not guessed subscription entitlements. Zero disables. */
  default?: number
  providers?: Partial<Record<ControlledProvider, number>>
  queueTimeoutMs?: number
}

/** Explicit deployment configuration. Invalid values fail closed at startup. */
export function readModelRequestLimits(env: NodeJS.ProcessEnv = process.env): ModelRequestLimits {
  const raw = env.DSH_PROVIDER_CONCURRENCY
  if (!raw) return {}
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('DSH_PROVIDER_CONCURRENCY must be a JSON object') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH_PROVIDER_CONCURRENCY must be a JSON object')
  const input = value as Record<string, unknown>
  const allowed = new Set<string>(['default', 'queueTimeoutMs', ...CONTROLLED_PROVIDERS])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error('Unknown DSH_PROVIDER_CONCURRENCY field')
  const number = (key: string, max: number): number | undefined => {
    const n = input[key]
    if (n === undefined) return undefined
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) throw new Error('Invalid DSH_PROVIDER_CONCURRENCY numeric value')
    return n
  }
  const providers: Partial<Record<ControlledProvider, number>> = {}
  for (const provider of CONTROLLED_PROVIDERS) {
    const limit = number(provider, 10000)
    if (limit !== undefined) providers[provider] = limit
  }
  return { default: number('default', 10000), queueTimeoutMs: number('queueTimeoutMs', 3600000), providers }
}

/** Only generation POSTs are limited; token refresh/catalog/quota must never wait behind them. */
export function isModelRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (method.toUpperCase() !== 'POST') return false
  let path: string
  try { path = new URL(input instanceof Request ? input.url : String(input)).pathname } catch { return false }
  return ['/responses', '/messages', '/chat/completions', '/api/chat'].some(suffix => path.endsWith(suffix))
    || /:(?:streamGenerateContent|generateContent)$/.test(path)
}

export interface ModelRequestControlOptions {
  provider: ControlledProvider
  limits: ModelRequestLimits
  gate?: ConcurrencyGate
}

/** Hold a slot until EOF, cancel, abort or failure, never merely until response headers. */
export function createControlledModelFetch(baseFetch: typeof fetch, options: ModelRequestControlOptions): typeof fetch {
  const gate = options.gate ?? new ConcurrencyGate()
  const limit = options.limits.providers?.[options.provider] ?? options.limits.default ?? 0
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid provider concurrency limit')
  if (limit === 0) return baseFetch
  return async (input, init) => {
    if (!isModelRequest(input, init)) return baseFetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    // Token rotation intentionally starts a fresh credential scope. No secret is exposed or logged.
    const credential = headers.get('authorization') ?? headers.get('x-api-key') ?? ''
    const key = options.provider + ':' + createHash('sha256').update(credential).digest('hex')
    gate.setLimit(key, limit)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const queued = new AbortController()
    const abortQueue = () => queued.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', abortQueue, { once: true })
    if (signal?.aborted) abortQueue()
    const timeout = options.limits.queueTimeoutMs ?? 120000
    const timer = timeout > 0 ? setTimeout(() => queued.abort(new DOMException('Provider concurrency queue timed out', 'TimeoutError')), timeout) : undefined
    let release: () => void
    try { release = await gate.acquire(key, queued.signal) }
    finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abortQueue)
      if (gate.inFlight(key) === 0) gate.setLimit(key, 0)
    }
    let done = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = () => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', abort)
      release()
      if (gate.inFlight(key) === 0) gate.setLimit(key, 0)
    }
    const abort = () => {
      const reason = signal?.reason ?? new DOMException('Aborted', 'AbortError')
      finish()
      if (reader) void reader.cancel(reason).catch(() => undefined).finally(() => { try { reader?.releaseLock() } catch {} })
      try { controller?.error(reason) } catch { /* already closed */ }
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) { abort(); throw signal.reason ?? new DOMException('Aborted', 'AbortError') }
      const response = await baseFetch(input, init)
      if (done) { void response.body?.cancel().catch(() => undefined); throw signal?.reason ?? new DOMException('Aborted', 'AbortError') }
      if (!response.body) { finish(); return response }
      reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        start(c) { controller = c },
        async pull(c) {
          try {
            const chunk = await reader!.read()
            if (done) return
            if (chunk.done) { finish(); reader!.releaseLock(); c.close() }
            else c.enqueue(chunk.value)
          } catch (error) { finish(); try { reader!.releaseLock() } catch {} ; c.error(error) }
        },
        async cancel(reason) { finish(); try { await reader!.cancel(reason) } finally { reader!.releaseLock() } },
      }, { highWaterMark: 0 })
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      // Preserve metadata read by redirect/fallback code without altering response body semantics.
      for (const name of ['url', 'redirected', 'type'] as const) Object.defineProperty(wrapped, name, { value: response[name] })
      return wrapped
    } catch (error) { finish(); throw error }
  }
}
