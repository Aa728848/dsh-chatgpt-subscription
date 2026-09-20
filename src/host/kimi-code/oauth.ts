import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { URLSearchParams } from 'node:url'
import {
  DEFAULT_DEVICE_EXPIRES_SECONDS,
  DEFAULT_DEVICE_INTERVAL_SECONDS,
  DEVICE_AUTHORIZATION_PATH,
  DEVICE_CODE_GRANT_TYPE,
  HEADER_MSH_DEVICE_ID,
  HEADER_MSH_DEVICE_MODEL,
  HEADER_MSH_DEVICE_NAME,
  HEADER_MSH_OS_VERSION,
  HEADER_MSH_PLATFORM,
  HEADER_MSH_VERSION,
  KIMI_CODE_CLIENT_ID,
  LOGIN_TIMEOUT_MS,
  MIN_REFRESH_THRESHOLD_SECONDS,
  MSH_PLATFORM,
  MSH_VERSION,
  OAUTH_TOKEN_PATH,
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_MAX_RETRIES,
  REFRESH_THRESHOLD_RATIO,
  UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_MS,
  USER_AGENT,
  codingBaseUrl,
  oauthHost,
} from './types.ts'
import {
  FileCredentialStore,
  deviceIdPath,
  persistRegion,
  resolveRegion,
  type KimiCodeCredentials,
} from './token-store.ts'
import type { KimiCodeLoginFlowStatus, KimiCodeRegion } from '../../shared/kimi-code-contracts.ts'

/** Request timeout for every OAuth call, mirroring the official client. */
const OAUTH_TIMEOUT_MS = 30_000

/**
 * HTTP statuses a refresh treats as transient.
 *
 * A 429 or any 5xx says nothing about the refresh token itself — the endpoint
 * is busy or briefly broken — so the same token is worth retrying. 401/403 and
 * an `invalid_grant` body are the only verdicts that the token is dead.
 */
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504])

/** Raised when the stored refresh token was rejected and a new login is required. */
export class KimiCodeUnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KimiCodeUnauthorizedError'
  }
}

/** Raised when a transient failure outlived its retry budget. */
export class KimiCodeRetryableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'KimiCodeRetryableError'
  }
}

/** Raised when the user denied the device authorization request. */
export class KimiCodeAccessDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KimiCodeAccessDeniedError'
  }
}

/**
 * Process-wide tombstone for refresh tokens the server has already rejected.
 *
 * Credentials are a process-wide resource, so every component that refreshes
 * them must see the same "recently rejected" verdict; without this, one
 * caller's rejection would be re-discovered by the next one and the account
 * would be hammered with requests that can never succeed.
 */
const rejectedRefreshTokens = new Map<string, number>()

function rememberRejected(refreshToken: string): void {
  rejectedRefreshTokens.set(refreshToken, Date.now() + UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_MS)
}

function isRecentlyRejected(refreshToken: string): boolean {
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

/**
 * Whether the given refresh token was recently rejected by the service.
 *
 * The settings card uses this to say "sign in again" instead of showing an
 * account that merely looks signed in while every call is failing.
 */
export function isRefreshTokenRejected(refreshToken: string): boolean {
  return isRecentlyRejected(refreshToken)
}

/** Printable-ASCII header value; a value with nothing left is omitted. */
function asciiHeaderValue(value: string): string | undefined {
  const printable = value.replace(/[^\x20-\x7E]/g, '').trim()
  return printable === '' ? undefined : printable
}

/** Best-effort human description of this machine, matching the official client. */
function deviceModel(): string {
  const arch = os.arch()
  const release = os.release()
  const platform = process.platform
  if (platform === 'win32') {
    // Node reports the Windows kernel version (10.0.x) rather than the
    // marketing release, so the build number decides 10 vs 11.
    const build = Number(release.split('.')[2] ?? '0')
    const name = build >= 22000 ? 'Windows 11' : 'Windows 10'
    return `${name} ${arch}`
  }
  if (platform === 'darwin') return `macOS ${release} ${arch}`
  return `${platform} ${release} ${arch}`
}

/**
 * Read the stable device id, creating it exactly once.
 *
 * The managed service treats this as the installation's identity. It is not a
 * secret; it only has to stay stable, so a failed write degrades to a
 * per-process value instead of failing the login.
 */
export async function getDeviceId(): Promise<string> {
  const file = deviceIdPath()
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // Missing file: fall through and create one.
  }
  const created = randomUUID()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, created, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // A read-only home directory still gets a usable, if unstable, id.
  }
  return created
}

