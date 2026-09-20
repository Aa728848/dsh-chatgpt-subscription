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

  constructor(hooks: AccountPoolHooks<TCredentials, TAccount, TSummary>) {
    this.hooks = hooks
    this.filePath = hooks.poolFile
    this.backend = hooks.backend ?? createPoolBackend(hooks)
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
    const id = existing === undefined ? `acc_${randomBytes(6).toString('hex')}` : existing.id
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

    if (eligible.length === 0) {
      let shortest = Infinity
      for (const account of data.accounts) {
        if (account.cooldownUntil !== undefined && account.cooldownUntil > now) {
          shortest = Math.min(shortest, account.cooldownUntil - now)
        }
      }
      const waitMinutes = Number.isFinite(shortest) ? Math.ceil(shortest / 60_000) : 15
      throw new LlmError(
        this.hooks.allUnavailableMessage?.(data.accounts.length, waitMinutes)
          ?? `全部 ${data.accounts.length} 个 ${this.hooks.displayName} 账号均处于配额限制或冷却中 (429)。最短预计在 ${waitMinutes} 分钟后解除冷却。`,
        'RATE_LIMIT',
        { status: 429 },
      )
    }

    let selected: TAccount
    if (data.rotationStrategy === 'round-robin') {
      // Least recently used first, so a burst spreads over the whole pool.
      selected = [...eligible].sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))[0]!
    } else if (data.rotationStrategy === 'sticky') {
      // Keep the account that served the previous request while it is eligible —
      // this is what protects an upstream prefix cache across a conversation.
      selected = eligible.find((account) => account.id === data.activeAccountId)
        || eligible.find((account) => account.isPrimary)
        || eligible[0]!
    } else {
      // Sequential: prefer the primary account, then the first eligible one.
      selected = eligible.find((account) => account.isPrimary) || eligible[0]!
    }

    const shouldRefresh = this.hooks.needsRefresh
      ? this.hooks.needsRefresh(selected.credentials, now)
      : (() => {
          const expires = this.hooks.expiresAt?.(selected.credentials)
          return expires !== undefined && expires <= now + POOL_REFRESH_MARGIN_MS
        })()

    if (shouldRefresh && this.hooks.refresh) {
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
