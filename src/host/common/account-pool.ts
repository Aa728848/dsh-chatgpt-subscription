import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import type {
  AccountAuthStatus,
  AccountRotationStrategy,
  PoolAccountSummaryDto,
} from '../../shared/account-pool-contracts.ts'

/** Refresh an access token this many milliseconds before it expires. */
export const POOL_REFRESH_MARGIN_MS = 60_000

/** Shortest cooldown a 429 may impose; a provider asking for less is clamped. */
const MIN_COOLDOWN_MS = 10_000

/** Accounts a single pool may hold before `addAccount` refuses another one. */
export const DEFAULT_MAX_POOL_ACCOUNTS = 20

/**
 * The parts of a pooled account every provider line agrees on.
 *
 * A provider's own account type extends this with whatever non-secret display
 * facts its card renders (project id, key name, region, plan …).
 */
export interface PoolAccountShape<TCredentials> {
  id: string
  alias: string
  credentials: TCredentials
  addedAt: number
  lastUsedAt?: number
  isPrimary?: boolean
  cooldownUntil?: number
  cooldownReason?: string
  authStatus?: AccountAuthStatus
  authFailedReason?: string
}

/** One provider's whole pool document, as it lives in encrypted storage. */
export interface PoolData<TAccount> {
  version: 1
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  accounts: TAccount[]
}

/** Everything the core hands a provider hook that mints an account record. */
export interface PoolAccountInput<TCredentials, TAccount> {
  id: string
  alias: string
  credentials: TCredentials
  addedAt: number
  isPrimary: boolean
  /** The account this one replaces, when the dedupe key already exists. */
  existing?: TAccount
}

/**
 * Provider-specific behaviour of one account pool.
 *
 * The storage, serialization, eligibility, rotation and cooldown rules live in
 * {@link AccountPoolCore}; only these hooks differ per provider line.
 */
export interface AccountPoolHooks<
  TCredentials,
  TAccount extends PoolAccountShape<TCredentials>,
  TSummary extends PoolAccountSummaryDto,
> {
  /** Provider id used in storage descriptions and diagnostics. */
  providerId: string
  /** Human label used in the messages the core raises. */
  displayName: string
  /** Plaintext path of the pool file; the encrypted variants derive from it. */
  poolFile: string
  /** Keychain / Secret Service service name on macOS and Linux. */
  keychainService: string
  /** Validate and normalize one whole pool document. */
  parsePoolData(value: unknown): PoolData<TAccount>
  /** Mint an account record; the core only decides id, alias and primary flag. */
  createAccount(input: PoolAccountInput<TCredentials, TAccount>): TAccount
  /** Identity two credentials share when they are the same upstream account. */
  dedupeKey?(credentials: TCredentials): string | undefined
  /**
   * Stable id to store a new account under, instead of a generated one.
   *
   * A provider that already keys its accounts by a public, non-secret identity
   * (one that its stored settings also reference) returns that key here. Doing
   * so keeps every id the settings card sends back — a pinned account, a hidden
   * account — meaningful to the pool without a translation layer or a migration.
   */
  accountId?(credentials: TCredentials): string | undefined
  /** Alias for an account whose credentials name nothing the user would recognize. */
  defaultAlias(credentials: TCredentials, position: number): string
  /** Unix milliseconds the access token expires; absent for a non-expiring key. */
  expiresAt?(credentials: TCredentials): number | undefined
  /** Whether the credential must be refreshed before the next request. */
  needsRefresh?(credentials: TCredentials, now: number): boolean
  /** Refresh one credential, returning the value to persist back into the pool. */
  refresh?(credentials: TCredentials, fetchFn: typeof fetch): Promise<TCredentials>
  /**
   * Classify a failed refresh.
   *
   * Returning a status takes that account out of rotation (it is kept, so a new
   * sign-in restores it) and lets the next eligible account serve the request.
   * Returning undefined lets the refresh error surface: a transient failure
   * must not cost an account its place in the pool.
   */
  refreshFailureStatus?(error: unknown): AccountAuthStatus | undefined
  /**
   * Reason the stored credential is already known to be unusable (a rejected
   * refresh token, for instance). Reported purely: nothing is written here.
   */
  authRejectedReason?(credentials: TCredentials): string | undefined
  /** Pre-pool single credential, projected as the primary account on read. */
  legacyAccount?(): Promise<TAccount | null>
  /** Mirror the primary account into the single-credential store; `null` clears it. */
  mirrorPrimary?(credentials: TCredentials | null): Promise<void>
  /**
   * Add the provider's own display facts (project id, key name, region …) to
   * the shared summary the core already filled in.
   */
  extendSummary?(account: TAccount, base: PoolAccountSummaryDto, now: number): TSummary
  /** Message raised when the pool holds no account at all. */
  emptyMessage?: string
  /** Message raised when every account is cooling down or unusable. */
  allUnavailableMessage?(count: number, waitMinutes: number): string
  /** Accounts this pool accepts; defaults to {@link DEFAULT_MAX_POOL_ACCOUNTS}. */
  maxAccounts?: number
  /**
   * Account the user pinned in settings, or null/absent for automatic choice.
   *
   * When set and the account is eligible, it is chosen ahead of the rotation
   * strategy; when it is ineligible the automatic choice takes over rather than
   * failing the request, because a pinned account that is cooling down must not
   * take the line offline.
   */
  preferAccountId?(): string | null
  /** Test seam; production builds the platform backend from the paths above. */
  backend?: CredentialStore<PoolData<TAccount>>
}

