/**
 * Cline account sign-in: WorkOS device authorization followed by Cline's token
 * registration, plus the refresh chain.
 *
 * The official clients implement exactly this sequence (Cline repo
 * `sdk/packages/core/src/auth/cline.ts` + `auth/provider-auth-registry.ts`):
 *
 * 1. `POST https://api.workos.com/user_management/authorize/device` with the
 *    public client id → `device_code`, `user_code`, `verification_uri_complete`;
 * 2. the user confirms the code in a browser;
 * 3. `POST https://api.workos.com/user_management/authenticate` polls the device
 *    grant → WorkOS `access_token` / `refresh_token`;
 * 4. `POST {cline}/api/v1/auth/register` exchanges those for Cline's own session
 *    (access, rotating refresh, expiry, user info);
 * 5. later, `POST {cline}/api/v1/auth/refresh` renews it.
 *
 * The chat bearer is `workos:<access>` — the prefix is part of the token the
 * official clients send, not a display detail. See `formatClineApiKey` in the
 * same repo.
 *
 * The constants below are transcribed from
 * `sdk/packages/shared/src/runtime/cline-environment.ts` (production entry).
 *
 * @module dsh-chatgpt-subscription/cline-pass-oauth
 */
import {
  type ClinePassOAuthCredentials,
  jwtExpiryMs,
} from './token-store.ts'
import { DEFAULT_BASE_URL } from './types.ts'

export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
export const CLINE_WORKOS_API_BASE = 'https://api.workos.com'
export const CLINE_WORKOS_DEVICE_PATH = '/user_management/authorize/device'
export const CLINE_WORKOS_AUTHENTICATE_PATH = '/user_management/authenticate'

const DEFAULT_HTTP_TIMEOUT_MS = 30_000
const DEFAULT_DEVICE_EXPIRES_SECONDS = 300
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5
const REFRESH_MARGIN_MS = 5 * 60_000

/** One WorkOS device authorization, as the card renders it. */
export interface ClinePassDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInSeconds: number
  pollIntervalSeconds: number
}

/** A token/refresh failure with the HTTP facts a caller can judge. */
export class ClinePassOAuthError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ClinePassOAuthError'
    this.status = options.status
    this.code = options.code
  }
}

/** Whether a refresh failure means the session is gone and a sign-in is needed. */
export function isClinePassInvalidGrant(error: unknown): boolean {
  if (error instanceof ClinePassOAuthError) {
    if (error.code !== undefined && /invalid_grant|invalid_token|unauthorized/i.test(error.code)) return true
    if (error.status === 400 || error.status === 401 || error.status === 403) {
      return /invalid|expired|revoked|unauthorized|refresh/i.test(error.message)
    }
  }
  return false
}

/** The auth root for one chat base URL. */
export function clineAuthBaseURL(chatBaseURL: string): string {
  const base = String(chatBaseURL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`
}

/** One auth sub-path under the chat base. */
export function clineAuthURL(chatBaseURL: string, path: string): string {
  return `${clineAuthBaseURL(chatBaseURL)}${path.startsWith('/') ? path : `/${path}`}`
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function errorDetails(payload: Record<string, unknown>): { code?: string; message?: string } {
  const error = payload.error
  if (typeof error === 'string') return { code: error, message: nonEmpty(payload.error_description) }
  const nested = payload.error
  if (typeof nested === 'object' && nested !== null) {
    const record = nested as Record<string, unknown>
    return { code: nonEmpty(record.code) ?? nonEmpty(record.type), message: nonEmpty(record.message) ?? nonEmpty(payload.message) }
  }
  const data = payload.data
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>
    return { code: nonEmpty(record.code), message: nonEmpty(record.message) }
  }
  return { message: nonEmpty(payload.message) ?? nonEmpty(payload.error_description) }
}

/** Step 1: ask WorkOS for a device code. */
export async function startClinePassDeviceAuth(
  fetchFn: typeof fetch,
  { signal, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClinePassDeviceAuthorization> {
  const response = await fetchFn(`${CLINE_WORKOS_API_BASE}${CLINE_WORKOS_DEVICE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
    signal: combineSignal(signal, timeoutMs),
  })
  const payload = await readJson(response)
  if (!response.ok) {
    const details = errorDetails(payload)
    throw new ClinePassOAuthError(`Device authorization failed: HTTP ${response.status}${details.message === undefined ? '' : ` - ${details.message}`}`, {
      status: response.status,
      code: details.code,
    })
  }
  const deviceCode = nonEmpty(payload.device_code)
  const userCode = nonEmpty(payload.user_code)
  const verificationUri = nonEmpty(payload.verification_uri)
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new ClinePassOAuthError('WorkOS returned an invalid device authorization')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(nonEmpty(payload.verification_uri_complete) === undefined ? {} : { verificationUriComplete: nonEmpty(payload.verification_uri_complete) }),
    expiresInSeconds: seconds(payload.expires_in, DEFAULT_DEVICE_EXPIRES_SECONDS),
    pollIntervalSeconds: seconds(payload.interval, DEFAULT_DEVICE_INTERVAL_SECONDS),
  }
}

