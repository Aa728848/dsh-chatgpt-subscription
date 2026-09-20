import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { AccountPoolCore, normalizeRotationStrategy, type AccountPoolHooks } from '../common/account-pool.ts'
import { dshHomeDir } from '../common/home.ts'
import {
  FileCredentialStore,
  parseAntigravityCredentials,
  type AntigravityCredentials,
} from './token-store.ts'
import { refreshAntigravityToken } from './oauth.ts'
import type {
  AntigravityAccountSummaryDto,
  AccountRotationStrategy,
} from '../../shared/antigravity-contracts.ts'

export interface AntigravityPoolAccount {
  id: string
  alias: string
  email?: string
  projectId?: string
  planLabel?: string
  credentials: AntigravityCredentials
  addedAt: number
  lastUsedAt?: number
  cooldownUntil?: number
  cooldownReason?: string
  isPrimary?: boolean
}

export interface AntigravityPoolData {
  version: 1
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
  accounts: AntigravityPoolAccount[]
}

export function poolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'antigravity-pool.json')
}

export function parseAntigravityPoolData(value: unknown): AntigravityPoolData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Antigravity pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const strategy: AccountRotationStrategy = normalizeRotationStrategy(record.rotationStrategy)
  const activeAccountId = typeof record.activeAccountId === 'string' ? record.activeAccountId : undefined
  const rawAccounts = Array.isArray(record.accounts) ? record.accounts : []
  const accounts: AntigravityPoolAccount[] = []

  for (const item of rawAccounts) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    const credentials = parseAntigravityCredentials(r.credentials)
    const acc: AntigravityPoolAccount = {
      id: r.id,
      alias: typeof r.alias === 'string' ? r.alias : (credentials.email || '账号'),
      credentials,
      addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
      isPrimary: r.isPrimary === true,
    }
    if (typeof r.email === 'string') acc.email = r.email
    else if (credentials.email) acc.email = credentials.email
    if (typeof r.projectId === 'string') acc.projectId = r.projectId
    else if (credentials.projectId) acc.projectId = credentials.projectId
    if (typeof r.planLabel === 'string') acc.planLabel = r.planLabel
    if (typeof r.lastUsedAt === 'number') acc.lastUsedAt = r.lastUsedAt
    if (typeof r.cooldownUntil === 'number') acc.cooldownUntil = r.cooldownUntil
    if (typeof r.cooldownReason === 'string') acc.cooldownReason = r.cooldownReason
    accounts.push(acc)
  }

  const res: AntigravityPoolData = {
    version: 1,
    rotationStrategy: strategy,
    accounts,
  }
  if (activeAccountId) res.activeAccountId = activeAccountId
  return res
}

function poolCredentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function createPoolCredentialBackend(filePath: string): CredentialStore<AntigravityPoolData> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseAntigravityPoolData)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore('dsh-antigravity-pool', poolCredentialAccount(filePath), parseAntigravityPoolData)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore('dsh-antigravity-pool', poolCredentialAccount(filePath), parseAntigravityPoolData)
  }
  throw new Error('Antigravity pool encrypted storage requires Windows, macOS, or Linux.')
}

/**
 * Antigravity's account pool.
 *
 * The storage, eligibility, rotation and cooldown rules live in the shared
 * {@link AccountPoolCore}; this facade keeps the provider-shaped API the routes
 * and the adapter were written against, including the credential projection
 * (`token` / `projectId`) that predates the shared core.
 */
export class AccountPoolStore {
  private readonly core: AccountPoolCore<
    AntigravityCredentials,
    AntigravityPoolAccount,
    AntigravityAccountSummaryDto
  >
  private readonly legacyStore: FileCredentialStore

