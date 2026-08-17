import { createHash, randomBytes } from 'node:crypto'
import {
  CHATGPT_OAUTH_CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_LOGIN_TIMEOUT_MS,
  OAUTH_ORIGINATOR,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
  TOKEN_REFRESH_MARGIN_MS,
} from '../compat.ts'
import type {
  LoginEventDto,
  LoginStartDto,
  OAuthStatusDto,
  PublicErrorDto,
} from '../shared/contracts.ts'
import { OAuthCallbackServer } from './callback-server.ts'
import type { StoredOAuthCredentials, TokenStore } from './token-store.ts'

type FetchLike = typeof fetch
type LoginListener = (event: LoginEventDto) => void

interface OAuthTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
}

interface OAuthClaims {
  email?: unknown
  chatgpt_account_id?: unknown
  chatgpt_plan_type?: unknown
  organizations?: Array<{ id?: unknown }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: unknown
    chatgpt_plan_type?: unknown
    organizations?: Array<{ id?: unknown }>
  }
}

interface ActiveLogin {
  id: string
  expiresAt: number
  server: OAuthCallbackServer
  timeout: NodeJS.Timeout
}

export class OAuthServiceError extends Error {
  constructor(readonly code: PublicErrorDto['code'], message: string) {
    super(message)
    this.name = 'OAuthServiceError'
  }
}

export interface OAuthServiceOptions {
  fetchFn?: FetchLike
  now?: () => number
  random?: (size: number) => Buffer
  logger?: Pick<Console, 'info' | 'warn'>
  /** Test seam; production always uses the five-minute compatibility default. */
  loginTimeoutMs?: number
}

export class OAuthService {
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private readonly random: (size: number) => Buffer
  private readonly logger: Pick<Console, 'info' | 'warn'>
  private readonly loginTimeoutMs: number
  private readonly loginEvents = new Map<string, LoginEventDto>()
  private readonly listeners = new Map<string, Set<LoginListener>>()
  private activeLogin: ActiveLogin | null = null
  private refreshPromise: Promise<StoredOAuthCredentials> | null = null
  private lastLoginError: PublicErrorDto | undefined
  private disposed = false

  constructor(private readonly store: TokenStore, options: OAuthServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
    this.logger = options.logger ?? console
    this.loginTimeoutMs = options.loginTimeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS
  }

  async status(): Promise<OAuthStatusDto> {
    try {
      const credentials = await this.store.load()
      return this.statusFromCredentials(credentials)
    } catch {
      return {
        ...this.statusFromCredentials(null, false),
        error: publicError(new OAuthServiceError('storage-failed', 'Secure credential storage could not be read.')),
      }
    }
  }

