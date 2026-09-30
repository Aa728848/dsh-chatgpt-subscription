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
  /**
   * Best-effort repair for an account the pool no longer owns.
   *
   * The pool holds a COPY of an account's credential when one was adopted from
   * another application, and a copy can go stale: the moment either side rotates,
   * the refresh token the pool holds is spent. Recovery is not a refresh (that
   * would spend the dead token again) but a re-read of the authority, keeping the
   * authoritative copy only when it still describes the same account.
   *
   * Returning null means "no newer authority"; the pool then leaves the row alone.
   * Absent means the provider keeps no external authority at all.
   *
   * The "has it moved on" test belongs to the provider, which knows what identity
   * means for its credential: the core only asks for the authority and lets the
   * provider decide whether it is a newer state of the same account.
   */
  liveCredentialsFor?(account: TAccount): Promise<{ credentials: TCredentials; advanced: boolean } | null>
  /**
   * Best-effort, local-store synchronization after a credential commit.
   *
   * Runs under the pool lock and only once the pool write is verified, so a
   * provider mirror can never get ahead of the pool. It must not re-enter the
   * pool, and a failure is swallowed: the committed pool is the authority.
   */
  credentialsCommitted?(account: TAccount): Promise<void>
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

// Locks and refresh flights are shared by every instance addressing one pool
// file. Only storage transactions hold the file lock; network refreshes never
// do. This coordinates one host process, not another application.
const poolOperations = new Map<string, Promise<void>>()
const poolIdentityRevisions = new Map<string, number>()
const poolRefreshes = new Map<string, { credentials: unknown; result: Promise<unknown> }>()

/**
 * A selected row was deleted, or became unusable, while a caller awaited it.
 *
 * Distinct from every other credential error because a MODEL REQUEST can still
 * be served by another account: routing excludes the row and tries the next
 * one, while a caller that named the account still gets the plain refusal.
 */
