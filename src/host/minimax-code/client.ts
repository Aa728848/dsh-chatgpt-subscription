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

import { createHash } from 'node:crypto'
import {
  ANTHROPIC_VERSION,
  DEFAULT_DEVICE_INTERVAL_SECONDS,
  MESSAGES_PATH,
  agentBaseUrl,
  messagesUrl,
  quotaAttributionEnabled,
  quotaHostCandidates,
  tokenPlanRemainsUrl,
  TOKEN_PLAN_REMAINS_PATH,
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
import type {
  MinimaxCodeAccount,
  MinimaxCodeQuota,
  MinimaxCodeQuotaWindow,
  MinimaxCodeRegion,
} from '../../shared/minimax-code-contracts.ts'

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
 * Headers for the Token Plan usage read.
 *
 * NOT {@link modelRequestHeaders}: that set asks for `text/event-stream` because
 * the Messages route streams, and this route answers one JSON document. The
 * credential is still the same bearer token.
 */
export function quotaRequestHeaders(
  accessToken: string,
  pathWithSearch: string,
  requestTime: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + accessToken,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  // OFF by default. See {@link QUOTA_CLIENT_ATTRIBUTION}: these literals tag the
  // request as coming from a first-party MiniMax client, which is exactly what
  // this package's product-token note refuses to do. A user who has read that
  // trade may opt in to get the numbers.
  if (quotaAttributionEnabled()) {
    const second = Math.floor(requestTime / 1_000)
    const md5 = (value: string): string => createHash('md5').update(value).digest('hex')
    headers['content-type'] = 'application/json'
    headers['user-agent'] = 'MiniMaxCode'
    headers.yy = md5(encodeURIComponent(pathWithSearch) + '_{}' + md5(String(requestTime)) + 'ooui')
    headers['x-timestamp'] = String(second)
    headers['x-signature'] = md5(String(second) + FIRST_PARTY_ATTRIBUTION_SECRET)
  }
  return headers
}

/**
 * The literal the official client folds into `x-signature`.
 *
 * Kept as its own constant, and used ONLY when
 * {@link quotaAttributionEnabled} is true, so that the impersonation surface is a
 * single greppable line rather than something woven through the request path.
 * Treat it as a wire constant: the official source notes that changing it needs a
 * coordinated server-side rollout.
 */
const FIRST_PARTY_ATTRIBUTION_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'

/** How long a successful usage snapshot is reused. */
const QUOTA_CACHE_MS = 60_000
/**
 * How long a FAILED usage read is remembered.
 *
 * Deliberately longer than the success TTL: a region whose correct host is not
 * first in the candidate list would otherwise pay a full failed probe on every
 * poll, and the card polls this route. The failure is cached, so the card keeps
 * showing "not available" and the network stays quiet.
 */
const QUOTA_FAILURE_CACHE_MS = 10 * 60_000
/** Local timeout for one usage read. */
const QUOTA_TIMEOUT_MS = 8_000

/**
 * The host that last answered.
 *
 * Only a live call can settle which candidate serves this subscription, so the
 * winner is remembered and probed first from then on.
 */
/**
 * Why a usage snapshot is absent, when the reason is worth stating on the card.
 *
 * - `credential-not-accepted` — the endpoint answered, and refused THIS line's
 *   credential because it needs a platform API key. Measured: every candidate
 *   host answers HTTP 200 with `base_resp.status_code: 1004` for an
 *   `mcode-public` (MiniMax Code) token, under every auth shape tried.
 * - `unreachable` — no candidate host produced a usable answer at all.
 * - `token-expired` — every candidate refused the bearer with 401/403, and the
 *   one refresh that follows also failed.
 *
 * `token-expired` exists because a refusal and an outage are different facts for
 * the person looking at the card: an outage means "try again in a minute", while a
 * refused bearer means the access token aged out. Collapsing the two into
 * `unreachable` is what made a perfectly healthy account read as signed-out.
 * - `stale` - the newest read failed, but the card is still being served the last
 *   numbers that parsed. The value is real; only its age is not.
 */
export type MinimaxCodeQuotaUnavailable = 'credential-not-accepted' | 'unreachable' | 'token-expired' | 'stale'

let quotaHostInForce: string | null = null
/**
 * The last usage snapshot, plus the last failure to have one.
 *
 * `value` and `reason` are tracked SEPARATELY from the last GOOD value on
 * purpose. A read that fails carries no information about the previous one, so
 * replacing a good snapshot with `null` turned every transient refusal into a
 * visible disappearance of the quota box; `quotaLastGood` lets the card keep
 * showing the last known numbers while saying they are old.
 */
let quotaSnapshot: { at: number; value: MinimaxCodeQuota | null; reason: MinimaxCodeQuotaUnavailable | null } | null = null
/** The last snapshot that actually parsed, kept across failures. */
let quotaLastGood: { value: MinimaxCodeQuota; at: number } | null = null

/** How long a refused credential is remembered before asking again. */
const QUOTA_REJECTED_CACHE_MS = 30 * 60_000

/** Forget the cached usage snapshot (a sign-out, a sign-in, a test). */
export function clearCachedQuota(): void {
  quotaSnapshot = null
  quotaLastGood = null
  quotaHostInForce = null
}

/** The last usage snapshot without touching the network. */
export function getCachedQuota(): MinimaxCodeQuota | null {
  return quotaSnapshot?.value ?? null
}

/** Why the last read produced no snapshot, or null when it produced one. */
export function getQuotaUnavailable(): MinimaxCodeQuotaUnavailable | null {
  return quotaSnapshot?.reason ?? null
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the ambiguous `*_usage_count` fields.
 *
 * TRANSCRIBED from the official CLI (`src/utils/quota.ts`), because the ambiguity
 * is real and reading the field naively inverts the bar: older responses report
 * it as a REMAINING count while newer ones report it as a CONSUMED count. When the
 * server also returns an explicit remaining percentage, that percentage selects
 * whichever reading agrees with it; when the counts agree with neither, this
 * returns undefined and the window falls back to the percentage alone rather than
 * inventing a number.
 */
export function resolveQuotaCounts(
  reportedCount: number,
  total: number,
  remainingPercent: number | undefined,
): { used: number; remaining: number; total: number } | undefined {
  if (!Number.isFinite(reportedCount) || !Number.isFinite(total) || total <= 0
    || reportedCount < 0 || reportedCount > total) {
    return undefined
  }
  let remaining = reportedCount
  if (remainingPercent !== undefined && Number.isFinite(remainingPercent)) {
    const asRemaining = (reportedCount / total) * 100
    const asUsed = ((total - reportedCount) / total) * 100
    const closest = Math.min(Math.abs(asRemaining - remainingPercent), Math.abs(asUsed - remainingPercent))
    if (closest > 1) return undefined
    if (Math.abs(asUsed - remainingPercent) < Math.abs(asRemaining - remainingPercent)) {
      remaining = total - reportedCount
    }
  }
  return { used: total - remaining, remaining, total }
}

/** The display multiplier the weekly window carries and the chat window does not. */
function quotaBoostFactor(permille: unknown): number {
  return typeof permille === 'number' && Number.isFinite(permille) && permille > 0 ? permille / 1000 : 1
}

function quotaWindow(input: {
  key: MinimaxCodeQuotaWindow['key']
  reportedCount: number
  total: number
  percent: number | undefined
  resetsAtMs: number | undefined
  boost: number
  unlimited: boolean
}): MinimaxCodeQuotaWindow {
  const resets = input.resetsAtMs === undefined ? {} : { resetsAtMs: input.resetsAtMs }
  if (input.unlimited) return { key: input.key, remainingPercent: null, unlimited: true, ...resets }
  // The service caps a boosted weekly window above 100%, so the ceiling here is
  // 200 rather than 100; clamping at 100 would understate a boosted plan.
  const remainingPercent = input.percent === undefined
    ? (input.total > 0 ? Math.min(200, (input.reportedCount / input.total) * 100 * input.boost) : null)
    : Math.min(200, input.percent * input.boost)
  const counts = resolveQuotaCounts(input.reportedCount, input.total, input.percent)
  return {
    key: input.key,
    remainingPercent,
    ...(counts === undefined ? {} : { used: counts.used, total: counts.total }),
    ...(remainingPercent === null ? {} : { usedPercent: Math.max(0, 100 - remainingPercent) }),
    ...resets,
  }
}

/**
 * Map one `/v1/token_plan/remains` document onto the card's quota shape.
 *
 * Returns null when nothing usable is present, which the contract defines as the
 * card's graceful degradation.
 */
export function parseTokenPlanQuota(payload: unknown, now: number = Date.now()): MinimaxCodeQuota | null {
  const rows = asRecord(payload)?.model_remains
  if (!Array.isArray(rows)) return null
  const entries: Array<{ name: string; windows: MinimaxCodeQuotaWindow[] }> = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === undefined) continue
    const name = typeof row.model_name === 'string' && row.model_name !== '' ? row.model_name : 'quota'
    const intervalTotal = numberOr(row.current_interval_total_count, 0)
    const weeklyTotal = numberOr(row.current_weekly_total_count, 0)
    const intervalStatus = numberOr(row.current_interval_status, 0)
    const weeklyStatus = numberOr(row.current_weekly_status, 0)
    // Status 3 means "unlimited" — EXCEPT when both totals are zero, where the
    // service reuses it for a model with no quota bucket in the current plan.
    // Rendering that as an unlimited bar would promise quota the user does not
    // have. (The official CLI calls this case out explicitly.)
    if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === 3 && weeklyStatus === 3) continue
    entries.push({
      name,
      windows: [
        quotaWindow({
          key: 'interval',
          reportedCount: numberOr(row.current_interval_usage_count, 0),
          total: intervalTotal,
          percent: optionalNumber(row.current_interval_remaining_percent),
          resetsAtMs: optionalNumber(row.end_time),
          boost: 1,
          unlimited: intervalStatus === 3,
        }),
        quotaWindow({
          key: 'weekly',
          reportedCount: numberOr(row.current_weekly_usage_count, 0),
          total: weeklyTotal,
          percent: optionalNumber(row.current_weekly_remaining_percent),
          resetsAtMs: optionalNumber(row.weekly_end_time),
          boost: quotaBoostFactor(row.weekly_boost_permille),
          unlimited: weeklyStatus === 3,
        }),
      ],
    })
  }
  if (entries.length === 0) return null
  // `general` is the bucket that covers chat and coding. The others (video, …) are
  // separate resources whose numbers would make a single headline bar meaningless.
  const primary = entries.find((entry) => entry.name === 'general') ?? entries[0]!
  const head = primary.windows[0]!
  return {
    label: 'Token Plan',
    ...(head.usedPercent === undefined ? {} : { usedPercent: head.usedPercent }),
    ...(head.resetsAtMs === undefined ? {} : { resetsAtMs: head.resetsAtMs }),
    windows: primary.windows,
    fetchedAtMs: now,
  }
}

