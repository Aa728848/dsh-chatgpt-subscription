import { createHash, randomBytes } from 'node:crypto'
import {
  CHATGPT_OAUTH_CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_DEVICE_GRANT_LIFETIME_MS,
  OAUTH_DEVICE_MIN_POLL_INTERVAL_MS,
  OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
  OAUTH_DEVICE_REDIRECT_URI,
  OAUTH_DEVICE_TOKEN_URL,
  OAUTH_DEVICE_USERCODE_URL,
  OAUTH_DEVICE_VERIFY_URL,
  OAUTH_LOGIN_TIMEOUT_MS,
  OAUTH_ORIGINATOR,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
  TOKEN_REFRESH_MARGIN_MS,
} from '../compat.ts'
import type {
  DeviceLoginDto,
  DeviceLoginStartDto,
  LoginEventDto,
  LoginStartDto,
  OAuthStatusDto,
  PublicErrorDto,
} from '../shared/contracts.ts'
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../shared/account-pool-contracts.ts'
import type { PoolStorageDto } from '../shared/contracts.ts'
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
  /** Tears down whatever this flow waits on: the localhost listener or the poll loop. */
  stop: () => void
  /** The device code, when the running flow is the device grant. */
  device?: DeviceLoginDto
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
  /**
   * True between taking the login slot and having something to put in
   * {@link activeLogin}.
   *
   * Both starts have work to do before the login exists (a storage read, the
   * device grant), and that work is awaited. A check made before the first
   * `await` and an assignment made after it do not exclude each other: two
   * overlapping calls both pass the check, the second overwrites the first, and
   * the first flow's `AbortController` becomes unreachable — Cancel stops the
   * wrong flow and the abandoned one keeps polling until its grant expires.
   */
  private startPending = false
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
    poolStorage?: PoolStorageDto
  }> {
    const pool = this.pool
    if (pool === null) return { accounts: [], rotationStrategy: 'sequential' }
    // A pool whose read FAILED is not an empty pool. The card gets an empty list
    // for want of anything better, but it must say why — otherwise a transient
    // keyring refusal looks exactly like "your accounts are gone".
    let readFailed = false
    const [accounts, data, poolStorage] = await Promise.all([
      pool.listAccounts().catch(() => { readFailed = true; return [] }),
      pool.read().catch(() => { readFailed = true; return null }),
      // Reported by the pool itself: the card has to name the store a user GOT,
      // which on a server that chose `credentials` is not the platform default.
      pool.poolStorage().catch(() => undefined),
    ])
    // A reason the storage resolver already stated wins: it knows WHY the store
    // cannot be used, which is more than "the read failed".
    const reason = readFailed && poolStorage !== undefined && poolStorage.unavailable === undefined
      ? { ...poolStorage, unavailable: 'store-unreadable' as const }
      : poolStorage
    return {
      accounts,
      ...(data?.activeAccountId === undefined ? {} : { activeAccountId: data.activeAccountId }),
      rotationStrategy: data?.rotationStrategy ?? 'sequential',
      ...(reason === undefined ? {} : { poolStorage: reason }),
    }
  }

  /**
   * Take the one login slot, or say that it is taken.
   *
   * Called synchronously, before the first `await` of the start it belongs to:
   * nothing can suspend between the check and the flag, so two overlapping
   * starts cannot both get through. The caller's `finally` releases the flag once
   * the login itself is in {@link activeLogin} (or the start has failed).
   */
  private beginStart(): void {
    if (this.startPending || this.activeLogin !== null) {
      throw new OAuthServiceError('login-active', 'A ChatGPT sign-in is already in progress.')
    }
    this.startPending = true
  }

  async startLogin(): Promise<LoginStartDto> {
    this.assertAvailable()
    this.beginStart()
    try {
      return await this.startBrowserLogin()
    } finally {
      this.startPending = false
    }
  }

  /** The body of {@link startLogin}, with the slot already taken. */
  private async startBrowserLogin(): Promise<LoginStartDto> {
    await this.store.load().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credential storage is unavailable. Fix its ownership or permissions before signing in.')
    })
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
    this.activeLogin = {
      id: loginId,
      expiresAt,
      stop: () => {
        clearTimeout(timeout)
        server.cancel(new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.'))
      },
    }
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

  /**
   * Start a device-code sign-in, the path a headless host can finish.
   *
   * Answers as soon as the grant exists, with the code the user has to type and
   * the page to type it on; the wait for confirmation runs in the background and
   * reports through the same event stream the browser flow uses, so the card
   * needs no second mechanism and cancellation is the same call.
   */
  async startDeviceLogin(): Promise<DeviceLoginStartDto> {
    this.assertAvailable()
    this.beginStart()
    try {
      return await this.startDeviceLoginInner()
    } finally {
      this.startPending = false
    }
  }

  /** The body of {@link startDeviceLogin}, with the slot already taken. */
  private async startDeviceLoginInner(): Promise<DeviceLoginStartDto> {
    await this.store.load().catch(() => {
      throw new OAuthServiceError('storage-failed', 'Secure credential storage is unavailable. Fix its ownership or permissions before signing in.')
    })
    this.lastLoginError = undefined
    const controller = new AbortController()
    const grant = await this.requestDeviceGrant(controller.signal)
    const loginId = this.random(24).toString('base64url')
    const device: DeviceLoginDto = {
      userCode: grant.userCode,
      verificationUrl: OAUTH_DEVICE_VERIFY_URL,
      expiresAt: Math.floor(grant.expiresAt / 1000),
      now: Math.floor(this.now() / 1000),
    }
    this.activeLogin = {
      id: loginId,
      expiresAt: grant.expiresAt,
      stop: () => controller.abort(),
      device,
    }
    this.publish({ type: 'pending', loginId })
    void this.pollDeviceGrant(loginId, device, grant, controller.signal).catch((error: unknown) => {
      this.failLogin(loginId, error)
    })
    // No code, verifier or grant id in this line: it records that a sign-in
    // started, not what could redeem it.
    this.logger.info('[dsh-chatgpt-subscription] device-code login started')
    return { loginId, ...device }
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
      // One forced rotation, not two: reading first refreshes an expiring token,
      // and this call would then rotate the token it had just produced — spending
      // a second refresh token moments after the first.
      await this.pool.getEffectiveAccount(undefined, this.fetchFn, true)
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
    return (await this.credentialSelection(forceRefresh, access)).credentials
  }

  /**
   * The credential to use next, together with the pool row that owns it.
   *
   * The settings card keys each account's quota snapshot by the row the reading
   * was made for, and the credential cannot do that job: a refresh rotates its
   * tokens, and an account may state no id of its own. Callers that care about
   * identity ask here; every other caller keeps using {@link credentials} and
   * sees no difference.
   *
   * @param forceRefresh - refresh even a token that is not close to expiry.
   * @param access - who is asking; see {@link credentials}.
   */
  async credentialSelection(
    forceRefresh = false,
    access: CredentialAccess = {},
  ): Promise<{ accountId?: string; credentials: StoredOAuthCredentials }> {
    if (this.pool !== null) {
      // The pool owns selection, cooldowns and the proactive refresh. A tool
      // call still goes through the pool — it knows how to refresh an account's
      // rotated token — but through the credential-only door, and it refreshes
      // the account it picked rather than rotating to another one.
      const picked = access.purpose === 'tool'
        ? await this.pool.getCredentialAccount(this.fetchFn, forceRefresh)
        : await this.pool.getEffectiveAccount(undefined, this.fetchFn, forceRefresh)
      return { accountId: picked.account.id, credentials: picked.credentials }
    }
    const stored = await this.loadAuthenticated()
    if (forceRefresh || stored.expiresAt - this.now() <= TOKEN_REFRESH_MARGIN_MS) {
      return { credentials: await this.refreshCredentials(stored) }
    }
    return { credentials: stored }
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

  private async exchangeCode(
    code: string,
    verifier: string,
    signal: AbortSignal,
    redirectUri: string = OAUTH_REDIRECT_URI,
  ): Promise<void> {
    const response = await this.fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
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
    await this.persistCredentials(credentials, signal)
  }

  /**
   * Write freshly redeemed credentials into the pool, unless the sign-in was
   * cancelled while the token answer was on its way.
   *
   * The abort check used to live only in the poll loop, *after* the exchange, so
   * a Cancel landing between the token `200` and the write left the host having
   * answered `{cancelled:true}` and published `cancelled` while the pool quietly
   * gained an account. The check belongs at the last moment before the write —
   * the narrower the window, the fewer writes it misses.
   */
  private async persistCredentials(credentials: StoredOAuthCredentials, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.')
    }
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

  /**
   * Ask for a device code, and normalise what the grant says about itself.
   *
   * `interval` arrives as a *string* (`"5"`) on the live service and
   * `expires_at` as an ISO timestamp, so both are parsed rather than trusted to
   * be the type they should be. A grant that states neither still works: the
   * defaults are the values the service actually uses.
   */
  private async requestDeviceGrant(signal: AbortSignal): Promise<DeviceGrant> {
    const response = await this.fetchFn(OAUTH_DEVICE_USERCODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
      signal,
    }).catch(() => {
      throw new OAuthServiceError('oauth-token-exchange-failed', 'The ChatGPT device-code request could not be reached.')
    })
    if (!response.ok) {
      const detail = await oauthErrorIdentifier(response)
      throw new OAuthServiceError(
        'oauth-token-exchange-failed',
        `The ChatGPT device code could not be issued (${response.status}${detail === null ? '' : `, ${detail}`}).`,
        response.status,
      )
    }
    const payload = await response.json().catch(() => null) as unknown
    const record = isRecord(payload) ? payload : {}
    const authId = nonEmptyString(record.device_auth_id)
    // `usercode` is the alias: both spellings have been seen on this endpoint,
    // and refusing one of them turns a working grant into "no code returned".
    const userCode = nonEmptyString(record.user_code) ?? nonEmptyString(record.usercode)
    if (authId === undefined || userCode === undefined) {
      throw new OAuthServiceError('oauth-token-exchange-failed', 'ChatGPT returned no device code.')
    }
    return {
      authId,
      userCode,
      interval: parseGrantInterval(record.interval),
      expiresAt: parseGrantDeadline(record.expires_at, this.now()),
    }
  }

  /**
   * Wait for the user to confirm the code, then redeem the grant.
   *
   * Three rules, and each one is a way this loop goes wrong if it is dropped:
   * the wait between polls is the grant's own `interval` (clamped, see
   * {@link pollDelayMs}); no single wait runs past the deadline; and nothing is
   * accepted at or after the deadline, because a grant that expired upstream is
   * not a sign-in — redeeming it would surface the server's error as if the
   * user's code had failed.
   */
  private async pollDeviceGrant(
    loginId: string,
    device: DeviceLoginDto,
    grant: DeviceGrant,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = grant.expiresAt
    const interval = grant.interval
    for (;;) {
      if (signal.aborted) return
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        throw new OAuthServiceError('login-expired', 'The device code expired before it was confirmed. Start the sign-in again for a fresh code.')
      }
      await sleep(Math.min(pollDelayMs(interval, deadline - this.now()), remaining), signal)
      if (signal.aborted) return
      if (this.now() >= deadline) {
        throw new OAuthServiceError('login-expired', 'The device code expired before it was confirmed. Start the sign-in again for a fresh code.')
      }
      const outcome = await this.pollDeviceToken(grant, signal)
      if (outcome === 'pending') continue
      // Re-checked before spending the exchange: a Cancel that lands while the
      // confirmation is being read must not be followed by a token request.
      if (signal.aborted) return
      // Redeemed against the device redirect, not the loopback one: this code was
      // not issued to a browser callback and the token endpoint checks the pair.
      // The write inside refuses to happen once the signal is aborted.
      await this.exchangeCode(outcome.authorizationCode, outcome.codeVerifier, signal, OAUTH_DEVICE_REDIRECT_URI)
      if (signal.aborted) return
      this.completeLogin(loginId)
      return
    }
  }

  /**
   * One confirmation check.
   *
   * `403`/`404` (and any payload whose status says pending) mean "not yet" — the
   * user has not typed the code or has not confirmed it. Everything else is
   * terminal and carries the status with any error code the service named, so
   * the card can say what happened instead of polling until the deadline.
   */
  private async pollDeviceToken(grant: DeviceGrant, signal: AbortSignal): Promise<DeviceTokenOutcome> {
    const response = await this.fetchFn(OAUTH_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: grant.authId, user_code: grant.userCode }),
      signal,
    }).catch(() => {
      if (signal.aborted) throw new OAuthServiceError('login-cancelled', 'ChatGPT sign-in was cancelled.')
      throw new OAuthServiceError('oauth-token-exchange-failed', 'The ChatGPT device confirmation could not be reached.')
    })
    const payload = await response.json().catch(() => null) as unknown
    if (isPendingDeviceAnswer(response, payload)) return 'pending'
    if (!response.ok) {
      const detail = deviceErrorIdentifier(payload)
      throw new OAuthServiceError(
        'oauth-token-exchange-failed',
        `The ChatGPT device confirmation was refused (${response.status}${detail === undefined ? '' : `, ${detail}`}).`,
        response.status,
      )
    }
    const record = isRecord(payload) ? payload : {}
    const authorizationCode = nonEmptyString(record.authorization_code)
    const codeVerifier = nonEmptyString(record.code_verifier)
    if (authorizationCode === undefined || codeVerifier === undefined) {
      throw new OAuthServiceError('oauth-token-exchange-failed', 'ChatGPT confirmed the device code but returned no authorization code.')
    }
    return { authorizationCode, codeVerifier }
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
    poolStatus: {
      accounts: PoolAccountSummaryDto[]
      activeAccountId?: string
      rotationStrategy: AccountRotationStrategy
      poolStorage?: PoolStorageDto
    } = {
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
        login: this.loginStatus(active),
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
      login: this.loginStatus(active),
      ...(this.lastLoginError === undefined ? {} : { error: this.lastLoginError }),
    }
  }

  /**
   * The `login` slice of the status, shared by both branches above.
   *
   * A device flow also carries its code: the card is the only place the user can
   * read it, and a settings page opened a second time (or reloaded) would
   * otherwise show "waiting" with nothing to type anywhere on it.
   */
  private loginStatus(active: ActiveLogin | null): OAuthStatusDto['login'] {
    const device = active?.device
    return {
      active: active !== null,
      loginId: active?.id ?? null,
      expiresAt: active === null ? null : Math.floor(active.expiresAt / 1000),
      // `now` is this host's clock at the moment the answer is built, not at the
      // start of the flow: the card counts `expiresAt - now` against its own
      // elapsed time, so a browser with a skewed clock still counts correctly.
      ...(device === undefined ? {} : { device: { ...device, now: Math.floor(this.now() / 1000) } }),
    }
  }

  private completeLogin(loginId: string): void {
    if (this.activeLogin?.id !== loginId) return
    this.activeLogin.stop()
    this.activeLogin = null
    this.lastLoginError = undefined
    this.publish({ type: 'completed', loginId })
    this.logger.info('[dsh-chatgpt-subscription] OAuth login completed')
  }

  private failLogin(loginId: string, error: unknown): void {
    if (this.activeLogin?.id !== loginId) return
    this.activeLogin.stop()
    this.activeLogin = null
    const mapped = publicError(error, 'oauth-callback-invalid')
    this.lastLoginError = mapped
    this.publish({ type: 'failed', loginId, error: mapped })
    this.logger.warn(`[dsh-chatgpt-subscription] OAuth login failed (${mapped.code}): ${mapped.message}`)
  }

  private cancelActive(error: OAuthServiceError, outcome: 'cancelled' | 'failed'): void {
    const active = this.activeLogin
    if (active === null) return
    // Nulled before the teardown runs: aborting the poll loop makes it reject,
    // and that rejection must not be published a second time as a failure.
    this.activeLogin = null
    active.stop()
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

/** A device grant as the poll loop needs it: the wire fields, already parsed. */
interface DeviceGrant {
  authId: string
  userCode: string
  /** Seconds the grant asks to wait between confirmation checks. */
  interval: number
  /** Deadline, Unix milliseconds. */
  expiresAt: number
}

/** One confirmation check: still waiting, or the pair that redeems the grant. */
type DeviceTokenOutcome = 'pending' | { authorizationCode: string; codeVerifier: string }

/**
 * How long to wait before the next confirmation check.
 *
 * Two clamps, for two different bad values. A floor keeps a fractional interval
 * (a grant answering `"0.2"`) from turning the loop into a spin against the
 * service — `"0"`, a negative and anything unparseable never reach it, because
 * {@link parseGrantInterval} already turns those into the 5 s default. The
 * deadline keeps an absurd interval from sleeping past the point where the grant
 * dies, which would leave the card "waiting" for a code that can no longer be
 * redeemed. The normal value — `"5"` — passes through untouched.
 */
function pollDelayMs(intervalSeconds: number, remainingMs: number): number {
  const requested = intervalSeconds * 1000
  const capped = Math.min(requested, Math.max(remainingMs, 0))
  return Math.max(OAUTH_DEVICE_MIN_POLL_INTERVAL_MS, capped)
}

/** The grant's `interval`, which arrives as a string on the live service. */
function parseGrantInterval(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : OAUTH_DEVICE_POLL_INTERVAL_SECONDS
}

/**
 * The grant's `expires_at`, which the live service sends as an ISO timestamp.
 *
 * A number is accepted too, and its magnitude decides the unit: a Unix timestamp
 * in seconds and one in milliseconds differ by three orders of magnitude, so
 * guessing is safe here in a way it is not for a field that could be either by a
 * factor of a thousand. Anything unparseable falls back to the grant lifetime
 * this client expects — the deadline still exists, it just is not the grant's.
 */
function parseGrantDeadline(value: unknown, now: number): number {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  return now + OAUTH_DEVICE_GRANT_LIFETIME_MS
}

/**
 * Wait `ms`, or less if the sign-in is cancelled first.
 *
 * Resolves rather than rejects on abort: the caller already knows it was
 * cancelled and checks the signal, so a rejected promise here would only add an
 * unhandled path that says the same thing a second time.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Status values that mean "the user has not confirmed yet", not a failure. */
const DEVICE_PENDING_STATUSES = new Set(['pending', 'authorization_pending', 'deviceauth_pending', 'not_found'])

/**
 * Whether one confirmation check was the grant saying "not yet".
 *
 * Two ways to say it, and the second is deliberately narrow. The live service
 * answers `403`/`404` while waiting, and those statuses mean "not yet" whatever
 * the body says. A body that merely *looks* pending counts only on a status that
 * could carry it — a `200`, or the `400` some builds answer — because honouring it
 * everywhere let a `401`/`429`/`500` that happened to mention `status: "pending"`
 * retry an invalid user code until the deadline, hiding a reason the user could
 * have been told at once. Every other status is a failure, read by its code.
 */
function isPendingDeviceAnswer(response: Response, payload: unknown): boolean {
  if (response.status === 403 || response.status === 404) return true
  if (!response.ok && response.status !== 400) return false
  if (!isRecord(payload)) return false
  const status = payload.status
  if (typeof status === 'string' && DEVICE_PENDING_STATUSES.has(status.toLowerCase())) return true
  const error = payload.error
  if (isRecord(error)) {
    const code = error.code
    if (typeof code === 'string' && DEVICE_PENDING_STATUSES.has(code.toLowerCase())) return true
  }
  return false
}

/**
 * The error code a device endpoint named, if it named one.
 *
 * A named `error.code` is read before the top-level `status`, so a status word
 * (`pending`) cannot be quoted as the reason when the body also says what went
 * wrong.
 */
function deviceErrorIdentifier(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const candidates: unknown[] = [payload.code]
  const error = payload.error
  if (typeof error === 'string') candidates.push(error)
  else if (isRecord(error)) candidates.push(error.code, error.type)
  candidates.push(payload.status)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) return candidate
  }
  return undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