/** Identity headers every Kimi Code OAuth and account request carries. */
export async function kimiIdentityHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const deviceId = await getDeviceId()
  const candidates: Array<[string, string | undefined]> = [
    ['user-agent', `${USER_AGENT} ${MSH_PLATFORM}/${MSH_VERSION}`],
    [HEADER_MSH_PLATFORM, MSH_PLATFORM],
    [HEADER_MSH_VERSION, MSH_VERSION],
    [HEADER_MSH_DEVICE_NAME, os.hostname()],
    [HEADER_MSH_DEVICE_MODEL, deviceModel()],
    [HEADER_MSH_OS_VERSION, os.release()],
    [HEADER_MSH_DEVICE_ID, deviceId],
  ]
  const headers: Record<string, string> = {}
  for (const [name, value] of candidates) {
    if (value === undefined) continue
    const safe = asciiHeaderValue(value)
    if (safe !== undefined) headers[name] = safe
  }
  return { ...headers, ...extra }
}

/**
 * Combine a caller signal with a hard local timeout.
 *
 * `AbortSignal.any` keeps whichever fires first, so an abandoned login stops
 * promptly while a hung endpoint still cannot hold the request forever.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function oauthEndpoint(host: string, endpoint: string): string {
  return `${host.replace(/\/+$/, '')}${endpoint}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read the error fields one OAuth failure body may carry.
 *
 * The service has answered in both a flat shape (`{error, error_description}`)
 * and a nested one (`{error:{message,code}}`), so both are unwrapped before the
 * caller decides whether the flow continues.
 */
function oauthErrorFields(payload: unknown): { code: string; description: string } {
  const root = asRecord(payload) ?? {}
  const nested = asRecord(root.error)
  if (nested !== undefined) {
    const code = typeof nested.code === 'string' ? nested.code : ''
    const description = String(nested.message ?? nested.error_description ?? nested.detail ?? nested.type ?? '')
    return { code, description }
  }
  return {
    code: typeof root.error === 'string' ? root.error : '',
    description: String(root.error_description ?? root.error_message ?? ''),
  }
}

