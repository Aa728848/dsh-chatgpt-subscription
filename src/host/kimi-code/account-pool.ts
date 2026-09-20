import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../common/account-pool.ts'
import type { CredentialStore } from '../token-store.ts'
import {
  FileCredentialStore,
  parseKimiCodeCredentials,
  type KimiCodeCredentials,
} from './token-store.ts'
import { KimiCodeUnauthorizedError, isRefreshTokenRejected, refreshAccessToken, refreshThresholdMs } from './oauth.ts'
import { PROVIDER_ID } from './types.ts'
import type { KimiCodeAccountSummaryDto, KimiCodeRegion } from '../../shared/kimi-code-contracts.ts'

/** One pooled Kimi Code account: the token pair plus the facts the card renders. */
export interface KimiCodePoolAccount extends PoolAccountShape<KimiCodeCredentials> {
  email?: string
  nickname?: string
  userId?: string
  planName?: string
  region?: KimiCodeRegion
}

/** Encrypted pool file this line owns; the pre-pool credential file stays the mirror. */
export function kimiCodePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'kimi-code-pool.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Kimi Code pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseKimiCodePoolData(value: unknown): PoolData<KimiCodePoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Kimi Code pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: KimiCodePoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseKimiCodeCredentials(raw.credentials)
    const account: KimiCodePoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : (credentials.email || credentials.nickname || '账号'),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    for (const key of ['email', 'nickname', 'userId', 'planName'] as const) {
      const parsed = optionalString(raw, key)
      if (parsed !== undefined) account[key] = parsed
    }
    if (raw.region === 'mainland-cn' || raw.region === 'global') account.region = raw.region
    if (account.email === undefined && credentials.email !== undefined) account.email = credentials.email
    if (account.userId === undefined && credentials.userId !== undefined) account.userId = credentials.userId
    if (account.region === undefined) account.region = credentials.region
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<KimiCodePoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface KimiCodeAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<KimiCodePoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
}

/**
 * Kimi Code's account pool.
 *
 * The credential is an OAuth pair whose refresh token rotates, so the pool owns
 * both the refresh and the write-back: two accounts must never be refreshed
 * through the same single-credential file.
 */
export class KimiCodeAccountPool extends AccountPoolCore<
  KimiCodeCredentials,
  KimiCodePoolAccount,
  KimiCodeAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: KimiCodeAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<KimiCodeCredentials, KimiCodePoolAccount, KimiCodeAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: 'Kimi Code',
      poolFile: kimiCodePoolPath(),
      keychainService: 'dsh-kimi-code-pool',
      parsePoolData: parseKimiCodePoolData,
      // Identity, never a token: the refresh token rotates, so keying on it
      // would make the same account look new after every refresh.
      dedupeKey: (credentials) => credentials.userId ?? credentials.email,
      defaultAlias: (credentials, position) => credentials.email
        ?? credentials.nickname
        ?? `账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        ...(credentials.email === undefined ? {} : { email: credentials.email }),
        ...(credentials.nickname === undefined ? {} : { nickname: credentials.nickname }),
        ...(credentials.userId === undefined ? {} : { userId: credentials.userId }),
        ...(credentials.planName === undefined ? {} : { planName: credentials.planName }),
        ...(credentials.region === undefined ? {} : { region: credentials.region }),
      }),
      expiresAt: (credentials) => credentials.expiresAt,
      needsRefresh: (credentials, now) => credentials.expiresAt - now <= refreshThresholdMs(credentials.expiresIn),
      refresh: async (credentials, fetchFn) => {
        // The refresh targets this account's own OAuth host and region, and the
        // rotated pair replaces only the token fields: an account from one region
        // must not silently become an account of another.
        const token = await refreshAccessToken(credentials.refreshToken, {
          fetchFn,
          host: credentials.oauthHost,
          region: credentials.region,
        })
        return {
          ...credentials,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          expiresIn: token.expiresIn,
          scope: token.scope,
          tokenType: token.tokenType,
        }
      },
      // A refresh the service calls final takes that account out of rotation;
      // a transient refresh failure leaves it in place.
      refreshFailureStatus: (error) => (error instanceof KimiCodeUnauthorizedError ? 'expired' : undefined),
      // Pure check: the rejection is recorded by the token layer, and the pool
      // only stops routing to the account it belongs to.
      authRejectedReason: (credentials) => (isRefreshTokenRejected(credentials.refreshToken)
        ? 'Kimi Code 已拒绝该账号的刷新令牌，需要重新登录。'
        : undefined),
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return {
          id: 'acc_primary',
          alias: stored.email || stored.nickname || '主账号',
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
          ...(stored.email === undefined ? {} : { email: stored.email }),
          ...(stored.nickname === undefined ? {} : { nickname: stored.nickname }),
          ...(stored.userId === undefined ? {} : { userId: stored.userId }),
          ...(stored.planName === undefined ? {} : { planName: stored.planName }),
          ...(stored.region === undefined ? {} : { region: stored.region }),
        }
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.delete()
          return
        }
        await store.write(credentials)
      },
      extendSummary: (account, base) => {
        const email = account.email ?? account.credentials.email
        const nickname = account.nickname ?? account.credentials.nickname
        const planName = account.planName ?? account.credentials.planName
        const region = account.region ?? account.credentials.region
        return {
          ...base,
          ...(email === undefined ? {} : { email }),
          ...(nickname === undefined ? {} : { nickname }),
          ...(planName === undefined ? {} : { planName, planLabel: planName }),
          ...(region === undefined ? {} : { region }),
          ...(account.userId === undefined ? {} : { userId: account.userId }),
        }
      },
      // Keeps the wording the adapter's missing-credential error used before the
      // pool existed, so existing diagnostics still match.
      emptyMessage: 'Not signed in to Kimi Code. Sign in from Settings > Kimi Code.',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /**
   * Pick the account for the next request.
   *
   * The returned credential carries its own region, OAuth host and base URL, so
   * the caller must use those rather than the process-wide defaults.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: KimiCodePoolAccount; credentials: KimiCodeCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /** The pre-pool credential file this pool mirrors its primary account into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }
}