  async startLogin(): Promise<LoginStartDto> {
    this.assertAvailable()
    await this.store.load().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credential storage is unavailable. Fix its ownership or permissions before signing in.')
    })
    if (this.activeLogin !== null) {
      throw new OAuthServiceError('login-active', 'A ChatGPT sign-in is already in progress.')
    }
    this.lastLoginError = undefined
    const loginId = this.random(24).toString('base64url')
    const verifier = this.random(48).toString('base64url')
    const state = this.random(32).toString('base64url')
    const expiresAt = this.now() + this.loginTimeoutMs
    const server = new OAuthCallbackServer({
      expectedState: state,
      exchange: async (code, signal) => this.exchangeCode(code, verifier, signal),
    })
    try {
      await server.listen()
    } catch {
      void server.completion.catch(() => undefined)
      server.dispose()
      throw new OAuthServiceError('internal', 'The localhost OAuth callback listener could not start on port 1455.')
    }
    const timeout = setTimeout(() => {
      this.cancelActive(new OAuthServiceError('login-expired', 'ChatGPT sign-in timed out.'), 'failed')
    }, this.loginTimeoutMs)
    timeout.unref?.()
    this.activeLogin = { id: loginId, expiresAt, server, timeout }
    this.publish({ type: 'pending', loginId })
    void server.completion.then(() => {
      this.completeLogin(loginId)
    }).catch((error: unknown) => {
      this.failLogin(loginId, error)
    })
    this.logger.info('[dsh-chatgpt-subscription] OAuth login started')
    return { loginId, authUrl: buildAuthorizationUrl(verifier, state), expiresAt }
  }

  cancelLogin(loginId: string): void {
    if (this.activeLogin === null || this.activeLogin.id !== loginId) {
      throw new OAuthServiceError('bad-request', 'The requested sign-in is not active.')
    }
    this.cancelActive(new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.'), 'cancelled')
  }

  subscribe(loginId: string, listener: LoginListener): (() => void) | null {
    const current = this.loginEvents.get(loginId)
    if (current === undefined) return null
    let set = this.listeners.get(loginId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(loginId, set)
    }
    set.add(listener)
    listener(current)
    return () => {
      set?.delete(listener)
      if (set?.size === 0) this.listeners.delete(loginId)
    }
  }

  async refresh(): Promise<OAuthStatusDto> {
    this.assertAvailable()
    const stored = await this.loadAuthenticated()
    await this.refreshCredentials(stored)
    return this.status()
  }

  async logout(): Promise<void> {
    if (this.activeLogin !== null) {
      this.cancelActive(new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.'), 'cancelled')
    }
    await this.store.clear().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credentials could not be deleted.')
    })
    this.lastLoginError = undefined
    this.logger.info('[dsh-chatgpt-subscription] OAuth credentials cleared')
  }

  async credentials(forceRefresh = false): Promise<StoredOAuthCredentials> {
    const stored = await this.loadAuthenticated()
    if (forceRefresh || stored.expiresAt - this.now() <= TOKEN_REFRESH_MARGIN_MS) {
      return this.refreshCredentials(stored)
    }
    return stored
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.activeLogin !== null) {
      this.cancelActive(new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.'), 'cancelled')
    }
    this.listeners.clear()
    this.loginEvents.clear()
  }

  private async exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<void> {
    const response = await this.fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
      signal,
    }).catch(() => {
      throw new OAuthServiceError('oauth-token-exchange-failed', 'ChatGPT token exchange could not be reached.')
    })
    if (!response.ok) {
      const detail = await oauthErrorIdentifier(response)
      throw new OAuthServiceError('oauth-token-exchange-failed', `ChatGPT token exchange failed (${response.status}${detail === null ? '' : `, ${detail}`}).`)
    }
    const tokens = await response.json() as OAuthTokenResponse
    const credentials = credentialsFromTokenResponse(tokens, this.now())
    await this.store.save(credentials).catch(() => {
      throw new OAuthServiceError('storage-failed', 'ChatGPT credentials could not be saved securely.')
    })
  }

  private refreshCredentials(stored: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
    if (this.refreshPromise !== null) return this.refreshPromise
    this.refreshPromise = this.performRefresh(stored).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async performRefresh(stored: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
    const response = await this.fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
      }).toString(),
    }).catch(() => {
      throw new OAuthServiceError('refresh-failed', 'ChatGPT token refresh could not be reached.')
    })
    if (!response.ok) {
      const detail = await oauthErrorIdentifier(response)
      if (response.status === 400 || response.status === 401) {
        await this.store.clear().catch(() => {
          throw new OAuthServiceError('storage-failed', 'Expired ChatGPT credentials could not be deleted securely.')
        })
      }
      throw new OAuthServiceError('refresh-failed', `ChatGPT token refresh failed (${response.status}${detail === null ? '' : `, ${detail}`}). Sign in again.`)
    }
    const tokens = await response.json() as OAuthTokenResponse
    const fresh = credentialsFromTokenResponse(tokens, this.now(), stored)
    await this.store.save(fresh).catch(() => {
      throw new OAuthServiceError('storage-failed', 'Refreshed credentials could not be saved securely.')
    })
    this.logger.info('[dsh-chatgpt-subscription] OAuth credentials refreshed')
    return fresh
  }

  private async loadAuthenticated(): Promise<StoredOAuthCredentials> {
    const stored = await this.store.load().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credential storage could not be read.')
    })
    if (stored === null) throw new OAuthServiceError('not-authenticated', 'Sign in with ChatGPT first.')
    return stored
  }

  private statusFromCredentials(credentials: StoredOAuthCredentials | null, storageAvailable = true): OAuthStatusDto {
    const active = this.activeLogin
    if (credentials === null) {
      return {
        authenticated: false,
        account: null,
        storage: { ...this.store.storage, available: storageAvailable },
        login: {
          active: active !== null,
          loginId: active?.id ?? null,
          expiresAt: active === null ? null : Math.floor(active.expiresAt / 1000),
        },
        ...(this.lastLoginError === undefined ? {} : { error: this.lastLoginError }),
      }
    }
    const identity = extractIdentity(credentials)
    return {
      authenticated: true,
      account: {
        email: maskEmail(credentials.email ?? identity.email),
        planType: credentials.planType ?? identity.planType ?? null,
        accountIdSuffix: maskAccountId(credentials.accountId ?? identity.accountId),
        tokenExpiresAt: Math.floor(credentials.expiresAt / 1000),
      },
      storage: { ...this.store.storage, available: storageAvailable },
      login: {
        active: active !== null,
        loginId: active?.id ?? null,
        expiresAt: active === null ? null : Math.floor(active.expiresAt / 1000),
      },
      ...(this.lastLoginError === undefined ? {} : { error: this.lastLoginError }),
    }
  }

  private completeLogin(loginId: string): void {
    if (this.activeLogin?.id !== loginId) return
    clearTimeout(this.activeLogin.timeout)
    this.activeLogin = null
    this.lastLoginError = undefined
    this.publish({ type: 'completed', loginId })
    this.logger.info('[dsh-chatgpt-subscription] OAuth login completed')
  }

  private failLogin(loginId: string, error: unknown): void {
    if (this.activeLogin?.id !== loginId) return
    clearTimeout(this.activeLogin.timeout)
    this.activeLogin = null
    const mapped = publicError(error, 'oauth-callback-invalid')
    this.lastLoginError = mapped
    this.publish({ type: 'failed', loginId, error: mapped })
    this.logger.warn(`[dsh-chatgpt-subscription] OAuth login failed (${mapped.code}): ${mapped.message}`)
  }

  private cancelActive(error: OAuthServiceError, outcome: 'cancelled' | 'failed'): void {
    const active = this.activeLogin
    if (active === null) return
    clearTimeout(active.timeout)
    this.activeLogin = null
    active.server.cancel(error)
    this.publish(outcome === 'cancelled'
      ? { type: 'cancelled', loginId: active.id }
      : { type: 'failed', loginId: active.id, error: publicError(error) })
  }

  private publish(event: LoginEventDto): void {
    this.loginEvents.set(event.loginId, event)
    for (const listener of this.listeners.get(event.loginId) ?? []) listener(event)
  }

  private assertAvailable(): void {
    if (this.disposed) throw new OAuthServiceError('internal', 'The OAuth service has been disposed.')
  }
}