/** Stable keychain account name for one pool file, isolated per `DSH_HOME`. */
/** Accept a stored rotation strategy, or fall back to sequential. */
export function normalizeRotationStrategy(value: unknown): AccountRotationStrategy {
  return value === 'round-robin' || value === 'sticky' ? value : 'sequential'
}

export function poolCredentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

// Every mutating operation on one pool file is serialized, so a concurrent
// refresh, login and route update cannot interleave a read-modify-write.
const poolOperations = new Map<string, Promise<void>>()

/**
 * The shared multi-account pool: encrypted storage, eligibility filtering,
 * rotation strategy, 429 cooldowns and per-account auth failures.
 *
 * @typeParam TCredentials - the provider's stored credential shape.
 * @typeParam TAccount - the provider's pooled account record.
 * @typeParam TSummary - the public DTO the settings card renders.
 */
export class AccountPoolCore<
  TCredentials,
  TAccount extends PoolAccountShape<TCredentials>,
  TSummary extends PoolAccountSummaryDto,
> {
  protected readonly hooks: AccountPoolHooks<TCredentials, TAccount, TSummary>
  private readonly filePath: string
  private readonly backend: CredentialStore<PoolData<TAccount>>
  /**
   * Bumped by every write that can move which account serves a request.
   *
   * Reading it costs nothing — unlike {@link read}, which decrypts the pool file
   * (a DPAPI unprotect through a spawned `powershell.exe` on Windows, ~200 ms).
   * A cache that must not report one account's data under another account's name
   * can therefore invalidate on identity change without paying a credential read
   * to discover it.
   */
  private identityRevision = 0

  constructor(hooks: AccountPoolHooks<TCredentials, TAccount, TSummary>) {
    this.hooks = hooks
    this.filePath = hooks.poolFile
    this.backend = hooks.backend ?? createPoolBackend(hooks)
  }

  /**
   * A cheap, in-memory revision of the pool's serving identity.
   *
   * Compared against a previously observed value to detect an account change
   * without decrypting the pool file. Every mutating write advances it, because
   * which account a request resolves to depends on more than membership:
   * eligibility reads `authStatus` and `cooldownUntil`, and the rotation
   * strategy reads `isPrimary`, `activeAccountId` and `lastUsedAt`. All of
   * those are written through {@link write}, so bumping it there covers every
   * one of them without having to enumerate them per mutator.
   * Over-invalidating only costs one credential read, while under-invalidating
   * would report one account's usage under another account's name.
   */
  currentIdentityRevision(): number {
    return this.identityRevision
  }

  /** Human description of where this pool's credentials live. */
  path(): string {
    if (process.platform === 'win32') return `${this.filePath}.dpapi`
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return `${kind}: ${this.hooks.keychainService}/${poolCredentialAccount(this.filePath)}`
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.filePath)
    const result = (poolOperations.get(key) || Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    poolOperations.set(key, settled)
    void settled.then(() => {
      if (poolOperations.get(key) === settled) poolOperations.delete(key)
    })
    return result
  }

  private async saveVerified(data: PoolData<TAccount>): Promise<void> {
    const normalized = this.hooks.parsePoolData(data)
    await this.backend.save(normalized)
    const restored = await this.backend.load()
    if (!isDeepStrictEqual(restored, normalized)) {
      throw new Error(`${this.hooks.displayName} pool encrypted verification failed`)
    }
  }

  /**
   * Read the pool.
   *
   * A pool that holds no account yet projects the pre-pool single credential as
   * the primary account. That projection stays side-effect free on purpose:
   * every caller that changes the pool writes it back immediately afterwards,
   * so persisting it here only bought an extra encrypted round trip and made a
   * getter write to disk.
   */
  read(): Promise<PoolData<TAccount>> {
    return this.serialize(async () => {
      let current: PoolData<TAccount> | null = null
      try {
        current = await this.backend.load()
      } catch {
        // Corrupt file recovery: fall through to the legacy projection.
      }

      if (current !== null && Array.isArray(current.accounts) && current.accounts.length > 0) {
        return current
      }

      try {
        const legacy = await this.hooks.legacyAccount?.()
        if (legacy) {
          return {
            version: 1,
            activeAccountId: legacy.id,
            rotationStrategy: current?.rotationStrategy || 'sequential',
            accounts: [legacy],
          }
        }
      } catch {
        // ignore migration failures
      }

      return current || {
        version: 1,
        rotationStrategy: 'sequential',
        accounts: [],
      }
    })
  }

  write(data: PoolData<TAccount>): Promise<void> {
    // Advance the cheap identity revision here rather than in each mutator:
    // every path that can move which account serves a request goes through this
    // method, and forgetting one would let a per-account cache outlive its
    // account. It is bumped before the await so a write that fails still
    // invalidates: a spurious credential read is cheap, a stale quota card is not.
    this.identityRevision += 1
    return this.serialize(() => this.saveVerified(this.hooks.parsePoolData(data)))
  }

  /** Public summaries, with cooldowns that already expired reported as absent. */
  async listAccounts(): Promise<TSummary[]> {
    const data = await this.read()
    const now = Date.now()
    return data.accounts.map((account) => {
      const summary = this.summarize(account, now)
      return summary
    })
  }

  protected summarize(account: TAccount, now: number): TSummary {
    const expires = this.hooks.expiresAt?.(account.credentials)
    const cooling = account.cooldownUntil !== undefined && account.cooldownUntil > now
    const summary: PoolAccountSummaryDto = {
      id: account.id,
      alias: account.alias,
      isPrimary: account.isPrimary === true,
      ...(account.authStatus && account.authStatus !== 'ok' ? { authStatus: account.authStatus } : {}),
      ...(account.authFailedReason && account.authStatus && account.authStatus !== 'ok'
        ? { authFailedReason: account.authFailedReason }
        : {}),
      ...(account.lastUsedAt === undefined ? {} : { lastUsedAt: account.lastUsedAt }),
      ...(cooling
        ? { cooldownUntil: account.cooldownUntil, ...(account.cooldownReason === undefined ? {} : { cooldownReason: account.cooldownReason }) }
        : {}),
      ...(expires === undefined ? {} : { expiresAt: expires }),
    }
    return this.hooks.extendSummary ? this.hooks.extendSummary(account, summary, now) : (summary as TSummary)
  }

  /** Add or re-authorize one account; an existing dedupe key updates in place. */
  async addAccount(credentials: TCredentials, alias?: string): Promise<TAccount> {
    const data = await this.read()
    const key = this.hooks.dedupeKey?.(credentials)
    const existingIndex = key === undefined
      ? -1
      : data.accounts.findIndex((account) => this.hooks.dedupeKey?.(account.credentials) === key)
    const maxAccounts = this.hooks.maxAccounts ?? DEFAULT_MAX_POOL_ACCOUNTS
    if (existingIndex < 0 && data.accounts.length >= maxAccounts) {
      throw new Error(`${this.hooks.displayName} 号池最多支持 ${maxAccounts} 个账号，请先删除不再使用的账号。`)
    }

    const existing = existingIndex >= 0 ? data.accounts[existingIndex] : undefined
    const id = existing === undefined
      ? (this.hooks.accountId?.(credentials) ?? `acc_${randomBytes(6).toString('hex')}`)
      : existing.id
    const isPrimary = data.accounts.length === 0 || existing?.isPrimary === true
    const created = this.hooks.createAccount({
      id,
      alias: alias?.trim() || this.hooks.defaultAlias(credentials, data.accounts.length + 1),
      credentials,
      addedAt: Date.now(),
      isPrimary,
      ...(existing === undefined ? {} : { existing }),
    })
    // Fresh credentials came from a successful sign-in, so an account that was
    // flagged as needing one is routable again.
    const account: TAccount = existing === undefined
      ? created
      : { ...existing, ...created, id, authStatus: undefined, authFailedReason: undefined }

    if (existingIndex >= 0) data.accounts[existingIndex] = account
    else data.accounts.push(account)

    if (!data.activeAccountId || account.isPrimary) data.activeAccountId = account.id

    await this.write(data)
    // Keep the pre-pool single-credential store in step with the primary account.
    if (account.isPrimary) {
      void this.hooks.mirrorPrimary?.(credentials).catch(() => undefined)
    }
    return account
  }

  async setPrimary(accountId: string): Promise<void> {
    const data = await this.read()
    for (const account of data.accounts) {
      account.isPrimary = account.id === accountId
    }
    const primary = data.accounts.find((account) => account.isPrimary)
    if (primary) {
      data.activeAccountId = primary.id
      void this.hooks.mirrorPrimary?.(primary.credentials).catch(() => undefined)
    }
    await this.write(data)
  }

  /**
   * Persist a refreshed credential for one account.
   *
   * Used by a forced refresh (a 401 mid-request) rather than by the rotating
   * getEffectiveAccount path, which already writes back what it refreshed.
   */
  async updateAccountCredentials(accountId: string, credentials: TCredentials): Promise<TAccount | undefined> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target === undefined) return undefined
    target.credentials = credentials
    await this.write(data)
    if (target.isPrimary) {
      void this.hooks.mirrorPrimary?.(credentials).catch(() => undefined)
    }
    return target
  }

  async setAlias(accountId: string, alias: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target && alias.trim()) {
      target.alias = alias.trim()
      await this.write(data)
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    const data = await this.read()
    const wasPrimary = data.accounts.find((account) => account.id === accountId)?.isPrimary
    data.accounts = data.accounts.filter((account) => account.id !== accountId)
    if (wasPrimary && data.accounts.length > 0) {
      data.accounts[0]!.isPrimary = true
      void this.hooks.mirrorPrimary?.(data.accounts[0]!.credentials).catch(() => undefined)
    } else if (data.accounts.length === 0) {
      void this.hooks.mirrorPrimary?.(null).catch(() => undefined)
    }
    if (data.activeAccountId === accountId) {
      data.activeAccountId = data.accounts.find((account) => account.isPrimary)?.id ?? data.accounts[0]?.id
    }
    await this.write(data)
  }

  async setStrategy(strategy: AccountRotationStrategy): Promise<void> {
    const data = await this.read()
    data.rotationStrategy = strategy
    await this.write(data)
  }

  /** Cool one account down after an upstream 429. */
  async markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target) {
      target.cooldownUntil = Date.now() + Math.max(MIN_COOLDOWN_MS, durationMs)
      target.cooldownReason = reason
      await this.write(data)
    }
  }

  async clearCooldown(accountId: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target) {
      target.cooldownUntil = undefined
      target.cooldownReason = undefined
      await this.write(data)
    }
  }

  /**
   * Record that an account can no longer authenticate.
   *
   * The account stays in the pool: signing in again is what restores it, and a
   * deleted account would take the user's alias and ordering with it.
   */
  async markAuthFailed(accountId: string, reason: string, status: AccountAuthStatus = 'expired'): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target) {
      target.authStatus = status
      target.authFailedReason = reason
      await this.write(data)
    }
  }

  async clearAuthFailed(accountId: string): Promise<void> {
    const data = await this.read()
    const target = data.accounts.find((account) => account.id === accountId)
    if (target) {
      target.authStatus = undefined
      target.authFailedReason = undefined
      await this.write(data)
    }
  }

  /** Whether an account may serve a request right now. */
  protected isEligible(account: TAccount, now: number, triedAccountIds?: ReadonlySet<string>): boolean {
    if (triedAccountIds?.has(account.id)) return false
    if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
    if (account.cooldownUntil !== undefined && account.cooldownUntil > now) return false
    if (this.hooks.authRejectedReason?.(account.credentials)) return false
    return true
  }

  async hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    const data = await this.read()
    const now = Date.now()
    return data.accounts.some((account) => this.isEligible(account, now, triedAccountIds))
  }

  /**
   * Read one account's credential for work that is *not* a metered model
   * request, without letting rotation state stand in the way.
   *
   * There are two different questions, and conflating them broke both:
   *
   * - "which account should serve this request?" — a routing decision, answered
   *   by {@link getEffectiveAccount} through cooldowns, auth status and the
   *   rotation strategy.
   * - "may I have a usable ChatGPT credential?" — a credential question, asked
   *   by the web search, web fetch and image tools.
   *
   * A spent Codex rate-limit window says nothing about the other ChatGPT
   * endpoints: search, fetch and image generation are not metered against it and
   * keep working with the very same token. Routing those tools through
   * {@link getEffectiveAccount} made one exhausted window fail all of them —
   * and reported it as "credentials are required", which sent people looking for
   * a sign-in problem they did not have.
   *
   * A credential that is *known* to be unusable is still refused (a rejected
   * refresh token, an account the upstream already rejected at sign-in); only
   * cooldowns — which are rotation bookkeeping — are ignored.
   *
   * @param fetchFn - fetch used if the credential is close to expiry.
   */
  async getCredentialAccount(fetchFn: typeof fetch = fetch): Promise<{ account: TAccount; credentials: TCredentials }> {
    const data = await this.read()
    if (data.accounts.length === 0) {
      throw new Error(this.hooks.emptyMessage ?? `未登录 ${this.hooks.displayName} 账号，请先在设置页添加账号。`)
    }

    const now = Date.now()
    const usable = data.accounts.filter((account) => this.isCredentialUsable(account))
    if (usable.length === 0) {
      throw new LlmError(
        `全部 ${data.accounts.length} 个 ${this.hooks.displayName} 账号均需要重新登录。`,
        'AUTH',
        { status: 401 },
      )
    }

    const selected = this.selectAccount(usable, data)
    if (this.shouldRefreshCredential(selected, now) && this.hooks.refresh) {
      // The refresh token rotates, so a refreshed pair must be persisted before
      // it is used: dropping it here would leave the store holding a token the
      // upstream has already invalidated, and the next sign-in check would fail.
      const refreshed = await this.hooks.refresh(selected.credentials, fetchFn)
      await this.updateAccountCredentials(selected.id, refreshed)
      return { account: selected, credentials: refreshed }
    }
    // Deliberately no lastUsedAt / activeAccountId write: reading a credential
    // for an auxiliary tool must not move the conversational rotation.
    return { account: selected, credentials: selected.credentials }
  }

  /**
   * Refresh one named account's credential for a caller that is not a metered
   * model request.
   *
   * The settings card is what this exists for. It addresses an account by id
   * rather than taking a rotation slot, and it used to hand the stored
   * credential to the provider unchanged; with a 15-minute access token that
   * meant a card opened more than a quarter of an hour after the last model
   * request sent an expired bearer to the usage endpoint and was answered with
   * 401 — "sign in again" for a credential that a plain refresh would have
   * renewed.
   *
   * Rotation bookkeeping is deliberately ignored, matching
   * {@link getCredentialAccount}: a cooldown or a pinned account describes
   * routing, not whether the credential can be read. A credential the provider
   * has already declared unusable is still refused, because refreshing it
   * cannot succeed.
   *
   * @param accountId - the pool account to read, or undefined for the primary.
   * @param fetchFn - fetch used by the provider's token refresh.
   */
  async getFreshCredential(accountId?: string, fetchFn: typeof fetch = fetch): Promise<TCredentials> {
    return this.credentialFor(accountId, fetchFn, false)
  }

  /**
   * Renew one account's credential unconditionally.
   *
   * This is the answer to a 401 that the local clock did not predict: an access
   * token can be revoked upstream or rotated by another holder while it still
   * looks unexpired, and only the service's own refusal says so. Renewing it is
   * what separates that from a credential that genuinely needs a new sign-in.
   */
  async renewCredential(accountId?: string, fetchFn: typeof fetch = fetch): Promise<TCredentials> {
    return this.credentialFor(accountId, fetchFn, true)
  }

  /**
   * Resolve, and if needed renew, one account's credential.
   *
   * With no id the account that would serve the next request is used — the
   * active one, then the primary, then the first — because a caller that does
   * not name an account (the catalog loader) still has to present the
   * credential that is actually in play.
   */
  private async credentialFor(
    accountId: string | undefined,
    fetchFn: typeof fetch,
    force: boolean,
  ): Promise<TCredentials> {
    const data = await this.read()
    const target = accountId === undefined
      ? (data.accounts.find((account) => account.id === data.activeAccountId)
        ?? data.accounts.find((account) => account.isPrimary)
        ?? data.accounts[0])
      : data.accounts.find((account) => account.id === accountId)
    if (target === undefined) {
      throw new LlmError(this.hooks.emptyMessage ?? `未登录 ${this.hooks.displayName} 账号，请先在设置页添加账号。`, 'AUTH')
    }
    if (!this.isCredentialUsable(target)) {
      throw new LlmError(
        `${this.hooks.displayName} 账号的凭据已被拒绝，需要重新登录。`,
        'AUTH',
        { status: 401 },
      )
    }
    if (!force && (!this.shouldRefreshCredential(target, Date.now()) || !this.hooks.refresh)) {
      return target.credentials
    }
    if (!this.hooks.refresh) return target.credentials

    let refreshed: TCredentials
    try {
      refreshed = await this.hooks.refresh(target.credentials, fetchFn)
    } catch (error) {
      // Same policy as a metered request: a refresh the provider calls final is
      // that account's problem, and the card should say so rather than keep
      // presenting a credential the upstream has already refused.
      const status = this.hooks.refreshFailureStatus?.(error)
      if (status !== undefined) {
        await this.markAuthFailed(target.id, error instanceof Error ? error.message : String(error), status)
          .catch(() => undefined)
      }
      throw error
    }
    // The refresh token rotates, so the rotated pair is persisted before it is
    // used: dropping it here would leave the pool holding a token the upstream
    // has already invalidated.
    await this.updateAccountCredentials(target.id, refreshed)
    return refreshed
  }

  /** Whether one account's credential must be refreshed before it is handed out. */
  private shouldRefreshCredential(account: TAccount, now: number): boolean {
    if (this.hooks.needsRefresh) return this.hooks.needsRefresh(account.credentials, now)
    const expires = this.hooks.expiresAt?.(account.credentials)
    return expires !== undefined && expires <= now + POOL_REFRESH_MARGIN_MS
  }

  /**
   * Whether an account's stored credential is known to be unusable.
   *
   * Rotation bookkeeping — cooldowns, the tried set — is deliberately absent:
   * those describe routing, not the credential.
   */
  protected isCredentialUsable(account: TAccount): boolean {
    if (account.authStatus !== undefined && account.authStatus !== 'ok') return false
    if (this.hooks.authRejectedReason?.(account.credentials)) return false
    return true
  }

  /** The account a rotation strategy picks out of an already-eligible set. */
  private selectAccount(eligible: TAccount[], data: PoolData<TAccount>): TAccount {
    // A pinned account wins while it is eligible; otherwise the strategy below
    // decides, so a pinned account that is cooling down degrades to automatic
    // selection instead of failing the turn.
    const pinned = this.hooks.preferAccountId?.() ?? null
    const pinnedAccount = pinned === null ? undefined : eligible.find((account) => account.id === pinned)
    if (pinnedAccount !== undefined) return pinnedAccount
    if (data.rotationStrategy === 'round-robin') {
      // Least recently used first, so a burst spreads over the whole pool.
      return [...eligible].sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))[0]!
    }
    if (data.rotationStrategy === 'sticky') {
      // Keep the account that served the previous request while it is eligible —
      // this is what protects an upstream prefix cache across a conversation.
      return eligible.find((account) => account.id === data.activeAccountId)
        || eligible.find((account) => account.isPrimary)
        || eligible[0]!
    }
    // Sequential: prefer the primary account, then the first eligible one.
    return eligible.find((account) => account.isPrimary) || eligible[0]!
  }

  /** The error every-account-unavailable raises, including the shortest wait. */
  private allUnavailableError(data: PoolData<TAccount>, now: number): LlmError {
    let shortest = Infinity
    for (const account of data.accounts) {
      if (account.cooldownUntil !== undefined && account.cooldownUntil > now) {
        shortest = Math.min(shortest, account.cooldownUntil - now)
      }
    }
    const waitMinutes = Number.isFinite(shortest) ? Math.ceil(shortest / 60_000) : 15
    return new LlmError(
      this.hooks.allUnavailableMessage?.(data.accounts.length, waitMinutes)
        ?? `全部 ${data.accounts.length} 个 ${this.hooks.displayName} 账号均处于配额限制或冷却中 (429)。最短预计在 ${waitMinutes} 分钟后解除冷却。`,
      'RATE_LIMIT',
      { status: 429 },
    )
  }

  /**
   * Pick the account for the next request, refreshing its credential when it is
   * about to expire.
   *
   * @param excludeIds - accounts already tried for this request, so a retry
   *   lands on a different account.
   * @param fetchFn - fetch used by the provider's token refresh.
   * @throws LlmError with `RATE_LIMIT` when every account is cooling down.
   */
  async getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: TAccount; credentials: TCredentials }> {
    const data = await this.read()
    if (data.accounts.length === 0) {
      throw new Error(this.hooks.emptyMessage ?? `未登录 ${this.hooks.displayName} 账号，请先在设置页添加账号。`)
    }

    const now = Date.now()
    const eligible = data.accounts.filter((account) => this.isEligible(account, now, excludeIds))
    if (eligible.length === 0) throw this.allUnavailableError(data, now)

    const selected = this.selectAccount(eligible, data)

    if (this.shouldRefreshCredential(selected, now) && this.hooks.refresh) {
      let refreshed: TCredentials
      try {
        refreshed = await this.hooks.refresh(selected.credentials, fetchFn)
      } catch (error) {
        const status = this.hooks.refreshFailureStatus?.(error)
        if (status === undefined) throw error
        // A refresh the provider calls final is that account's problem alone:
        // mark it and let another account serve the request.
        await this.markAuthFailed(selected.id, error instanceof Error ? error.message : String(error), status)
        const nextExclude = new Set(excludeIds ?? [])
        nextExclude.add(selected.id)
        if (await this.hasAnotherAvailableAccount(nextExclude)) {
          return this.getEffectiveAccount(nextExclude, fetchFn)
        }
        throw error
      }
      selected.credentials = refreshed
      const index = data.accounts.findIndex((account) => account.id === selected.id)
      if (index >= 0) data.accounts[index] = selected
      if (selected.isPrimary) {
        void this.hooks.mirrorPrimary?.(refreshed).catch(() => undefined)
      }
    }

    selected.lastUsedAt = now
    data.activeAccountId = selected.id
    // Bookkeeping only: remembering which account was used last must never be
    // the reason a request cannot get its credential. A pool file that has
    // become temporarily unwritable (a locked replace, a wedged helper) used to
    // surface as "credentials could not be refreshed" on the quota card, while
    // the credential itself was perfectly usable. Writes that *are* the user's
    // intent — adding, deleting, cooling down — stay strict.
    await this.write(data).catch(() => undefined)

    return { account: selected, credentials: selected.credentials }
  }
}

/** Build the encrypted platform backend one pool file uses. */
function createPoolBackend<
  TCredentials,
  TAccount extends PoolAccountShape<TCredentials>,
  TSummary extends PoolAccountSummaryDto,
>(hooks: AccountPoolHooks<TCredentials, TAccount, TSummary>): CredentialStore<PoolData<TAccount>> {
  const filePath = hooks.poolFile
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, hooks.parsePoolData)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(hooks.keychainService, poolCredentialAccount(filePath), hooks.parsePoolData)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(hooks.keychainService, poolCredentialAccount(filePath), hooks.parsePoolData)
  }
  throw new Error(`${hooks.displayName} pool encrypted storage requires Windows, macOS, or Linux.`)
}