class PoolAccountUnavailableError extends LlmError {}

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
  /** Pool-file identity of this instance: locks, revisions and flights key on it. */
  private readonly operationKey: string

  constructor(hooks: AccountPoolHooks<TCredentials, TAccount, TSummary>) {
    this.hooks = hooks
    this.filePath = hooks.poolFile
    this.backend = hooks.backend ?? createPoolBackend(hooks)
    const resolved = path.resolve(this.filePath)
    // Windows paths are case-insensitive: two spellings are one pool file.
    this.operationKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
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
    return poolIdentityRevisions.get(this.operationKey) ?? 0
  }

  /** Human description of where this pool's credentials live. */
  path(): string {
    if (process.platform === 'win32') return `${this.filePath}.dpapi`
    const kind = process.platform === 'darwin' ? 'Keychain' : 'Secret Service'
    return `${kind}: ${this.hooks.keychainService}/${poolCredentialAccount(this.filePath)}`
  }

  /**
   * Queue one storage transaction for this pool file.
   *
   * NOT reentrant: a transaction must use {@link loadPoolData} and
   * {@link updatePool} rather than calling the public read/write methods.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.operationKey
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
    return this.serialize(() => this.loadPoolData())
  }

  /**
   * Load the pool without holding the file lock.
   *
   * Providers override this to maintain their own in-memory indexes, so every
   * load — including one inside {@link updatePool} — refreshes them.
   */
  protected async loadPoolData(): Promise<PoolData<TAccount>> {
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

    // An explicitly empty pool is authoritative too: a best-effort legacy clear
    // that failed must not resurrect a just-deleted account on the next read.
    return current || {
      version: 1,
      rotationStrategy: 'sequential',
      accounts: [],
    }
  }

  private async persistPoolData(data: PoolData<TAccount>): Promise<void> {
    // Advance the cheap identity revision rather than in each mutator: every
    // path that can move which account serves a request lands here, and
    // forgetting one would let a per-account cache outlive its account. It is
    // bumped before the await so a failed write still invalidates: a spurious
    // credential read is cheap, a stale quota card is not. Shared per file, so
    // every instance observes the same serving identity.
    poolIdentityRevisions.set(this.operationKey, this.currentIdentityRevision() + 1)
    await this.saveVerified(data)
  }

  /**
   * Replace the whole document (initialization, import), NOT a read-modify-write.
   * Prefer {@link updatePool} for mutations so the draft is read under the lock.
   */
  write(data: PoolData<TAccount>): Promise<void> {
    return this.serialize(() => this.persistPoolData(data))
  }

  /**
   * Read the LATEST document, mutate it and persist it as one file transaction.
   *
   * This is the whole fix for the read-modify-write race: the old shape read a
   * snapshot, awaited (a token refresh, a settings write, an encrypted round
   * trip) and then wrote that whole stale snapshot back, erasing whatever landed
   * in between — including another account's freshly rotated token.
   *
   * The callback runs under the file lock, so it must not call read, write or
   * updatePool (the lock is not reentrant) and must not do network I/O.
   * Provider-local stores belong in `afterCommit`, which runs only once the
   * pool write is verified, and must not re-enter the pool either.
   */
  protected updatePool<T>(
    mutate: (data: PoolData<TAccount>) => T | Promise<T>,
    afterCommit?: (data: PoolData<TAccount>, result: T) => Promise<void>,
  ): Promise<T> {
    return this.serialize(async () => {
      const data = await this.loadPoolData()
      const before = structuredClone(data)
      const result = await mutate(data)
      if (!isDeepStrictEqual(before, data)) {
        await this.persistPoolData(data)
        // Ordered AFTER the commit and awaited, so a slow older mirror cannot
        // overwrite a newer one. Mirrors stay best-effort: a failure here must
        // not undo a commit that is already on disk.
        await afterCommit?.(data, result).catch(() => undefined)
        for (const account of data.accounts) {
          const previous = before.accounts.find((entry) => entry.id === account.id)
          if (!isDeepStrictEqual(previous?.credentials, account.credentials)) {
            await this.hooks.credentialsCommitted?.(account).catch(() => undefined)
          }
        }
        const previousPrimary = before.accounts.find((account) => account.isPrimary)
        const primary = data.accounts.find((account) => account.isPrimary)
        if (previousPrimary?.id !== primary?.id
          || !isDeepStrictEqual(previousPrimary?.credentials, primary?.credentials)) {
          await this.hooks.mirrorPrimary?.(primary?.credentials ?? null).catch(() => undefined)
        }
      }
      return result
    })
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
  addAccount(credentials: TCredentials, alias?: string): Promise<TAccount> {
    return this.updatePool((data) => this.addAccountToPool(data, credentials, alias))
  }

  /**
   * Add or re-authorize inside an existing transaction.
   *
   * Capacity, dedupe and the primary decision are all taken against the live
   * document, so two simultaneous sign-ins cannot each pass a check the other
   * has already invalidated.
   */
  protected addAccountToPool(data: PoolData<TAccount>, credentials: TCredentials, alias?: string): TAccount {
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
    return account
  }

  setPrimary(accountId: string): Promise<void> {
    return this.updatePool((data) => {
      for (const account of data.accounts) {
        account.isPrimary = account.id === accountId
      }
      const primary = data.accounts.find((account) => account.isPrimary)
      if (primary) data.activeAccountId = primary.id
    })
  }

  /**
   * Persist a refreshed credential for one account.
   *
   * `expected` makes this a conditional write: when the stored credential is
   * no longer the one the caller started from, something newer won the race (a
   * re-login, a rotation committed while this call was in flight) and the
   * latest row is returned WITHOUT being overwritten. A deleted account is
   * never brought back.
   *
   * Used by a forced refresh (a 401 mid-request) rather than by the rotating
   * getEffectiveAccount path, which refreshes through its own single-flight.
   */
  updateAccountCredentials(
    accountId: string, credentials: TCredentials, expected?: TCredentials,
  ): Promise<TAccount | undefined> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target && (expected === undefined || isDeepStrictEqual(target.credentials, expected))) {
        target.credentials = credentials
      }
      return target
    })
  }

  setAlias(accountId: string, alias: string): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target && alias.trim()) target.alias = alias.trim()
    })
  }

  deleteAccount(accountId: string): Promise<void> {
    return this.updatePool((data) => this.deleteAccountFromPool(data, accountId))
  }

  /**
   * Remove one account inside a transaction.
   *
   * Provider refusal rules (a snapshot this plugin does not own, a desktop
   * account it may only hide) belong in an override of this, so the check and
   * the removal cannot be separated by a concurrent change.
   */
  protected deleteAccountFromPool(data: PoolData<TAccount>, accountId: string): void {
    const wasPrimary = data.accounts.find((account) => account.id === accountId)?.isPrimary
    data.accounts = data.accounts.filter((account) => account.id !== accountId)
    if (wasPrimary && data.accounts.length > 0) data.accounts[0]!.isPrimary = true
    if (data.activeAccountId === accountId) {
      data.activeAccountId = data.accounts.find((account) => account.isPrimary)?.id ?? data.accounts[0]?.id
    }
  }

  setStrategy(strategy: AccountRotationStrategy): Promise<void> {
    return this.updatePool((data) => { data.rotationStrategy = strategy })
  }

  /** Cool one account down after an upstream 429. */
  markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target) {
        target.cooldownUntil = Date.now() + Math.max(MIN_COOLDOWN_MS, durationMs)
        target.cooldownReason = reason
      }
    })
  }

  clearCooldown(accountId: string): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target) { target.cooldownUntil = undefined; target.cooldownReason = undefined }
    })
  }

  /**
   * Record that an account can no longer authenticate.
   *
   * The account stays in the pool: signing in again is what restores it, and a
   * deleted account would take the user's alias and ordering with it.
   */
  markAuthFailed(accountId: string, reason: string, status: AccountAuthStatus = 'expired'): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target) { target.authStatus = status; target.authFailedReason = reason }
    })
  }

  clearAuthFailed(accountId: string): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target) { target.authStatus = undefined; target.authFailedReason = undefined }
    })
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
  async getCredentialAccount(
    fetchFn: typeof fetch = fetch, forceRefresh = false,
  ): Promise<{ account: TAccount; credentials: TCredentials }> {
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
    // The refresh token rotates, so a refreshed pair must be persisted before it
    // is used: dropping it here would leave the store holding a token the
    // upstream has already invalidated. freshAccount owns that commit.
    const account = await this.freshAccount(selected, fetchFn, forceRefresh)
    // Deliberately no lastUsedAt / activeAccountId write: reading a credential
    // for an auxiliary tool must not move the conversational rotation.
    return { account, credentials: account.credentials }
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
  async renewCredential(
    accountId?: string, fetchFn: typeof fetch = fetch, expected?: TCredentials,
  ): Promise<TCredentials> {
    return this.credentialFor(accountId, fetchFn, true, expected)
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
    expected?: TCredentials,
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
    // A caller that decided to renew while reading an OLDER generation must not
    // spend the replacement: that token already belongs to whoever replaced it.
    if (expected !== undefined && !isDeepStrictEqual(expected, target.credentials)) {
      return target.credentials
    }
    return (await this.freshAccount(target, fetchFn, force)).credentials
  }

  /**
   * Return one account's current row, refreshing it at most once per generation.
   *
   * Shared by every entry point — routing, auxiliary tools, the settings card
   * and forced renewals — across all instances of the pool file, because a
   * rotating refresh token may be spent once: two parallel exchanges both fail,
   * and the losing one gets recorded as a dead sign-in.
   *
   * Reading the current generation and registering/joining its flight happen in
   * one short transaction, so a commit cannot slip between the two decisions.
   * The network call is fired AFTER the lock is released, and the plan returned
   * from the lock is a plain value: awaiting a flight while holding the lock
   * would deadlock that flight's own commit.
   */
  private async freshAccount(target: TAccount, fetchFn: typeof fetch, force = false): Promise<TAccount> {
    let launch: (() => void) | undefined
    const plan = await this.serialize(async () => {
      const data = await this.loadPoolData()
      const current = data.accounts.find((account) => account.id === target.id)
      if (current === undefined || !this.isCredentialUsable(current)) {
        throw new PoolAccountUnavailableError(
          this.hooks.emptyMessage ?? '未登录 ' + this.hooks.displayName + ' 账号，请先在设置页添加账号。',
          'AUTH',
        )
      }
      if (!isDeepStrictEqual(current.credentials, target.credentials)) return { account: current }
      if (!this.hooks.refresh || (!force && !this.shouldRefreshCredential(current, Date.now()))) {
        return { account: current }
      }
      const key = JSON.stringify([this.operationKey, current.id])
      const pending = poolRefreshes.get(key)
      if (pending !== undefined && isDeepStrictEqual(pending.credentials, current.credentials)) {
        return { result: pending.result as Promise<TAccount> }
      }
      const result = new Promise<TAccount>((resolve, reject) => {
        launch = () => { void this.refreshAccount(current, fetchFn).then(resolve, reject) }
      })
      const flight = { credentials: structuredClone(current.credentials), result }
      poolRefreshes.set(key, flight)
      // Cleared on settle, including failure, so a rejected refresh cannot wedge
      // the account onto a promise that can never succeed again.
      const release = () => { if (poolRefreshes.get(key) === flight) poolRefreshes.delete(key) }
      void result.then(release, release)
      return { result }
    })
    launch?.()
    return plan.result ?? plan.account!
  }

  /**
   * Refresh one account: network outside the lock, then a conditional commit.
   *
   * Every write-back is checked against the credential the refresh started from,
   * which is what keeps a late response from restoring a spent token over a
   * re-login, and keeps a deleted account from coming back.
   */
  private async refreshAccount(target: TAccount, fetchFn: typeof fetch): Promise<TAccount> {
    const expected = structuredClone(target.credentials)
    // Spending a refresh token this account no longer owns is guaranteed to fail,
    // and the failure would be recorded as a dead sign-in. When the provider keeps
    // an authoritative copy elsewhere, a newer one means the row is stale rather
    // than dead, and adopting it is the repair.
    const live = await this.hooks.liveCredentialsFor?.(target).catch(() => null)
    if (live !== null && live !== undefined && live.advanced) {
      // The external store stays authoritative even if remembering it fails.
      const account = await this.updateAccountCredentials(target.id, live.credentials, expected)
        .catch(() => ({ ...target, credentials: live.credentials }))
      this.assertUsableAccount(account)
      return account
    }

    let refreshed: TCredentials
    try {
      refreshed = await this.hooks.refresh!(target.credentials, fetchFn)
    } catch (error) {
      // Same policy as a metered request: a refresh the provider calls final is
      // that account's problem, and the caller should say so rather than keep
      // presenting a credential the upstream has already refused. A failure on a
      // spent OLD token says nothing about a successful re-login, so the marker
      // is written only when the row still holds what this refresh started from.
      const status = this.hooks.refreshFailureStatus?.(error)
      let superseded: TAccount | undefined
      await this.updatePool((data) => {
        const current = data.accounts.find((account) => account.id === target.id)
        if (current === undefined) return
        if (!isDeepStrictEqual(current.credentials, expected)) {
          superseded = current
          return
        }
        if (status !== undefined) {
          current.authStatus = status
          current.authFailedReason = error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined)
      if (superseded !== undefined) {
        this.assertUsableAccount(superseded)
        return superseded
      }
      throw error
    }
    // The refresh token rotates, so the rotated pair is persisted before it is
    // used: dropping it here would leave the pool holding a token the upstream
    // has already invalidated. A strict write, unlike the bookkeeping below.
    const account = await this.updateAccountCredentials(target.id, refreshed, expected)
    this.assertUsableAccount(account)
    return account
  }

  private assertUsableAccount(account: TAccount | undefined): asserts account is TAccount {
    if (account === undefined) {
      throw new PoolAccountUnavailableError(
        this.hooks.emptyMessage ?? '未登录 ' + this.hooks.displayName + ' 账号，请先在设置页添加账号。',
        'AUTH',
      )
    }
    if (!this.isCredentialUsable(account)) {
      throw new PoolAccountUnavailableError(
        this.hooks.displayName + ' 账号的凭据已被拒绝，需要重新登录。',
        'AUTH',
        { status: 401 },
      )
    }
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
    forceRefresh = false,
  ): Promise<{ account: TAccount; credentials: TCredentials }> {
    const data = await this.read()
    if (data.accounts.length === 0) {
      throw new Error(this.hooks.emptyMessage ?? `未登录 ${this.hooks.displayName} 账号，请先在设置页添加账号。`)
    }

    const now = Date.now()
    const eligible = data.accounts.filter((account) => this.isEligible(account, now, excludeIds))
    if (eligible.length === 0) throw this.allUnavailableError(data, now)

    const selected = this.selectAccount(eligible, data)

    let refreshed: TAccount
    try {
      refreshed = await this.freshAccount(selected, fetchFn, forceRefresh)
    } catch (error) {
      if (this.hooks.refreshFailureStatus?.(error) === undefined
        && !(error instanceof PoolAccountUnavailableError)) {
        throw error
      }
      const nextExclude = new Set(excludeIds ?? [])
      nextExclude.add(selected.id)
      // A refresh the provider calls final is that account's problem alone, and a
      // row deleted mid-request is nobody's problem: either way, another account
      // may still be able to serve this request.
      if (await this.hasAnotherAvailableAccount(nextExclude)) {
        return this.getEffectiveAccount(nextExclude, fetchFn, forceRefresh)
      }
      throw error
    }

    // Bookkeeping only, and only onto the LATEST document. Writing the snapshot
    // read before the refresh is what erased a concurrent re-login, a deletion
    // or a settings change that landed while the network call was in flight.
    // It stays best-effort: remembering which account was used last must never be
    // the reason a request cannot get its credential, while writes that *are*
    // the user's intent — adding, deleting, cooling down — stay strict.
    const account = await this.updatePool((current) => {
      const latest = current.accounts.find((entry) => entry.id === refreshed.id)
      if (latest === undefined || !isDeepStrictEqual(latest.credentials, refreshed.credentials)) return latest
      latest.lastUsedAt = now
      // Only claim the rotation slot if nobody changed the choice while this
      // request was refreshing: a deliberate setPrimary must not be undone here.
      if (current.activeAccountId === data.activeAccountId) current.activeAccountId = latest.id
      return latest
    }).catch(() => refreshed)
    this.assertUsableAccount(account)
    return { account, credentials: account.credentials }
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
