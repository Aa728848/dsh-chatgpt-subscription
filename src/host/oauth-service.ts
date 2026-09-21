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
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../shared/account-pool-contracts.ts'
import { OAuthCallbackServer } from './callback-server.ts'
import type { CodexAccountPool } from './codex-account-pool.ts'
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
  constructor(
    readonly code: PublicErrorDto['code'],
    message: string,
    /** Token-endpoint status when the failure came from a response. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OAuthServiceError'
  }
}

/**
 * How the credential will be used, which decides who may serve it.
 *
 * `'request'` (default) is a metered model request: rotation, cooldowns and the
 * pool's cached-quota verdict all apply.
 *
 * `'tool'` is a ChatGPT call that is *not* metered against the Codex
 * rate-limit window — web search, web fetch, image generation. It reads the
 * account already serving the conversation and ignores cooldowns, because a
 * spent Codex window must not take those tools offline; they keep working with
 * the very same access token.
 */
export type CredentialPurpose = 'request' | 'tool'

export interface CredentialAccess {
  /** Defaults to `'request'`. */
  purpose?: CredentialPurpose
}

export interface OAuthServiceOptions {
  fetchFn?: FetchLike
  now?: () => number
  random?: (size: number) => Buffer
  logger?: Pick<Console, 'info' | 'warn'>
  /** Test seam; production always uses the five-minute compatibility default. */
  loginTimeoutMs?: number
  /**
   * Account pool this service drives.
   *
   * With a pool the service signs accounts in and refreshes them per account
   * while the pool decides which one serves a request; without one it keeps
   * serving the single stored credential exactly as before.
   */
  pool?: CodexAccountPool
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
  private readonly pool: CodexAccountPool | null
  /**
   * Bumped whenever this process writes credentials.
   *
   * Combined with the pool's own revision by {@link currentIdentityRevision} so
   * a caller can tell whether the account behind the credentials may have moved
   * without paying for a credential read to find out.
   */
  private credentialRevision = 0
  // Per-identity single flight: a rotating refresh token must never be redeemed
  // twice concurrently, and two requests can hit the same account at once.
  private readonly refreshInFlight = new Map<string, Promise<StoredOAuthCredentials>>()

  constructor(private readonly store: TokenStore, options: OAuthServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
    this.logger = options.logger ?? console
    this.loginTimeoutMs = options.loginTimeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS
    this.pool = options.pool ?? null
    // The pool refreshes one account at a time through this service, because the
    // refresh token rotates and only one writer may redeem it.
    this.pool?.setRefresher(this)
  }

  async status(): Promise<OAuthStatusDto> {
    const poolStatus = await this.readPoolStatus()
    try {
      const credentials = await this.store.load()
      return this.statusFromCredentials(credentials, true, poolStatus)
    } catch {
      return {
        ...this.statusFromCredentials(null, false, poolStatus),
        error: publicError(new OAuthServiceError('storage-failed', 'Secure credential storage could not be read.')),
      }
    }
  }

  /**
   * The pool slice of the status DTO.
   *
   * A pool that cannot be read is reported as empty rather than failing the
   * whole status call: the card must still render the connection section.
   */
  private async readPoolStatus(): Promise<{
    accounts: PoolAccountSummaryDto[]
    activeAccountId?: string
    rotationStrategy: AccountRotationStrategy
  }> {
    const pool = this.pool
    if (pool === null) return { accounts: [], rotationStrategy: 'sequential' }
    const [accounts, data] = await Promise.all([
      pool.listAccounts().catch(() => []),
      pool.read().catch(() => null),
    ])
    return {
      accounts,
      ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
      rotationStrategy: data?.rotationStrategy ?? 'sequential',
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
    if (this.pool !== null) {
      // Refresh the account that would serve the next request.
      const { account, credentials } = await this.pool.getEffectiveAccount(undefined, this.fetchFn)
      await this.refreshAccount(credentials)
        .then((refreshed) => this.pool!.updateAccountCredentials(account.id, refreshed))
      return this.status()
    }
    const stored = await this.loadAuthenticated()
    await this.refreshCredentials(stored)
    return this.status()
  }

  /**
   * Sign out.
   *
   * @param accountId - pooled account to remove; omit to remove the account
   *   that would serve the next request (the pool promotes another one), which
   *   is what a single "sign out" button means to a pool user.
   */
  async logout(accountId?: string): Promise<void> {
    if (this.activeLogin !== null) {
      this.cancelActive(new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.'), 'cancelled')
    }
    if (this.pool !== null) {
      const data = await this.pool.read().catch(() => null)
      const target = accountId
        ?? data?.activeAccountId
        ?? data?.accounts.find((account) => account.isPrimary)?.id
      if (target !== undefined) await this.pool.deleteAccount(target)
      this.lastLoginError = undefined
      this.logger.info('[dsh-chatgpt-subscription] OAuth credentials cleared')
      return
    }
    await this.store.clear().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credentials could not be deleted.')
    })
    this.credentialRevision += 1
    this.lastLoginError = undefined
    this.logger.info('[dsh-chatgpt-subscription] OAuth credentials cleared')
  }

  /**
   * A cheap, in-memory verdict on whether the serving account may have changed.
   *
   * Reading a credential is expensive — on Windows it is a DPAPI unprotect
   * through a spawned `powershell.exe` (~200 ms) — so a per-account cache must
   * not have to read one just to learn that it is still the same account.
   * Comparing this value against a previously observed one costs nothing, and
   * any path that can move which account serves a request bumps it: a pool
   * write (sign-in, delete, pin, rotation) or a credential write in this
   * process (sign-in, logout, token refresh).
   *
   * It is deliberately conservative: a spurious change costs one credential
   * read, while a missed change would report one account's data under another
   * account's name.
   */
  currentIdentityRevision(): number {
    return (this.pool?.currentIdentityRevision() ?? 0) + this.credentialRevision
  }

  /**
   * The credential to use next.
   *
   * @param forceRefresh - refresh even a token that is not close to expiry,
   *   which is how a 401 discovered mid-request recovers.
   * @param access - who is asking. A `'tool'` caller (web search, fetch, image
   *   generation) bypasses the pool's rotation state: an account cooling down
   *   after a Codex 429 still holds a working token for those endpoints, and
   *   refusing it there turned "your Codex window is spent" into a bogus
   *   "credentials are required" on every web search.
   */
  async credentials(forceRefresh = false, access: CredentialAccess = {}): Promise<StoredOAuthCredentials> {
    if (this.pool !== null) {
      // The pool owns selection, cooldowns and the proactive refresh. A tool
      // call still goes through the pool — it knows how to refresh an account's
      // rotated token — but through the credential-only door, and it refreshes
      // the account it picked rather than rotating to another one.
      if (access.purpose === 'tool') {
        const { account, credentials } = await this.pool.getCredentialAccount(this.fetchFn)
        if (!forceRefresh) return credentials
        const refreshed = await this.refreshAccount(credentials, this.fetchFn)
        await this.pool.updateAccountCredentials(account.id, refreshed)
        return refreshed
      }
      const { account, credentials } = await this.pool.getEffectiveAccount(undefined, this.fetchFn)
      if (!forceRefresh) return credentials
      const refreshed = await this.refreshAccount(credentials, this.fetchFn)
      await this.pool.updateAccountCredentials(account.id, refreshed)
      return refreshed
    }
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
    if (this.pool !== null) {
      // The pool stores every account and mirrors only the primary one into the
      // single-credential store, so signing in a second account cannot displace
      // the first from the pre-pool location.
      await this.pool.addAccount(credentials).catch(() => {
        throw new OAuthServiceError('storage-failed', 'ChatGPT credentials could not be saved securely.')
      })
      return
    }
    await this.store.save(credentials).catch(() => {
      throw new OAuthServiceError('storage-failed', 'ChatGPT credentials could not be saved securely.')
    })
    this.credentialRevision += 1
  }

  private refreshCredentials(stored: StoredOAuthCredentials): Promise<StoredOAuthCredentials> {
    if (this.refreshPromise !== null) return this.refreshPromise
    this.refreshPromise = this.performRefresh(stored).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  /**
   * Refresh one account's tokens on behalf of the pool.
   *
   * Deliberately different from the single-credential path: a rejected refresh
   * token must NOT wipe the whole credential store (other pooled accounts are
   * unaffected), and the write-back belongs to the pool, which owns the account
   * record. Concurrent calls for one identity share a single redemption, since
   * the refresh token rotates.
   */
  async refreshAccount(
    credentials: StoredOAuthCredentials,
    fetchFn: FetchLike = this.fetchFn,
  ): Promise<StoredOAuthCredentials> {
    const key = refreshKey(credentials)
    const existing = this.refreshInFlight.get(key)
    if (existing !== undefined) return existing
    let task: Promise<StoredOAuthCredentials>
    task = this.performRefresh(credentials, { clearOnReject: false, fetchFn, persist: false }).finally(() => {
      if (this.refreshInFlight.get(key) === task) this.refreshInFlight.delete(key)
    })
    this.refreshInFlight.set(key, task)
    return task
  }

  private async performRefresh(
    stored: StoredOAuthCredentials,
    options: { clearOnReject?: boolean; fetchFn?: FetchLike; persist?: boolean } = {},
  ): Promise<StoredOAuthCredentials> {
    const fetchFn = options.fetchFn ?? this.fetchFn
    const clearOnReject = options.clearOnReject ?? true
    const persist = options.persist ?? true
    const response = await fetchFn(OAUTH_TOKEN_URL, {
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
      if (clearOnReject && (response.status === 400 || response.status === 401)) {
        await this.store.clear().catch(() => {
          throw new OAuthServiceError('storage-failed', 'Expired ChatGPT credentials could not be deleted securely.')
        })
        this.credentialRevision += 1
      }
      throw new OAuthServiceError(
        'refresh-failed',
        `ChatGPT token refresh failed (${response.status}${detail === null ? '' : `, ${detail}`}). Sign in again.`,
        response.status,
      )
    }
    const tokens = await response.json() as OAuthTokenResponse
    const fresh = credentialsFromTokenResponse(tokens, this.now(), stored)
    if (persist) {
      await this.store.save(fresh).catch(() => {
        throw new OAuthServiceError('storage-failed', 'Refreshed credentials could not be saved securely.')
      })
      this.credentialRevision += 1
    }
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

  private statusFromCredentials(
    credentials: StoredOAuthCredentials | null,
    storageAvailable = true,
    poolStatus: { accounts: PoolAccountSummaryDto[]; activeAccountId?: string; rotationStrategy: AccountRotationStrategy } = {
      accounts: [],
      rotationStrategy: 'sequential',
    },
  ): OAuthStatusDto {
    const active = this.activeLogin
    if (credentials === null) {
      return {
        authenticated: poolStatus.accounts.length > 0,
        account: null,
        ...poolStatus,
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
      ...poolStatus,
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

/** Identity one refresh is keyed by, so a rotation is never redeemed twice. */
function refreshKey(credentials: StoredOAuthCredentials): string {
  return credentials.accountId ?? credentials.email ?? credentials.refreshToken
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
