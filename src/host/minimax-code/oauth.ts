/**
 * OAuth for the MiniMax Code subscription.
 *
 * The flow is RFC 8628 device authorization with PKCE(S256) against a public
 * client (`mcode-public`, no secret) — the shape the desktop app uses, and the
 * only one that fits a plugin with no browser callback to receive.
 *
 * Measured facts that shape this file (brief section 2.5):
 *
 * - device authorization: POST `account.minimax.cn/oauth2/device/code`
 * - token (device grant AND refresh): POST `account.minimax.cn/oauth2/token`
 * - revocation: POST `account.minimax.cn/oauth2/revoke`
 * - every call is `application/x-www-form-urlencoded` with `Accept: application/json`
 * - the device grant carries `code_challenge`/`code_challenge_method=S256` and the
 *   poll carries the matching `code_verifier`
 * - the refresh carries `grant_type=refresh_token`, `refresh_token`, `client_id`,
 *   `scope` and `audience`
 *
 * The refresh policy is the one the brief fixes at section 2.6: read the stored
 * credential first and use it while it is valid, refresh only when it is not (or
 * when the service has just rejected it), write the rotation back atomically, and
 * never let a failed refresh damage the file MiniMax Code itself depends on.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { URLSearchParams } from 'node:url'
import type { MinimaxCodeAccount, MinimaxCodeRegion, MinimaxCodeWebLogin } from '../../shared/minimax-code-contracts.ts'
import {
  DEFAULT_DEVICE_EXPIRES_SECONDS,
  DEFAULT_DEVICE_INTERVAL_SECONDS,
  DEVICE_CODE_GRANT_TYPE,
  DEVICE_CODE_PATH,
  LOGIN_TIMEOUT_MS,
  MINIMAX_CODE_AUDIENCE,
  MINIMAX_CODE_CLIENT_ID,
  MINIMAX_CODE_SCOPE,
  OAUTH_REVOKE_PATH,
  OAUTH_TIMEOUT_MS,
  OAUTH_TOKEN_PATH,
  PKCE_CHALLENGE_METHOD,
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_MAX_RETRIES,
  RETRYABLE_REFRESH_STATUSES,
  accountHost,
  oauthUrl,
  redactToken,
  MINIMAX_CODE_BUILD_ENV,
} from './types.ts'
import {
  credentialIsFresh,
  type MinimaxCodeCredentialStore,
  type MinimaxCodeCredentials,
} from './token-store.ts'

/** Raised when the stored credential was rejected and a new sign-in is required. */
export class MinimaxCodeUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MinimaxCodeUnauthorizedError'
  }
}

/** Raised when a transient failure outlived its retry budget. */
export class MinimaxCodeRetryableError extends Error {
  // The cause travels through the standard Error options bag rather than a
  // parameter property, which Node's type-stripping loader rejects.
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MinimaxCodeRetryableError'
  }
}

/** Raised when the user denied the device authorization request. */
export class MinimaxCodeAccessDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MinimaxCodeAccessDeniedError'
  }
}

const OAUTH_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'content-type': 'application/x-www-form-urlencoded',
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the error code/description one OAuth failure body carries.
 *
 * The endpoints answer in the RFC 6749 shape (`error` + `error_description`) and
 * the desktop app's own core also accepts a nested `{error:{code,message}}`, so
 * both are unwrapped before the caller decides what the failure means.
 */