export function buildAuthorizationUrl(verifier: string, state: string): string {
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: OAUTH_ORIGINATOR,
  })
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

export function parseJwtClaims(token: string | undefined): OAuthClaims | undefined {
  if (token === undefined) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as OAuthClaims : undefined
  } catch {
    return undefined
  }
}

export function publicError(error: unknown, fallback: PublicErrorDto['code'] = 'internal'): PublicErrorDto {
  if (error instanceof OAuthServiceError) return { code: error.code, message: error.message }
  return { code: fallback, message: 'The ChatGPT sign-in operation failed.' }
}

function credentialsFromTokenResponse(
  response: OAuthTokenResponse,
  now: number,
  previous?: StoredOAuthCredentials,
): StoredOAuthCredentials {
  if (typeof response.access_token !== 'string' || response.access_token === '') {
    throw new OAuthServiceError('oauth-token-exchange-failed', 'ChatGPT returned no access token.')
  }
  const refreshToken = typeof response.refresh_token === 'string' && response.refresh_token !== ''
    ? response.refresh_token
    : previous?.refreshToken
  if (refreshToken === undefined) {
    throw new OAuthServiceError('oauth-token-exchange-failed', 'ChatGPT returned no refresh token.')
  }
  const seconds = Number(response.expires_in)
  const expiresIn = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600
  const base: StoredOAuthCredentials = {
    accessToken: response.access_token,
    refreshToken,
    idToken: typeof response.id_token === 'string' ? response.id_token : previous?.idToken,
    expiresAt: now + expiresIn * 1000,
  }
  const identity = extractIdentity(base)
  return {
    ...base,
    accountId: identity.accountId ?? previous?.accountId,
    email: identity.email ?? previous?.email,
    planType: identity.planType ?? previous?.planType,
  }
}

function extractIdentity(credentials: Pick<StoredOAuthCredentials, 'accessToken' | 'idToken'>): {
  accountId?: string
  email?: string
  planType?: string
} {
  const result: { accountId?: string; email?: string; planType?: string } = {}
  for (const token of [credentials.idToken, credentials.accessToken]) {
    const claims = parseJwtClaims(token)
    if (claims === undefined) continue
    const nested = claims['https://api.openai.com/auth']
    result.email ??= stringClaim(claims.email)
    result.planType ??= stringClaim(claims.chatgpt_plan_type) ?? stringClaim(nested?.chatgpt_plan_type)
    result.accountId ??= stringClaim(claims.chatgpt_account_id)
      ?? stringClaim(nested?.chatgpt_account_id)
      ?? stringClaim(claims.organizations?.[0]?.id)
      ?? stringClaim(nested?.organizations?.[0]?.id)
  }
  return result
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function maskEmail(email: string | undefined): string | null {
  if (email === undefined) return null
  const at = email.indexOf('@')
  if (at <= 0 || at === email.length - 1) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

function maskAccountId(accountId: string | undefined): string | null {
  if (accountId === undefined) return null
  return `…${accountId.slice(-4)}`
}

async function oauthErrorIdentifier(response: Response): Promise<string | null> {
  const payload = await response.json().catch(() => null) as unknown
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const error = record.error
  const candidates = typeof error === 'object' && error !== null && !Array.isArray(error)
    ? [(error as Record<string, unknown>).code, (error as Record<string, unknown>).type]
    : [error]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) return candidate
  }
  return null
}
