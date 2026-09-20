import path from 'node:path'
import { TOKEN_REFRESH_MARGIN_MS } from '../compat.ts'
import { dshHomeDir } from './common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from './common/account-pool.ts'
import {
  parseStoredCredentials,
  type CredentialStore,
  type StoredOAuthCredentials,
  type TokenStore,
} from './token-store.ts'
import { createPlatformTokenStore } from './platform-token-store.ts'
import { OAuthServiceError } from './oauth-service.ts'
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../shared/account-pool-contracts.ts'

/** One pooled ChatGPT account: the credential plus the facts the card renders. */
export interface CodexPoolAccount extends PoolAccountShape<StoredOAuthCredentials> {
  email?: string
  planType?: string
  accountId?: string
}

/** Encrypted pool file the ChatGPT line owns; the single-credential store stays the mirror. */
export function codexPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'codex-pool.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('ChatGPT pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseCodexPoolData(value: unknown): PoolData<CodexPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ChatGPT pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: CodexPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseStoredCredentials(raw.credentials)
    const account: CodexPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : (credentials.email || '账号'),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    const email = optionalString(raw, 'email') ?? credentials.email
    if (email !== undefined) account.email = email
    const planType = optionalString(raw, 'planType') ?? credentials.planType
    if (planType !== undefined) account.planType = planType
    const accountId = optionalString(raw, 'accountId') ?? credentials.accountId
    if (accountId !== undefined) account.accountId = accountId
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<CodexPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

/** Token refresh the OAuth service lends the pool; refresh tokens rotate, so this must be the only writer. */
export interface CodexTokenRefresher {
  /** Refresh one account with the service's own token-endpoint fetch. */
  refreshAccount(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials>
}

export interface CodexAccountPoolOptions {
  /** Single-credential store the pool mirrors its primary account into. */
  store?: TokenStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<CodexPoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
}

/**
 * ChatGPT's account pool.
 *
 * Thin wrapper over {@link AccountPoolCore}: it only supplies the credential
 * shape, the identity a duplicate sign-in collapses onto, and the two provider
 * hooks the core cannot know — how to refresh one account's tokens and which
 * accounts a cached quota window already rules out.
 */
export class CodexAccountPool extends AccountPoolCore<StoredOAuthCredentials, CodexPoolAccount, PoolAccountSummaryDto> {
  private readonly refresherRef: { current?: CodexTokenRefresher }
  private readonly store: TokenStore
  private quotaBlockedUntil?: (account: CodexPoolAccount, now: number) => number | undefined

  constructor(options: CodexAccountPoolOptions = {}) {
    const store = options.store ?? createPlatformTokenStore()
    const ref: { current?: CodexTokenRefresher } = {}
    const hooks: AccountPoolHooks<StoredOAuthCredentials, CodexPoolAccount, PoolAccountSummaryDto> = {
      providerId: 'codex-chatgpt',
      displayName: 'ChatGPT',
      poolFile: codexPoolPath(),
      keychainService: 'dsh-chatgpt-subscription-pool',
      parsePoolData: parseCodexPoolData,
      // One ChatGPT account is identified by its account id; the email is the
      // fallback for credentials minted before the id claim was read.
      dedupeKey: (credentials) => credentials.accountId ?? credentials.email,
      defaultAlias: (credentials, position) => credentials.email ?? `账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        ...(credentials.email === undefined ? {} : { email: credentials.email }),
        ...(credentials.planType === undefined ? {} : { planType: credentials.planType }),
        ...(credentials.accountId === undefined ? {} : { accountId: credentials.accountId }),
      }),
      expiresAt: (credentials) => credentials.expiresAt,
      needsRefresh: (credentials, now) => credentials.expiresAt - now <= TOKEN_REFRESH_MARGIN_MS,
      refresh: async (credentials) => {
        const refresher = ref.current
        if (refresher === undefined) throw new Error('ChatGPT 凭据刷新服务尚未就绪')
        return refresher.refreshAccount(credentials)
      },
      // A refresh the token endpoint rejects (400/401) means this account must be
      // signed in again; a transport failure must not cost it its place.
      refreshFailureStatus: (error) => (error instanceof OAuthServiceError
        && (error.status === 400 || error.status === 401)
        ? 'expired'
        : undefined),
      // The pre-pool single credential stays usable: reading the pool projects it
      // as the primary account without writing anything back.
      legacyAccount: async () => {
        const stored = await store.load()
        if (stored === null) return null
        return {
          id: 'acc_primary',
          alias: stored.email || '主账号',
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
          ...(stored.email === undefined ? {} : { email: stored.email }),
          ...(stored.planType === undefined ? {} : { planType: stored.planType }),
          ...(stored.accountId === undefined ? {} : { accountId: stored.accountId }),
        }
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.clear()
          return
        }
        await store.save(credentials)
      },
      extendSummary: (account, base) => ({
        ...base,
        ...(account.email === undefined ? {} : { email: account.email }),
        ...(account.planType === undefined ? {} : { planLabel: account.planType }),
      }),
      emptyMessage: '未登录 ChatGPT 账号，请在「设置 → 订阅服务 → ChatGPT」中添加并登录账号。',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.refresherRef = ref
    this.store = store
  }

  /** Hand the pool the OAuth service's per-account refresh implementation. */
  setRefresher(refresher: CodexTokenRefresher): void {
    this.refresherRef.current = refresher
  }

  /**
   * Wire in a cached-quota verdict.
   *
   * The return value is the time the account's Codex window reopens; a lookup
   * returning undefined (or a past time) leaves the account routable. This is
   * how an exhausted window is skipped before a request is even attempted,
   * instead of discovering it from a 429.
   */
  setQuotaBlockedUntil(lookup: (account: CodexPoolAccount, now: number) => number | undefined): void {
    this.quotaBlockedUntil = lookup
  }

  protected override isEligible(
    account: CodexPoolAccount,
    now: number,
    triedAccountIds?: ReadonlySet<string>,
  ): boolean {
    if (!super.isEligible(account, now, triedAccountIds)) return false
    const blockedUntil = this.quotaBlockedUntil?.(account, now)
    return blockedUntil === undefined || blockedUntil <= now
  }

  /**
   * Force one account's token refresh and persist the rotated pair.
   *
   * Used after a 401: the core refreshes proactively when a token is close to
   * expiry, but a server-side revocation is only discovered by the request.
   */
  async refreshAccountNow(accountId: string): Promise<StoredOAuthCredentials> {
    const data = await this.read()
    const account = data.accounts.find((entry) => entry.id === accountId)
    if (account === undefined) throw new Error('ChatGPT 账号已不在号池中')
    const refresher = this.refresherRef.current
    if (refresher === undefined) throw new Error('ChatGPT 凭据刷新服务尚未就绪')
    const refreshed = await refresher.refreshAccount(account.credentials)
    await this.updateAccountCredentials(accountId, refreshed)
    return refreshed
  }

  /** The single-credential store this pool mirrors its primary account into. */
  mirrorStore(): TokenStore {
    return this.store
  }

  /** Rotation strategy currently configured. */
  async strategy(): Promise<AccountRotationStrategy> {
    return (await this.read()).rotationStrategy
  }
}