  constructor(
    filePath = poolPath(),
    backend: CredentialStore<AntigravityPoolData> = createPoolCredentialBackend(filePath),
    legacyStore = new FileCredentialStore(),
  ) {
    this.legacyStore = legacyStore
    const hooks: AccountPoolHooks<
      AntigravityCredentials,
      AntigravityPoolAccount,
      AntigravityAccountSummaryDto
    > = {
      providerId: 'antigravity',
      displayName: 'Antigravity',
      poolFile: filePath,
      keychainService: 'dsh-antigravity-pool',
      parsePoolData: parseAntigravityPoolData,
      dedupeKey: (credentials) => credentials.email,
      defaultAlias: (credentials, position) => credentials.email ?? `账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        ...(credentials.email === undefined ? {} : { email: credentials.email }),
        ...(credentials.projectId === undefined ? {} : { projectId: credentials.projectId }),
      }),
      expiresAt: (credentials) => credentials.expires ?? credentials.expires_at,
      // The access token is also refreshed when it is missing entirely.
      needsRefresh: (credentials, now) => {
        const token = credentials.access ?? credentials.access_token
        const expires = credentials.expires ?? credentials.expires_at ?? 0
        return !token || expires <= now + 60_000
      },
      refresh: (credentials, fetchFn) => refreshAntigravityToken(credentials, fetchFn),
      // The pre-pool single credential stays usable as the primary account.
      legacyAccount: async () => {
        const legacy = await this.legacyStore.read()
        if (!legacy || !(legacy.access || legacy.access_token || legacy.refresh || legacy.refresh_token)) {
          return null
        }
        return {
          id: 'acc_primary',
          alias: legacy.email || '主账号',
          credentials: legacy,
          addedAt: Date.now(),
          isPrimary: true,
          ...(legacy.email === undefined ? {} : { email: legacy.email }),
          ...(legacy.projectId === undefined ? {} : { projectId: legacy.projectId }),
        }
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await this.legacyStore.delete()
          return
        }
        await this.legacyStore.write(credentials)
      },
      extendSummary: (account, base) => {
        // A refresh can discover the project id after the account was pooled, so
        // the credential is the fallback the card reads.
        const projectId = account.projectId ?? account.credentials.projectId
        const email = account.email ?? account.credentials.email
        return {
          ...base,
          ...(projectId === undefined ? {} : { projectId }),
          ...(email === undefined ? {} : { email }),
          ...(account.planLabel === undefined ? {} : { planLabel: account.planLabel }),
        }
      },
      emptyMessage: '未登录 Antigravity 账号，请在「设置 → Antigravity」中添加并登录账号。',
      allUnavailableMessage: (count, waitMinutes) =>
        `全部 ${count} 个 Antigravity 账号均处于配额限制或冷却中 (429)。最短预计在 ${waitMinutes} 分钟后解除冷却。`,
      backend,
    }
    this.core = new AccountPoolCore(hooks)
  }

  /** Human description of where this pool's credentials live. */
  path(): string {
    return this.core.path()
  }

  read(): Promise<AntigravityPoolData> {
    return this.core.read()
  }

  write(data: AntigravityPoolData): Promise<void> {
    return this.core.write(data)
  }

  listAccounts(): Promise<AntigravityAccountSummaryDto[]> {
    return this.core.listAccounts()
  }

  addAccount(credentials: AntigravityCredentials, alias?: string): Promise<AntigravityPoolAccount> {
    return this.core.addAccount(credentials, alias)
  }

  setPrimary(accountId: string): Promise<void> {
    return this.core.setPrimary(accountId)
  }

  setAlias(accountId: string, alias: string): Promise<void> {
    return this.core.setAlias(accountId, alias)
  }

  deleteAccount(accountId: string): Promise<void> {
    return this.core.deleteAccount(accountId)
  }

  setStrategy(strategy: AccountRotationStrategy): Promise<void> {
    return this.core.setStrategy(strategy)
  }

  markCooldown(accountId: string, durationMs: number, reason: string): Promise<void> {
    return this.core.markCooldown(accountId, durationMs, reason)
  }

  clearCooldown(accountId: string): Promise<void> {
    return this.core.clearCooldown(accountId)
  }

  hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    return this.core.hasAnotherAvailableAccount(triedAccountIds)
  }

  /**
   * Pick the account for the next request, with the credential projection the
   * Antigravity adapter consumes.
   */
  async getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: AntigravityPoolAccount; token: string; projectId?: string }> {
    const { account, credentials } = await this.core.getEffectiveAccount(excludeIds, fetchFn)
    const token = credentials.access || credentials.access_token
    if (!token) throw new Error('Antigravity 选中账号缺少访问令牌，请重新登录该账号。')
    const projectId = account.projectId || credentials.projectId
    return { account, token, ...(projectId === undefined ? {} : { projectId }) }
  }
}