function oauthErrorFields(payload: unknown): { code: string; description: string } {
  const root = asRecord(payload) ?? {}
  const nested = asRecord(root.error)
  if (nested !== undefined) {
    return {
      code: asString(nested.code) ?? '',
      description: String(nested.message ?? nested.error_description ?? nested.detail ?? nested.type ?? ''),
    }
  }
  return {
    code: asString(root.error) ?? '',
    description: String(root.error_description ?? root.error_message ?? ''),
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** Bytes of entropy behind one PKCE verifier. 32 bytes is well above the RFC 7636 minimum. */
const PKCE_VERIFIER_BYTES = 32

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/**
 * One PKCE pair (RFC 7636).
 *
 * The verifier is a fresh random string per authorization; the challenge is its
 * SHA-256 digest, both base64url encoded with no padding, which is what S256
 * means on the wire.
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(PKCE_VERIFIER_BYTES))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// ---------------------------------------------------------------------------
// Device authorization
// ---------------------------------------------------------------------------

/** Parsed device authorization response. */
export interface DeviceAuthorization {
  userCode: string
  deviceCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
  /** PKCE verifier the matching poll must present. */
  codeVerifier: string
  /** Region the authorization was requested in; decides every later host. */
  region: MinimaxCodeRegion
}

/**
 * Start a device authorization (RFC 8628 section 3.1).
 *
 * A public client sends its `client_id`, the scope and audience it wants, and the
 * PKCE challenge — no secret, which is the whole point of the device profile.
 */
export async function requestDeviceAuthorization(options: {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  region?: MinimaxCodeRegion
} = {}): Promise<DeviceAuthorization> {
  const fetchFn = options.fetchFn ?? fetch
  const region = options.region ?? 'cn'
  const pkce = createPkcePair()
  const response = await fetchFn(oauthUrl(region, DEVICE_CODE_PATH), {
    method: 'POST',
    headers: OAUTH_HEADERS,
    body: new URLSearchParams({
      client_id: MINIMAX_CODE_CLIENT_ID,
      scope: MINIMAX_CODE_SCOPE,
      audience: MINIMAX_CODE_AUDIENCE,
      code_challenge: pkce.challenge,
      code_challenge_method: PKCE_CHALLENGE_METHOD,
    }).toString(),
    signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const { description } = oauthErrorFields(payload)
    throw new Error(
      'MiniMax Code device authorization failed (' + response.status + ')'
      + (description === '' ? '' : ': ' + description),
    )
  }

  const record = asRecord(payload) ?? {}
  const userCode = asString(record.user_code)
  const deviceCode = asString(record.device_code)
  if (userCode === undefined || deviceCode === undefined) {
    throw new Error('MiniMax Code device authorization response carried no device code or user code')
  }
  const expiresIn = Number(record.expires_in)
  const interval = Number(record.interval)
  const verificationUri = asString(record.verification_uri) ?? ''
  return {
    userCode,
    deviceCode,
    verificationUri,
    verificationUriComplete: asString(record.verification_uri_complete) ?? verificationUri,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_DEVICE_EXPIRES_SECONDS,
    interval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DEVICE_INTERVAL_SECONDS,
    codeVerifier: pkce.verifier,
    region,
  }
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

/** One token response, in the shape the store persists. */
export interface MinimaxToken {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresInSec: number
  expiresAtMs: number
  scope: string
}

function parseTokenResponse(record: Record<string, unknown>): MinimaxToken {
  const accessToken = asString(record.access_token)
  if (accessToken === undefined) throw new Error('MiniMax Code token response is missing its access token')
  const refreshToken = asString(record.refresh_token)
  if (refreshToken === undefined) throw new Error('MiniMax Code token response is missing its refresh token')
  const expiresIn = Number(record.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('MiniMax Code token response carried an invalid lifetime')
  }
  return {
    accessToken,
    refreshToken,
    tokenType: asString(record.token_type) ?? 'Bearer',
    expiresInSec: expiresIn,
    expiresAtMs: Date.now() + expiresIn * 1000,
    scope: asString(record.scope) ?? MINIMAX_CODE_SCOPE,
  }
}

/** Outcome of one device-token poll. */
export type DevicePollOutcome =
  | { kind: 'success'; token: MinimaxToken }
  | { kind: 'pending'; slowDown: boolean }
  | { kind: 'expired' }

/**
 * Poll the token endpoint once for one device code (RFC 8628 section 3.4).
 *
 * A 5xx is a transport-class failure rather than a verdict on the device code, so
 * it is raised for the caller's retry loop instead of being read as "still
 * pending" — treating it as pending would spin against a broken endpoint until the
 * device code expired.
 */
export async function pollDeviceToken(
  authorization: Pick<DeviceAuthorization, 'deviceCode' | 'codeVerifier' | 'region'>,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DevicePollOutcome> {
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(oauthUrl(authorization.region, OAUTH_TOKEN_PATH), {
    method: 'POST',
    headers: OAUTH_HEADERS,
    body: new URLSearchParams({
      client_id: MINIMAX_CODE_CLIENT_ID,
      device_code: authorization.deviceCode,
      code_verifier: authorization.codeVerifier,
      grant_type: DEVICE_CODE_GRANT_TYPE,
    }).toString(),
    signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  const record = asRecord(payload) ?? {}
  if (response.ok && asString(record.access_token) !== undefined) {
    return { kind: 'success', token: parseTokenResponse(record) }
  }
  if (response.status >= 500) {
    throw new MinimaxCodeRetryableError('MiniMax Code token polling server error: ' + response.status + '.')
  }

  const { code, description } = oauthErrorFields(payload)
  if (code === 'authorization_pending') return { kind: 'pending', slowDown: false }
  if (code === 'slow_down') return { kind: 'pending', slowDown: true }
  if (code === 'expired_token') return { kind: 'expired' }
  if (code === 'access_denied') {
    throw new MinimaxCodeAccessDeniedError(description || 'The authorization request was denied.')
  }
  throw new Error(description || 'MiniMax Code token polling failed (' + response.status + ')')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Refresh an access token, with a bounded retry.
 *
 * Only a transient status or a transport failure is retried. A 400/401/403, or an
 * `invalid_grant` body, is a verdict that the refresh token is dead and stops
 * immediately: retrying it can never succeed, and every attempt is a request the
 * subscription pays for.
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal; region: MinimaxCodeRegion },
): Promise<MinimaxToken> {
  const fetchFn = options.fetchFn ?? fetch
  let lastError: unknown

  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchFn(oauthUrl(options.region, OAUTH_TOKEN_PATH), {
        method: 'POST',
        headers: OAUTH_HEADERS,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: MINIMAX_CODE_CLIENT_ID,
          scope: MINIMAX_CODE_SCOPE,
          audience: MINIMAX_CODE_AUDIENCE,
        }).toString(),
        signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
      })

      const payload: unknown = await response.json().catch(() => undefined)
      const { code, description } = oauthErrorFields(payload)
      if (response.status === 400 || response.status === 401 || response.status === 403
        || code === 'invalid_grant' || code === 'invalid_client') {
        throw new MinimaxCodeUnauthorizedError(
          'MiniMax Code rejected the stored refresh token ' + redactToken(refreshToken) + '. '
          + 'Sign in again in MiniMax Code, then reopen this card.',
        )
      }
      if (response.ok) return parseTokenResponse(asRecord(payload) ?? {})
      if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) {
        throw new MinimaxCodeRetryableError(
          description || 'MiniMax Code token refresh failed (HTTP ' + response.status + ').',
        )
      }
      lastError = new MinimaxCodeRetryableError(
        description || 'MiniMax Code token refresh failed (HTTP ' + response.status + ').',
      )
    } catch (error) {
      // A rejected token is final; every other failure is worth another attempt.
      if (error instanceof MinimaxCodeUnauthorizedError) throw error
      lastError = error
    }

    if (attempt < REFRESH_MAX_RETRIES - 1) {
      await sleep(REFRESH_BACKOFF_BASE_MS * 2 ** attempt, options.signal)
    }
  }

  throw new MinimaxCodeRetryableError('MiniMax Code token refresh failed after retries.', lastError)
}

/**
 * Revoke one token at the service.
 *
 * Best effort by design: a revocation that cannot reach the service must not stop
 * a local sign-out, because the credential is already gone from this machine.
 */
export async function revokeToken(
  token: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal; region: MinimaxCodeRegion },
): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch
  try {
    const response = await fetchFn(oauthUrl(options.region, OAUTH_REVOKE_PATH), {
      method: 'POST',
      headers: OAUTH_HEADERS,
      body: new URLSearchParams({
        client_id: MINIMAX_CODE_CLIENT_ID,
        token,
        token_type_hint: 'refresh_token',
      }).toString(),
      signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Login sessions
// ---------------------------------------------------------------------------

/**
 * One in-flight device-authorization session.
 *
 * The card drives the flow with an explicit poll (the route contract has
 * `/login/poll`), so the session is state the host holds between two requests
 * rather than a background loop: a host that looped on its own would keep polling
 * after the user closed the settings panel.
 */
interface LoginSession {
  loginId: string
  authorization: DeviceAuthorization
  createdAt: number
  deadline: number
  /** Polling interval, widened by `slow_down` exactly as RFC 8628 requires. */
  intervalSec: number
  /** Earliest instant the next poll may be attempted, so a hot loop is refused. */
  nextPollAt: number
  consumed: boolean
}

const loginSessions = new Map<string, LoginSession>()

/** Drop sessions that have outlived their device code. */
function pruneLoginSessions(now: number = Date.now()): void {
  for (const [loginId, session] of loginSessions) {
    if (session.deadline <= now) loginSessions.delete(loginId)
  }
}

/** Start a device-code sign-in and hand the card what it must display. */
export async function beginWebLogin(options: {
  fetchFn?: typeof fetch
  region?: MinimaxCodeRegion
  signal?: AbortSignal
} = {}): Promise<MinimaxCodeWebLogin> {
  const authorization = await requestDeviceAuthorization(options)
  const now = Date.now()
  pruneLoginSessions(now)
  const loginId = randomUUID()
  loginSessions.set(loginId, {
    loginId,
    authorization,
    createdAt: now,
    deadline: Math.min(now + authorization.expiresIn * 1000, now + LOGIN_TIMEOUT_MS),
    intervalSec: Math.max(authorization.interval, 1),
    nextPollAt: now,
    consumed: false,
  })
  return {
    loginId,
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUriComplete || authorization.verificationUri,
    expiresInSec: authorization.expiresIn,
  }
}

/** The public projection of one live sign-in, for the status route. */
export function getWebLogin(loginId: string): MinimaxCodeWebLogin | null {
  const session = loginSessions.get(loginId)
  if (session === undefined) return null
  return {
    loginId: session.loginId,
    userCode: session.authorization.userCode,
    verificationUri: session.authorization.verificationUriComplete || session.authorization.verificationUri,
    expiresInSec: Math.max(0, Math.round((session.deadline - Date.now()) / 1000)),
  }
}

/** Cancel one sign-in, dropping the session so a later poll cannot resume it. */
export function cancelWebLogin(loginId: string): boolean {
  return loginSessions.delete(loginId)
}

/** Forget every session; used by the test seam and by a full sign-out. */
export function resetWebLogins(): void {
  loginSessions.clear()
}

/** Build the account projection one credential yields. */
export function accountFromCredentials(
  credentials: { loginEpoch: string; generation: number; expiresAtMs: number; region: MinimaxCodeRegion },
): MinimaxCodeAccount {
  const suffix = credentials.loginEpoch !== '' ? credentials.loginEpoch : 'gen-' + credentials.generation
  return {
    id: 'mcode-public/' + credentials.region + '/' + suffix,
    label: 'MiniMax Code \u00b7 ' + credentials.region,
    generation: credentials.generation,
    expiresAtMs: credentials.expiresAtMs,
  }
}

// Export list continues in the token-lifecycle section below.
export { accountHost }
// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/**
 * Process-wide tombstone for refresh tokens the service has already rejected.
 *
 * The credential is a process-wide resource shared with MiniMax Code, so every
 * component that refreshes it must see the same "recently rejected" verdict.
 * Without this, one caller's rejection would be rediscovered by the next one and
 * the account would be hammered with requests that can never succeed.
 */
const rejectedRefreshTokens = new Map<string, number>()

/** How long a rejected refresh token is remembered before another attempt is allowed. */
const UNAUTHORIZED_REFRESH_COOLDOWN_MS = 300_000

function rememberRejected(refreshToken: string): void {
  rejectedRefreshTokens.set(refreshToken, Date.now() + UNAUTHORIZED_REFRESH_COOLDOWN_MS)
}

/** Whether the given refresh token was rejected recently. */
export function isRefreshTokenRejected(refreshToken: string): boolean {
  const until = rejectedRefreshTokens.get(refreshToken)
  if (until === undefined) return false
  if (until <= Date.now()) {
    rejectedRefreshTokens.delete(refreshToken)
    return false
  }
  return true
}

/** Test seam: forget every remembered rejection. */
export function resetRefreshRejections(): void {
  rejectedRefreshTokens.clear()
}

/** One in-flight refresh, so concurrent callers share a single rotation. */
let inFlightRefresh: Promise<MinimaxCodeCredentials> | null = null

export interface EnsureTokenOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Refresh even when the stored token is not near expiry (used after a 401). */
  force?: boolean
}

/** The message a user sees when the credential can no longer be renewed. */
function signInAgainMessage(reason: string): string {
  return reason + ' Sign in again in the MiniMax Code app, then reopen this card.'
}

/**
 * Return a usable access token, refreshing and writing back only when needed.
 *
 * This is the whole of the contention discipline in one function:
 *
 * 1. read the stored credential and use it as-is while it is valid — the
 *    common case, and the one that never touches the file or the network;
 * 2. refresh only when it is not (or when `force` reports a 401 the service has
 *    already issued);
 * 3. share one rotation between concurrent callers, so a burst of tool calls at
 *    expiry cannot each try to rotate the same refresh token;
 * 4. write the result back through the store's atomic replacement, and remember a
 *    rejected token so the next caller is told to sign in instead of retrying.
 */
export async function ensureAccessToken(
  store: MinimaxCodeCredentialStore,
  options: EnsureTokenOptions = {},
): Promise<MinimaxCodeCredentials> {
  const credentials = await store.read()
  if (credentials === null) {
    throw new MinimaxCodeUnauthorizedError(
      signInAgainMessage('Not signed in to MiniMax Code.'),
    )
  }

  if (options.force !== true && credentialIsFresh(credentials)) return credentials

  if (isRefreshTokenRejected(credentials.refreshToken)) {
    throw new MinimaxCodeUnauthorizedError(
      signInAgainMessage('MiniMax Code rejected the stored refresh token ' + redactToken(credentials.refreshToken) + '.'),
    )
  }

  if (inFlightRefresh !== null) return inFlightRefresh

  const pending = (async (): Promise<MinimaxCodeCredentials> => {
    try {
      const token = await refreshAccessToken(credentials.refreshToken, {
        fetchFn: options.fetchFn,
        signal: options.signal,
        region: credentials.region,
      })
      const next: MinimaxCodeCredentials = {
        ...credentials,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        expiresAtMs: token.expiresAtMs,
        // The generation is the desktop app's own rotation counter; advancing it
        // is what keeps the two sides' views of the credential in step.
        generation: credentials.generation + 1,
        seenAt: Date.now(),
      }
      await store.write(next)
      return next
    } catch (error) {
      if (error instanceof MinimaxCodeUnauthorizedError) {
        rememberRejected(credentials.refreshToken)
      }
      throw error
    } finally {
      inFlightRefresh = null
    }
  })()

  inFlightRefresh = pending
  return pending
}

/**
 * Poll one live sign-in once and, on success, persist what it produced.
 *
 * The persisted credential is plugin-owned: a device-code sign-in started here
 * has no record in the desktop app's `auth.json` (its record key embeds a hash
 * this plugin cannot reproduce), so writing a fabricated entry there would leave
 * the app with an entry it never reads.
 */
export async function pollWebLogin(
  store: MinimaxCodeCredentialStore,
  loginId: string,
  options: {
    fetchFn?: typeof fetch
    signal?: AbortSignal
    /**
     * Called with the credential a completed sign-in produced, after it has been
     * persisted.
     *
     * The single-credential store cannot express a second account, so without this
     * a sign-in started from the card would never join the pool: the pool would
     * keep serving its existing accounts, and the user's new sign-in would exist
     * only as the mirror file. The pool installs this hook and adds the credential
     * as its own account.
     *
     * A failure here must not fail the sign-in: the credential is already durable,
     * and the pool is a routing convenience on top of it. The caller receives the
     * authenticated verdict either way.
     */
    onSave?: (credentials: MinimaxCodeCredentials) => Promise<void>
  } = {},
): Promise<{ status: 'pending' | 'authenticated' | 'expired' | 'denied'; account?: MinimaxCodeAccount }> {
  pruneLoginSessions()
  const session = loginSessions.get(loginId)
  if (session === undefined) return { status: 'expired' }
  if (Date.now() >= session.deadline) {
    loginSessions.delete(loginId)
    return { status: 'expired' }
  }
  // A card that polls faster than the interval would earn a `slow_down` and
  // eventually a refusal; the wait is answered as "pending" instead.
  if (Date.now() < session.nextPollAt) return { status: 'pending' }

  let outcome: DevicePollOutcome
  try {
    outcome = await pollDeviceToken(session.authorization, options)
  } catch (error) {
    if (error instanceof MinimaxCodeAccessDeniedError) {
      loginSessions.delete(loginId)
      return { status: 'denied' }
    }
    throw error
  }

  if (outcome.kind === 'expired') {
    loginSessions.delete(loginId)
    return { status: 'expired' }
  }
  if (outcome.kind === 'pending') {
    // RFC 8628: `slow_down` permanently widens the interval, which is what stops
    // a client from being throttled for polling too fast.
    if (outcome.slowDown) session.intervalSec += 5
    session.nextPollAt = Date.now() + session.intervalSec * 1000
    return { status: 'pending' }
  }

  const credentials: MinimaxCodeCredentials = {
    accessToken: outcome.token.accessToken,
    refreshToken: outcome.token.refreshToken,
    tokenType: outcome.token.tokenType,
    clientId: MINIMAX_CODE_CLIENT_ID,
    scopes: [MINIMAX_CODE_SCOPE],
    audience: MINIMAX_CODE_AUDIENCE,
    expiresAtMs: outcome.token.expiresAtMs,
    generation: 1,
    loginEpoch: session.loginId,
    buildEnv: MINIMAX_CODE_BUILD_ENV,
    region: session.authorization.region,
    recordKey: null,
    source: 'file',
    seenAt: Date.now(),
  }
  await store.write(credentials)
  // Hand the credential to the pool before the session is forgotten, so the new
  // account is routable the moment the card re-reads the status. A pool failure is
  // swallowed deliberately: the sign-in itself succeeded.
  if (options.onSave !== undefined) {
    await options.onSave(credentials).catch(() => undefined)
  }
  loginSessions.delete(loginId)
  session.consumed = true
  return { status: 'authenticated', account: accountFromCredentials(credentials) }
}