/** Parsed device authorization response. */
export interface DeviceAuthorization {
  userCode: string
  deviceCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

/**
 * Start a device authorization (RFC 8628 section 3.1).
 *
 * A public client sends only its `client_id`; no scope, no PKCE.
 */
export async function requestDeviceAuthorization(options: {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  region?: KimiCodeRegion
} = {}): Promise<{ authorization: DeviceAuthorization; host: string }> {
  const fetchFn = options.fetchFn ?? fetch
  const region = options.region ?? await resolveRegion()
  const host = oauthHost(region)
  const response = await fetchFn(oauthEndpoint(host, DEVICE_AUTHORIZATION_PATH), {
    method: 'POST',
    headers: await kimiIdentityHeaders({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }),
    body: new URLSearchParams({ client_id: KIMI_CODE_CLIENT_ID }).toString(),
    signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const { description } = oauthErrorFields(payload)
    throw new Error(`Device authorization failed (${response.status})${description ? `: ${description}` : ''}`)
  }

  const record = asRecord(payload) ?? {}
  const userCode = typeof record.user_code === 'string' ? record.user_code : ''
  const deviceCode = typeof record.device_code === 'string' ? record.device_code : ''
  const complete = typeof record.verification_uri_complete === 'string' ? record.verification_uri_complete : ''
  if (userCode === '' || deviceCode === '' || complete === '') {
    throw new Error('Device authorization response did not carry a device code and verification URL')
  }

  const expiresIn = Number(record.expires_in)
  const interval = Number(record.interval)
  return {
    host,
    authorization: {
      userCode,
      deviceCode,
      verificationUri: typeof record.verification_uri === 'string' ? record.verification_uri : '',
      verificationUriComplete: complete,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_DEVICE_EXPIRES_SECONDS,
      interval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DEVICE_INTERVAL_SECONDS,
    },
  }
}

/** Outcome of one device-token poll. */
type PollOutcome =
  | { kind: 'success'; token: OAuthToken }
  | { kind: 'pending'; slowDown: boolean }
  | { kind: 'expired' }

/**
 * Poll the token endpoint once for a device code (RFC 8628 section 3.4).
 *
 * A 5xx is a transport-class failure rather than a verdict on the device code,
 * so it is raised for the caller's retry/backoff loop instead of being read as
 * "still pending" — treating it as pending would spin against a broken endpoint
 * until the device code expired.
 */
async function pollDeviceToken(
  host: string,
  deviceCode: string,
  options: { fetchFn: typeof fetch; signal?: AbortSignal },
): Promise<PollOutcome> {
  const response = await options.fetchFn(oauthEndpoint(host, OAUTH_TOKEN_PATH), {
    method: 'POST',
    headers: await kimiIdentityHeaders({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    }),
    body: new URLSearchParams({
      client_id: KIMI_CODE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT_TYPE,
    }).toString(),
    signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  const record = asRecord(payload) ?? {}

  if (response.status === 200 && typeof record.access_token === 'string' && record.access_token !== '') {
    return { kind: 'success', token: parseTokenResponse(record) }
  }
  if (response.status >= 500) {
    throw new Error(`Token polling server error: ${response.status}.`)
  }

  const { code, description } = oauthErrorFields(payload)
  if (code === 'authorization_pending') return { kind: 'pending', slowDown: false }
  if (code === 'slow_down') return { kind: 'pending', slowDown: true }
  if (code === 'expired_token') return { kind: 'expired' }
  if (code === 'access_denied') {
    throw new KimiCodeAccessDeniedError(description || 'The authorization request was denied.')
  }
  throw new Error(description || `Token polling failed (${response.status})`)
}

/** Identity claims a Kimi token carries about the signed-in account. */
export interface KimiTokenIdentity {
  userId?: string
  email?: string
}

/**
 * Decode one JWT payload without verifying it.
 *
 * Kimi's access and refresh tokens are JWTs whose payload names the account,
 * and there is NO account-profile endpoint on the coding API — the identity
 * exists only inside the token. The claims are read for display only and the
 * token itself is what authenticates, so no signature check applies here.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1]
  if (payload === undefined || payload === '') return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function claimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Account identity carried by a token pair.
 *
 * `user_id` is preferred across BOTH tokens before `sub` is considered: the two
 * claims share an issuer namespace but `sub` is the weaker one, so a refresh
 * token's `user_id` must beat an access token's `sub`.
 */
export function identityFromTokens(accessToken: string, refreshToken?: string): KimiTokenIdentity {
  const access = decodeJwtPayload(accessToken)
  const refresh = refreshToken === undefined ? undefined : decodeJwtPayload(refreshToken)
  const userId = claimString(access?.user_id)
    ?? claimString(refresh?.user_id)
    ?? claimString(access?.sub)
    ?? claimString(refresh?.sub)
  const email = (claimString(access?.email) ?? claimString(refresh?.email))?.toLowerCase()
  return {
    ...(userId === undefined ? {} : { userId }),
    ...(email === undefined ? {} : { email }),
  }
}

/** OAuth token response, in the shape the rest of the plugin stores. */
export interface OAuthToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  expiresIn: number
  scope: string
  tokenType: string
}

function parseTokenResponse(record: Record<string, unknown>): OAuthToken {
  const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : ''
  const expiresIn = Number(record.expires_in)
  if (accessToken === '') throw new Error('Token response is missing its access token')
  if (refreshToken === '') throw new Error('Token response is missing its refresh token')
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Token response carried an invalid lifetime')
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    expiresIn,
    scope: typeof record.scope === 'string' ? record.scope : '',
    tokenType: typeof record.token_type === 'string' ? record.token_type : 'Bearer',
  }
}

/** How long before expiry a token must be replaced, from its own lifetime. */
export function refreshThresholdMs(expiresIn: number): number {
  return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO) * 1000
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
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
 * Refresh an access token, with the official client's bounded retry.
 *
 * Only a transient status or a transport failure is retried; a 401/403 (or an
 * `invalid_grant` body) is a verdict that the refresh token is dead and stops
 * immediately, because retrying it can never succeed.
 */
export async function refreshAccessToken(
  refreshToken: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal; host?: string; region?: KimiCodeRegion } = {},
): Promise<OAuthToken> {
  const fetchFn = options.fetchFn ?? fetch
  const region = options.region ?? await resolveRegion()
  const host = options.host ?? oauthHost(region)
  let lastError: unknown

  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchFn(oauthEndpoint(host, OAUTH_TOKEN_PATH), {
        method: 'POST',
        headers: await kimiIdentityHeaders({
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        }),
        body: new URLSearchParams({
          client_id: KIMI_CODE_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        signal: withTimeout(options.signal, OAUTH_TIMEOUT_MS),
      })

      const payload: unknown = await response.json().catch(() => undefined)
      const { code, description } = oauthErrorFields(payload)

      if (response.status === 401 || response.status === 403 || code === 'invalid_grant') {
        throw new KimiCodeUnauthorizedError(description || 'Token refresh was rejected; sign in again.')
      }
      if (response.ok) return parseTokenResponse(asRecord(payload) ?? {})
      if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) {
        throw new Error(description || `Token refresh failed (HTTP ${response.status}).`)
      }
      lastError = new KimiCodeRetryableError(description || `Token refresh failed (HTTP ${response.status}).`)
    } catch (error) {
      // A rejected token is final; every other failure is worth another attempt.
      if (error instanceof KimiCodeUnauthorizedError) throw error
      lastError = error
    }

    if (attempt < REFRESH_MAX_RETRIES - 1) {
      await sleep(REFRESH_BACKOFF_BASE_MS * 2 ** attempt, options.signal)
    }
  }

