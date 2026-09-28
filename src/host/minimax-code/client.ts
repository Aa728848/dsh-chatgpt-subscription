/**
 * HTTP surface of the MiniMax Code subscription.
 *
 * ONE header rule governs this whole file, and it is the one the brief calls out as
 * a hard constraint: credentials are sent as `authorization: Bearer <accessToken>`.
 * The endpoint also speaks the Anthropic wire format, whose client normally
 * authenticates with `x-api-key`, and that difference was measured directly — an
 * `x-api-key` request answers 401 `{"code":401,"message":"token is required"}`
 * while the bearer form answers 200. There is deliberately no fallback that tries
 * `x-api-key` after a 401: the measured verdict is that it cannot succeed, and a
 * retry would only add a request to the subscription's bill.
 *
 * The second rule is an absence: this file has no `/v1/models` call and must never
 * grow one. That route is not configured for subscription traffic and answers 503
 * `{"errorCode":50115,"errorReason":"direct_route_not_configured"}`; the model
 * directory is hardcoded in ./model-catalog.ts instead.
 */

import {
  ANTHROPIC_VERSION,
  DEFAULT_DEVICE_INTERVAL_SECONDS,
  MESSAGES_PATH,
  agentBaseUrl,
  messagesUrl,
  MINIMAX_CODE_BUILD_ENV,
  USER_AGENT,
  redactToken,
} from './types.ts'
import {
  MinimaxCodeCredentialStore,
  type MinimaxCodeCredentials,
} from './token-store.ts'
import { accountFromCredentials, ensureAccessToken, MinimaxCodeUnauthorizedError } from './oauth.ts'
import { MINIMAX_CODE_MODELS, minimaxCodeModelIds } from './model-catalog.ts'
import type { MinimaxCodeAccount, MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'

/** Timeout for the connection probe and any other one-shot call. */
const PROBE_TIMEOUT_MS = 30_000

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Headers for one Messages request.
 *
 * `authorization: Bearer` is REQUIRED and is the only credential field sent —
 * see this file's header comment for the measured reason an `x-api-key` variant
 * must not exist.
 *
 * The token itself never appears in a log line or an error: callers that need to
 * name a credential do so through `redactToken`.
 */
export function modelRequestHeaders(accessToken: string): Record<string, string> {
  return {
    // REQUIRED. Measured: x-api-key answers 401 {"code":401,"message":"token is required"}.
    authorization: 'Bearer ' + accessToken,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': USER_AGENT,
  }
}

/** Headers for a non-streaming call (the probe). */
export function probeRequestHeaders(accessToken: string): Record<string, string> {
  return { ...modelRequestHeaders(accessToken), accept: 'application/json' }
}

/** One parsed Anthropic `usage` object. */
export interface MinimaxUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read the four token counters the Messages response reports. */
export function parseAnthropicUsage(payload: unknown): MinimaxUsage | null {
  const usage = asRecord(asRecord(payload)?.usage)
  if (usage === undefined) return null
  return {
    inputTokens: numberOr(usage.input_tokens, 0),
    outputTokens: numberOr(usage.output_tokens, 0),
    cacheReadTokens: numberOr(usage.cache_read_input_tokens, 0),
    cacheWriteTokens: numberOr(usage.cache_creation_input_tokens, 0),
  }
}

/** Short, single-line excerpt of one error body, safe to show a user. */
export function summarizeFailureBody(raw: string): string {
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (text === '') return ''
  try {
    const parsed: unknown = JSON.parse(text)
    const record = asRecord(parsed)
    if (record !== undefined) {
      const message = record.message ?? record.error_description ?? record.errorReason ?? record.error
      if (typeof message === 'string') return message.slice(0, 400)
      const nested = asRecord(record.error)
      const nestedMessage = nested?.message
      if (typeof nestedMessage === 'string') return nestedMessage.slice(0, 400)
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 400)
}

export interface MinimaxProbeResult {
  ok: boolean
  /** Model the probe used, when it reached the service. */
  model?: string
  /** Failure sentence, already safe to render. */
  error?: string
  latencyMs: number
  account?: MinimaxCodeAccount | null
  usage?: MinimaxUsage
}

/**
 * Model the connection probe uses.
 *
 * M3 is the model the measured request used, so a probe against it exercises the
 * exact shape the reconnaissance attested rather than a preview id that may not be
 * entitled on every account.
 */
export const PROBE_MODEL = 'MiniMax-M3'

/**
 * Prove the stored credential still authenticates.
 *
 * The probe is the real Messages endpoint, because that is the only surface the
 * subscription exposes to a third-party client: there is no account-profile route
 * and `/v1/models` is unavailable, so a 200 from `/messages` is what "signed in"
 * means here. The request is deliberately tiny — one word, 16 output tokens — so a
 * probe the user triggered by pressing a button costs almost nothing.
 */
export async function testConnection(
  store: MinimaxCodeCredentialStore,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<MinimaxProbeResult> {
  const fetchFn = options.fetchFn ?? fetch
  const startedAt = Date.now()
  let credentials: MinimaxCodeCredentials
  try {
    credentials = await ensureAccessToken(store, { fetchFn, signal: options.signal })
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const url = messagesUrl(credentials.region)
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: probeRequestHeaders(credentials.accessToken),
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: withTimeout(options.signal, PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const detail = summarizeFailureBody(raw)
      return {
        ok: false,
        model: PROBE_MODEL,
        latencyMs,
        error: 'MiniMax Code answered HTTP ' + response.status
          + (detail === '' ? '.' : ': ' + detail),
      }
    }
    const payload: unknown = await response.json().catch(() => undefined)
    return {
      ok: true,
      model: PROBE_MODEL,
      latencyMs,
      account: accountFromCredentials(credentials),
      ...(parseAnthropicUsage(payload) === null ? {} : { usage: parseAnthropicUsage(payload) as MinimaxUsage }),
    }
  } catch (error) {
    return {
      ok: false,
      model: PROBE_MODEL,
      latencyMs: Date.now() - startedAt,
      error: 'MiniMax Code could not be reached: ' + (error instanceof Error ? error.message : String(error)),
    }
  }
}

/**
 * Non-streaming Messages call, used by callers that want the body rather than a stream.
 *
 * It exists so the streaming path is not the only implementation of the request
 * shape: the probe and any future test use the same headers and URL builder, which
 * is what keeps the Bearer rule from drifting in a second place.
 */
export async function createMessage(
  store: MinimaxCodeCredentialStore,
  request: { model: string; maxTokens: number; prompt: string },
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; status: number; payload?: unknown; error?: string; latencyMs: number }> {
  const fetchFn = options.fetchFn ?? fetch
  const startedAt = Date.now()
  let credentials: MinimaxCodeCredentials
  try {
    credentials = await ensureAccessToken(store, { fetchFn, signal: options.signal })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const response = await fetchFn(messagesUrl(credentials.region), {
      method: 'POST',
      headers: probeRequestHeaders(credentials.accessToken),
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: [{ role: 'user', content: request.prompt }],
      }),
      signal: withTimeout(options.signal, PROBE_TIMEOUT_MS),
    })
    const payload: unknown = await response.json().catch(() => undefined)
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      ...(payload === undefined ? {} : { payload }),
      ...(response.ok ? {} : { error: summarizeFailureBody(JSON.stringify(payload ?? '')) }),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Every model id the hardcoded directory offers.
 *
 * Exposed as a function rather than re-exported directly so the status route
 * cannot accidentally treat the catalog as live data: it is shipped, not fetched.
 */
export function listModelIds(): string[] {
  return minimaxCodeModelIds()
}

/** The catalog entry count, for a status line that reports what is shipped. */
export function catalogSize(): number {
  return MINIMAX_CODE_MODELS.length
}

/**
 * Whether a credential is worth reporting as signed in.
 *
 * A stored-but-expired credential still counts: the card's job is to show who is
 * signed in and let the refresh path repair the token, not to hide an account whose
 * access token happens to have aged out between two calls.
 */
export function describeCredentials(credentials: MinimaxCodeCredentials | null): MinimaxCodeAccount | null {
  return credentials === null ? null : accountFromCredentials(credentials)
}

export { MinimaxCodeUnauthorizedError, agentBaseUrl, MESSAGES_PATH, DEFAULT_DEVICE_INTERVAL_SECONDS, MINIMAX_CODE_BUILD_ENV, redactToken }
export type { MinimaxCodeRegion }