/**
 * Read the Token Plan usage snapshot.
 *
 * The endpoint is undocumented (it was found in the official CLI, not in MiniMax's
 * API docs), and which host serves THIS subscription has never been measured, so
 * the candidates are tried in order and the winner is remembered. Any failure
 * yields null: the contract makes `quota` optional precisely so a usage read can
 * never break the connection half of the card.
 */
export async function fetchTokenPlanQuota(
  credentials: MinimaxCodeCredentials,
  options: {
    fetchFn?: typeof fetch
    signal?: AbortSignal
    force?: boolean
    /**
     * Renew the credential and hand back the pair to retry with.
     *
     * Injected by the route, which owns the store: this module reads credentials,
     * it does not write them. Returns null when the credential cannot be renewed,
     * and callers treat that as "still expired" rather than "signed out".
     */
    renewCredential?: () => Promise<MinimaxCodeCredentials | null>
    /**
     * Whether the credential this read presented has already been replaced.
     *
     * Set by the caller, which can see the credential in force. A 401 that arrives
     * for a token that is no longer current is not a verdict on the account, and
     * reporting it as `token-expired` would put "sign in again" on a card whose
     * sign-in is in perfect health.
     */
    isCredentialStale?: () => Promise<boolean>
  } = {},
): Promise<MinimaxCodeQuota | null> {
  const fetchFn = options.fetchFn ?? fetch
  const now = Date.now()
  if (options.force !== true && quotaSnapshot !== null) {
    // A refused credential is not worth re-asking on the success cadence: the
    // verdict is about the KIND of credential this line holds, so it will not
    // change by trying again in a minute.
    //
    // `token-expired` IS worth re-asking promptly, and only the absence of a
    // previous snapshot buys it the failure backoff. A token that aged out is
    // repaired by the very next poll, and a user watching a quota box at the
    // one-hour boundary needs that repair to show up now - not ten minutes later.
    // With nothing good left to render there is no progress to suppress either.
    const ttl = quotaSnapshot.reason === 'credential-not-accepted'
      ? QUOTA_REJECTED_CACHE_MS
      : quotaSnapshot.reason === 'token-expired' && quotaSnapshot.value === null
        ? QUOTA_FAILURE_CACHE_MS
        : quotaSnapshot.value === null ? QUOTA_FAILURE_CACHE_MS : QUOTA_CACHE_MS
    if (now - quotaSnapshot.at < ttl) return quotaSnapshot.value
  }
  const candidates = quotaHostCandidates(credentials.region)
  const ordered = quotaHostInForce === null
    ? candidates
    : [quotaHostInForce, ...candidates.filter((host) => host !== quotaHostInForce)]
  let value: MinimaxCodeQuota | null = null
  let reason: MinimaxCodeQuotaUnavailable | null = null
  // Set when a candidate refused the BEARER rather than the host. That verdict is
  // about the credential and is identical on every candidate, so it must not be
  // answered by walking the rest of the list.
  let authRefused = false
  for (const host of ordered) {
    try {
      const remainsPath = TOKEN_PLAN_REMAINS_PATH
      const response = await fetchFn(tokenPlanRemainsUrl(host), {
        method: 'GET',
        headers: quotaRequestHeaders(credentials.accessToken, remainsPath),
        signal: withTimeout(options.signal, QUOTA_TIMEOUT_MS),
      })
      // A 401/403 is the upstream saying the ACCESS TOKEN is no longer accepted —
      // which is the normal state of this credential at the one-hour boundary, not
      // a wrong host. Treating it like a 404 walked the remaining candidates,
      // produced nothing, and reported a healthy signed-in account as unusable.
      // `renewQuotaCredential` is asked for a token the caller can actually use
      // and the read is retried once with it.
      if (response.status === 401 || response.status === 403) {
        // The ONE case where a refused bearer is not a credential problem: a read
        // that started before a rotation and landed after it carries a token the
        // service has already stopped accepting, and the credential in force is
        // fine. The caller can say so, and then the honest verdict is "no numbers
        // this round" rather than "sign in again" — a card must never talk somebody
        // into a sign-in they do not need.
        if ((await options.isCredentialStale?.()) === true) return null
        authRefused = true
        break
      }
      if (!response.ok) continue
      const payload: unknown = await response.json().catch(() => undefined)
      // The platform endpoint answers HTTP 200 even when it REFUSES the caller,
      // putting the verdict in `base_resp`. Treating `ok` as success would keep
      // walking the remaining candidates for a verdict that is identical on every
      // host, and would leave the card unable to say why nothing was shown.
      const base = asRecord(asRecord(payload)?.base_resp)
      if (numberOr(base?.status_code, 0) !== 0) {
        reason = 'credential-not-accepted'
        break
      }
      const parsed = parseTokenPlanQuota(payload)
      if (parsed === null) continue
      quotaHostInForce = host
      value = parsed
      reason = null
      break
    } catch {
      // An unreachable or wrong host is simply not the right candidate; the next
      // one is tried and a total failure leaves the card degraded.
    }
  }

  // The one thing a refused bearer earns is a fresh token and a second attempt.
  // `renewQuotaCredential` is injected rather than called directly so this
  // function keeps its signature for the sibling quota tests.
  if (value === null && authRefused && options.renewCredential !== undefined) {
    const renewed = await options.renewCredential().catch(() => null)
    if (renewed !== null && renewed.accessToken !== credentials.accessToken) {
      return fetchTokenPlanQuota(renewed, { ...options, force: true })
    }
  }

  if (value === null && reason === null) reason = authRefused ? 'token-expired' : 'unreachable'
  if (value !== null) {
    quotaLastGood = { value, at: Date.now() }
  } else if (quotaLastGood !== null) {
    // Keep serving the last numbers that parsed. A failure says nothing about the
    // previous read, so discarding a good snapshot here is what made the quota box
    // vanish at the one-hour boundary and take the whole card's credibility with
    // it. The card is told separately that they are old.
    value = quotaLastGood.value
    reason = 'stale'
  }
  quotaSnapshot = { at: Date.now(), value, reason }
  return value
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