  throw new KimiCodeRetryableError('Token refresh failed after retries.', lastError)
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/** One in-flight refresh, so concurrent callers share a single request. */
let inFlightRefresh: Promise<KimiCodeCredentials> | null = null

export interface EnsureTokenOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  /** Refresh even when the current token is not near expiry. */
  force?: boolean
}

/**
 * Return a usable access token, refreshing and persisting when needed.
 *
 * Concurrent callers share one refresh request: a subscription is rate limited,
 * and a burst of tool calls at token expiry would otherwise each try to rotate
 * the same refresh token.
 */
export async function ensureAccessToken(
  store: FileCredentialStore,
  options: EnsureTokenOptions = {},
): Promise<KimiCodeCredentials> {
  const credentials = await store.read()
  if (credentials === null) {
    throw new KimiCodeUnauthorizedError('Not signed in to Kimi Code. Sign in from Settings > Kimi Code.')
  }

  const threshold = refreshThresholdMs(credentials.expiresIn)
  if (options.force !== true && credentials.expiresAt - Date.now() > threshold) return credentials

  if (isRecentlyRejected(credentials.refreshToken)) {
    throw new KimiCodeUnauthorizedError('Kimi Code rejected the stored refresh token. Sign in again from Settings > Kimi Code.')
  }

  if (inFlightRefresh !== null) return inFlightRefresh

  const pending = (async (): Promise<KimiCodeCredentials> => {
    try {
      const token = await refreshAccessToken(credentials.refreshToken, {
        fetchFn: options.fetchFn,
        signal: options.signal,
        host: credentials.oauthHost,
        region: credentials.region,
      })
      // A rotated token may carry the identity claims, and a credential stored
      // before those were read has none; refresh is the moment to fill them in.
      const identity = identityFromTokens(token.accessToken, token.refreshToken)
      const next: KimiCodeCredentials = {
        ...credentials,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        expiresIn: token.expiresIn,
        scope: token.scope,
        tokenType: token.tokenType,
        ...(identity.userId === undefined ? {} : { userId: identity.userId }),
        ...(identity.email === undefined ? {} : { email: identity.email }),
      }
      await store.write(next)
      return next
    } catch (error) {
      if (error instanceof KimiCodeUnauthorizedError) {
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

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

let webLoginFlow: KimiCodeLoginFlowStatus = { status: 'idle' }
let activeLoginAbort: AbortController | null = null

export function getWebLoginStatus(): KimiCodeLoginFlowStatus {
  return { ...webLoginFlow }
}

/** Reset the flow so a cancelled attempt cannot keep a later one from starting. */
export function resetWebLogin(): void {
  activeLoginAbort?.abort(new Error('cancelled'))
  activeLoginAbort = null
  webLoginFlow = { status: 'idle' }
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
      }).on('error', () => undefined).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
    }
  } catch {
    // Best effort: the caller always shows the URL so a failed launch is recoverable.
  }
}

/**
 * Run the device-code login to completion and persist the credential.
 *
 * The outer loop implements the RFC 8628 recovery the official client uses: an
 * expired device code is not a fatal error, it restarts the flow with a fresh
 * authorization so a user who took too long still gets in.
 */
async function runDeviceLogin(options: {
  store: FileCredentialStore
  fetchFn: typeof fetch
  region: KimiCodeRegion
  signal: AbortSignal
  open: (url: string) => void
  /** Called with the validated credential so a pool can keep every sign-in. */
  onSave?: (credentials: KimiCodeCredentials) => Promise<unknown>
}): Promise<KimiCodeCredentials> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS

  while (true) {
    const { authorization, host } = await requestDeviceAuthorization({
      fetchFn: options.fetchFn,
      signal: options.signal,
      region: options.region,
    })

    webLoginFlow = {
      status: 'pending',
      verificationUriComplete: authorization.verificationUriComplete,
      verificationUri: authorization.verificationUri,
      userCode: authorization.userCode,
      startedAt: webLoginFlow.startedAt ?? Date.now(),
      expiresAt: Date.now() + authorization.expiresIn * 1000,
      progress: 'Waiting for browser authorization...',
    }
    try {
      options.open(authorization.verificationUriComplete)
    } catch {
      // The card always renders the URL, so a failed launch is recoverable.
    }

    let interval = Math.max(authorization.interval, 1)
    while (true) {
      if (options.signal.aborted) throw new Error('Kimi Code sign-in was cancelled.')
      if (Date.now() > deadline) throw new Error('Kimi Code sign-in timed out.')

      const outcome = await pollDeviceToken(host, authorization.deviceCode, {
        fetchFn: options.fetchFn,
        signal: options.signal,
      })

      if (outcome.kind === 'success') {
        // The token is the only source of the account identity, so it is
        // decoded once here and persisted for the card to render.
        const identity = identityFromTokens(outcome.token.accessToken, outcome.token.refreshToken)
        const credentials: KimiCodeCredentials = {
          accessToken: outcome.token.accessToken,
          refreshToken: outcome.token.refreshToken,
          expiresAt: outcome.token.expiresAt,
          expiresIn: outcome.token.expiresIn,
          scope: outcome.token.scope,
          tokenType: outcome.token.tokenType,
          region: options.region,
          oauthHost: host,
          baseUrl: codingBaseUrl(options.region),
          authenticatedAt: Date.now(),
          ...(identity.userId === undefined ? {} : { userId: identity.userId }),
          ...(identity.email === undefined ? {} : { email: identity.email }),
        }
        await options.store.write(credentials)
        if (options.onSave) await options.onSave(credentials).catch(() => undefined)
        await persistRegion(options.region)
        return credentials
      }

      if (outcome.kind === 'expired') {
        // Not fatal: start over with a fresh device code, exactly as the
        // official CLI does, so a slow user is not locked out.
        webLoginFlow = { ...webLoginFlow, progress: 'Device code expired, restarting sign-in...' }
        break
      }

      // RFC 8628: a slow_down answer permanently widens the polling interval,
      // which is what stops a client from being throttled for polling too fast.
      if (outcome.slowDown) interval += 5
      webLoginFlow = { ...webLoginFlow, progress: 'Waiting for browser authorization...' }
      await sleep(interval * 1000, options.signal)
    }
  }
}