/** Step 3: one poll of the WorkOS device grant. */
async function pollWorkOSDevice(
  fetchFn: typeof fetch,
  deviceCode: string,
  { signal, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ pending: true; slowDown: boolean } | { pending: false; accessToken: string; refreshToken: string }> {
  const response = await fetchFn(`${CLINE_WORKOS_API_BASE}${CLINE_WORKOS_AUTHENTICATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: CLINE_WORKOS_CLIENT_ID,
    }),
    signal: combineSignal(signal, timeoutMs),
  })
  const payload = await readJson(response)
  if (response.ok) {
    const accessToken = nonEmpty(payload.access_token)
    const refreshToken = nonEmpty(payload.refresh_token)
    if (accessToken === undefined || refreshToken === undefined) {
      throw new ClinePassOAuthError('WorkOS returned an invalid token response')
    }
    return { pending: false, accessToken, refreshToken }
  }
  const code = nonEmpty(payload.error)
  if (code === 'authorization_pending') return { pending: true, slowDown: false }
  if (code === 'slow_down') return { pending: true, slowDown: true }
  const details = errorDetails(payload)
  throw new ClinePassOAuthError(details.message ?? `WorkOS authorization failed: HTTP ${response.status}`, {
    status: response.status,
    code: details.code ?? code,
  })
}

interface ClineAuthUserInfo {
  subject?: string | null
  email?: string
  name?: string
  clineUserId?: string | null
  accounts?: string[] | null
}

interface ClineAuthResponseData {
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: string
  userInfo?: ClineAuthUserInfo
}

function readAuthData(payload: Record<string, unknown>, what: string, status: number): ClineAuthResponseData {
  const data = payload.data
  if (payload.success !== true || typeof data !== 'object' || data === null || Array.isArray(data)) {
    const details = errorDetails(payload)
    throw new ClinePassOAuthError(details.message ?? `${what} failed: HTTP ${status}`, { status, code: details.code })
  }
  const record = data as Record<string, unknown>
  const accessToken = nonEmpty(record.accessToken)
  if (accessToken === undefined) {
    throw new ClinePassOAuthError(`${what} returned no access token`, { status })
  }
  return {
    accessToken,
    ...(nonEmpty(record.refreshToken) === undefined ? {} : { refreshToken: nonEmpty(record.refreshToken) }),
    ...(nonEmpty(record.tokenType) === undefined ? {} : { tokenType: nonEmpty(record.tokenType) }),
    ...(nonEmpty(record.expiresAt) === undefined ? {} : { expiresAt: nonEmpty(record.expiresAt) }),
    ...(typeof record.userInfo === 'object' && record.userInfo !== null && !Array.isArray(record.userInfo)
      ? { userInfo: record.userInfo as ClineAuthUserInfo }
      : {}),
  }
}

function toOAuthCredentials(
  data: ClineAuthResponseData,
  refreshFallback: string | undefined,
  base: Partial<ClinePassOAuthCredentials>,
  what: string,
  status: number,
): ClinePassOAuthCredentials {
  const refresh = data.refreshToken ?? refreshFallback
  if (refresh === undefined || refresh === '') {
    throw new ClinePassOAuthError(`${what} returned no refresh token`, { status })
  }
  const expiresAt = data.expiresAt === undefined ? undefined : Date.parse(data.expiresAt)
  const expires = expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt > 0
    ? expiresAt
    : (jwtExpiryMs(data.accessToken) ?? Date.now() + 60 * 60_000)
  const user = data.userInfo
  const email = nonEmpty(user?.email) ?? base.email
  const name = nonEmpty(user?.name) ?? base.name
  const accountId = nonEmpty(user?.clineUserId) ?? base.accountId
  return {
    kind: 'oauth',
    access: data.accessToken,
    refresh,
    expires,
    ...(accountId === undefined ? {} : { accountId }),
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
    ...(base.alias === undefined ? {} : { alias: base.alias }),
    ...(base.addedAt === undefined ? {} : { addedAt: base.addedAt }),
    ...(base.baseURL === undefined ? {} : { baseURL: base.baseURL }),
    ...(base.metadata === undefined ? {} : { metadata: { ...base.metadata, ...(data.tokenType === undefined ? {} : { tokenType: data.tokenType }) } }),
  }
}

/** Step 4: exchange WorkOS tokens for a Cline session. */
export async function registerClinePassTokens(
  fetchFn: typeof fetch,
  {
    baseURL,
    accessToken,
    refreshToken,
    signal,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    base = {},
  }: {
    baseURL: string
    accessToken: string
    refreshToken: string
    signal?: AbortSignal
    timeoutMs?: number
    base?: Partial<ClinePassOAuthCredentials>
  },
): Promise<ClinePassOAuthCredentials> {
  const response = await fetchFn(clineAuthURL(baseURL, '/auth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, refreshToken }),
    signal: combineSignal(signal, timeoutMs),
  })
  const payload = await readJson(response)
  const data = readAuthData(payload, 'Token registration', response.status)
  return toOAuthCredentials(data, refreshToken, { ...base, addedAt: base.addedAt ?? Date.now() }, 'Token registration', response.status)
}

/** Renew one Cline session. The refresh token rotates, so persist the result. */
export async function refreshClinePassCredentials(
  fetchFn: typeof fetch,
  credentials: ClinePassOAuthCredentials,
  {
    baseURL,
    signal,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  }: { baseURL: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ClinePassOAuthCredentials> {
  const response = await fetchFn(clineAuthURL(baseURL, '/auth/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: credentials.refresh, grantType: 'refresh_token' }),
    signal: combineSignal(signal, timeoutMs),
  })
  const payload = await readJson(response)
  const data = readAuthData(payload, 'Token refresh', response.status)
  return toOAuthCredentials(data, credentials.refresh, {
    alias: credentials.alias,
    addedAt: credentials.addedAt,
    baseURL: credentials.baseURL,
    accountId: credentials.accountId,
    email: credentials.email,
    name: credentials.name,
    metadata: credentials.metadata,
  }, 'Token refresh', response.status)
}

/** Whether one session should be refreshed before its next use. */
export function clinePassNeedsRefresh(credentials: ClinePassOAuthCredentials, now: number): boolean {
  return credentials.expires <= 0 || credentials.expires - now <= REFRESH_MARGIN_MS
}

/** One login flow, as the settings card renders it. */
export type ClinePassLoginStatus = 'idle' | 'pending' | 'complete' | 'failed' | 'cancelled'

export interface ClinePassLoginFlow {
  id: string
  status: ClinePassLoginStatus
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
  error: string
  accountAlias: string
}

interface InternalFlow {
  dto: ClinePassLoginFlow
  deviceCode: string
  authBaseURL: string
  nextPollAt: number
  polling: boolean
}

export interface ClinePassLoginOptions {
  fetchFn: typeof fetch
  /** The line's current chat base URL. */
  baseURL(): string
  /** Persist a newly signed-in account; throws make the flow fail. */
  onLogin(credentials: ClinePassOAuthCredentials): Promise<void>
  logger?: { warn(message: string, ...args: unknown[]): void }
}

/**
 * One device-code sign-in at a time.
 *
 * Polling is driven by the card (`GET /login/status`): each request makes at
 * most one WorkOS call, and only after the advertised interval has elapsed. A
 * host restart therefore loses the pending flow rather than keeping a poll loop
 * alive with no reader — the same contract the Step Code line uses.
 */
export class ClinePassLoginManager {
  private flow: InternalFlow | null = null
  private sequence = 0

  constructor(private readonly options: ClinePassLoginOptions) {}

  /** Start a new flow, cancelling any previous one. */
  async begin({ signal }: { signal?: AbortSignal } = {}): Promise<ClinePassLoginFlow> {
    // A second sign-in replaces the first; the old flow must reach a terminal
    // state so a late poll from it cannot resurrect an abandoned attempt.
    if (this.flow !== null && this.flow.dto.status === 'pending') this.flow.dto.status = 'cancelled'
    const device = await startClinePassDeviceAuth(this.options.fetchFn, { signal })
    const id = `cline-${Date.now().toString(36)}-${(this.sequence += 1)}`
    const now = Date.now()
    const flow: InternalFlow = {
      dto: {
        id,
        status: 'pending',
        userCode: device.userCode,
        verificationUri: device.verificationUriComplete ?? device.verificationUri,
        expiresAt: now + device.expiresInSeconds * 1000,
        intervalSeconds: device.pollIntervalSeconds,
        error: '',
        accountAlias: '',
      },
      deviceCode: device.deviceCode,
      authBaseURL: this.options.baseURL(),
      nextPollAt: now + device.pollIntervalSeconds * 1000,
      polling: false,
    }
    this.flow = flow
    return { ...flow.dto }
  }

  /** The latest flow, or null when this process never started one. */
  current(): ClinePassLoginFlow | null {
    return this.flow === null ? null : { ...this.flow.dto }
  }

  /**
   * Advance one flow and return its state.
   *
   * A flow the caller does not name is not advanced: two cards (or a stale one)
   * cannot spend each other's polls.
   */
  async status(id: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ClinePassLoginFlow> {
    const flow = this.flow
    if (flow === null || flow.dto.id !== id) {
      throw new ClinePassOAuthError('This sign-in flow is no longer active', { code: 'login_not_found' })
    }
    if (flow.dto.status !== 'pending') return { ...flow.dto }
    if (Date.now() >= flow.dto.expiresAt) {
      flow.dto.status = 'failed'
      flow.dto.error = 'The device code expired. Start sign-in again.'
      return { ...flow.dto }
    }
    if (flow.polling || Date.now() < flow.nextPollAt) return { ...flow.dto }
    flow.polling = true
    try {
      let result: Awaited<ReturnType<typeof pollWorkOSDevice>>
      try {
        result = await pollWorkOSDevice(this.options.fetchFn, flow.deviceCode, { ...(signal === undefined ? {} : { signal }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      } catch (error) {
        if (error instanceof ClinePassOAuthError) {
          flow.dto.status = 'failed'
          flow.dto.error = error.message
          return { ...flow.dto }
        }
        // A transport blip is not a verdict on the user's browser confirmation:
        // keep polling until the device code itself expires.
        flow.nextPollAt = Date.now() + flow.dto.intervalSeconds * 1000
        flow.dto.error = error instanceof Error ? error.message : String(error)
        return { ...flow.dto }
      }
      if (result.pending) {
        if (result.slowDown) flow.dto.intervalSeconds += 1
        flow.nextPollAt = Date.now() + flow.dto.intervalSeconds * 1000
        return { ...flow.dto }
      }
      // Cancellation (or a newer sign-in) can land while the WorkOS poll is in
      // flight; a late success must not resurrect an abandoned flow.
      if (this.flow !== flow || flow.dto.status !== 'pending') return { ...flow.dto }
      const credentials = await registerClinePassTokens(this.options.fetchFn, {
        baseURL: flow.authBaseURL,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        ...(signal === undefined ? {} : { signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      if (this.flow !== flow || flow.dto.status !== 'pending') return { ...flow.dto }
      await this.options.onLogin(credentials)
      flow.dto.status = 'complete'
      flow.dto.accountAlias = credentials.email ?? credentials.name ?? credentials.accountId ?? 'Cline Pass'
      return { ...flow.dto }
    } catch (error) {
      flow.dto.status = 'failed'
      flow.dto.error = error instanceof Error ? error.message : String(error)
      this.options.logger?.warn('[cline-pass] sign-in failed: %s', flow.dto.error)
      return { ...flow.dto }
    } finally {
      flow.polling = false
    }
  }

  /** Abandon one flow; a late browser confirmation is then ignored. */
  cancel(id: string): boolean {
    const flow = this.flow
    if (flow === null || flow.dto.id !== id || flow.dto.status !== 'pending') return false
    flow.dto.status = 'cancelled'
    flow.dto.error = ''
    return true
  }

  /** Mark every flow cancelled for teardown. */
  dispose(): void {
    if (this.flow !== null && this.flow.dto.status === 'pending') {
      this.flow.dto.status = 'cancelled'
    }
  }
}