/**
 * Start the browser sign-in.
 *
 * Resolves immediately with the flow state the settings card polls; the device
 * code is fetched, opened, and polled in the background so the HTTP request
 * behind the button never has to stay open for the whole authorization.
 */
export async function beginWebLogin(
  store: FileCredentialStore,
  options: {
    fetchFn?: typeof fetch
    openBrowser?: (url: string) => void
    region?: KimiCodeRegion
    /** Called with the validated credential so a pool can keep every sign-in. */
    onSave?: (credentials: KimiCodeCredentials) => Promise<unknown>
  } = {},
): Promise<KimiCodeLoginFlowStatus> {
  if (webLoginFlow.status === 'pending') return { ...webLoginFlow }

  const fetchFn = options.fetchFn ?? fetch
  const region = options.region ?? await resolveRegion()
  const open = options.openBrowser ?? openBrowser
  const controller = new AbortController()
  activeLoginAbort = controller
  webLoginFlow = { status: 'pending', startedAt: Date.now(), progress: 'Requesting a device code...' }

  void (async () => {
    try {
      await runDeviceLogin({
        store,
        fetchFn,
        region,
        signal: controller.signal,
        open,
        ...(options.onSave === undefined ? {} : { onSave: options.onSave }),
      })
      webLoginFlow = { ...webLoginFlow, status: 'complete', completedAt: Date.now(), progress: 'Signed in' }
      resetRefreshRejections()
    } catch (error) {
      if (controller.signal.aborted) {
        // A cancelled flow is reported as idle so the next attempt starts clean.
        webLoginFlow = { status: 'idle' }
        return
      }
      webLoginFlow = {
        ...webLoginFlow,
        status: 'error',
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (activeLoginAbort === controller) activeLoginAbort = null
    }
  })()

  return { ...webLoginFlow }
}
