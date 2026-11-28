import path from 'node:path'
import { dshHomeDir } from '../../common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from '../../common/account-pool.ts'
import type { CredentialStore } from '../../infra/storage/token-store.ts'
import type { AccountRotationStrategy } from '../../../shared/account-pool-contracts.ts'
import {
  normalizeClaudeApiBaseUrl,
  type ClaudeApiAccountSummaryDto,
} from '../../../shared/claude-api-contracts.ts'
import {
  claudeApiCredentialFingerprint,
  parseClaudeApiCredentials,
  ClaudeApiCredentialStore,
  ClaudeApiSettingsStore,
  type ClaudeApiCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'

/** A pooled credential owns its endpoint as well as its secret. */
export interface ClaudeApiPoolCredentials extends ClaudeApiCredentials {
  baseUrl: string
}

export interface ClaudeApiPoolAccount extends PoolAccountShape<ClaudeApiPoolCredentials> {}

export function claudeApiPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'claude-api-pool.json')
}

export function claudeApiAccountKey(credentials: ClaudeApiPoolCredentials): string {
  return claudeApiCredentialFingerprint(credentials, credentials.baseUrl)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function aliasFor(credentials: ClaudeApiPoolCredentials, position: number): string {
  try {
    return new URL(credentials.baseUrl).host + ' · 账号 ' + position
  } catch {
    return 'Claude API 账号 ' + position
  }
}

export function parseClaudeApiPoolData(value: unknown): PoolData<ClaudeApiPoolAccount> {
  if (!isRecord(value)) throw new Error('Claude API pool payload is invalid.')
  const accounts: ClaudeApiPoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '' || !isRecord(item.credentials)) continue
    const normalized = normalizeClaudeApiBaseUrl(item.credentials.baseUrl)
    if (!normalized.ok) continue
    let parsed: ClaudeApiCredentials
    try { parsed = parseClaudeApiCredentials(item.credentials) } catch { continue }
    const credentials: ClaudeApiPoolCredentials = { ...parsed, baseUrl: normalized.value }
    const account: ClaudeApiPoolAccount = {
      id: item.id,
      alias: typeof item.alias === 'string' && item.alias.trim() !== '' ? item.alias.trim() : aliasFor(credentials, accounts.length + 1),
      credentials,
      addedAt: typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
    }
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') account.authStatus = item.authStatus
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<ClaudeApiPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(value.rotationStrategy),
    accounts,
  }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

export interface ClaudeApiAccountPoolOptions {
  store?: ClaudeApiCredentialStore | null
  settingsStore?: ClaudeApiSettingsStore
  backend?: CredentialStore<PoolData<ClaudeApiPoolAccount>>
  maxAccounts?: number
}

export interface ClaudeApiSaveAccountInput {
  accountId?: string
  alias?: string
  baseUrl: string
  apiKey?: string
}

export class ClaudeApiAccountPool extends AccountPoolCore<
  ClaudeApiPoolCredentials,
  ClaudeApiPoolAccount,
  ClaudeApiAccountSummaryDto
> {
  private readonly legacyStore: ClaudeApiCredentialStore | null
  private readonly settings: ClaudeApiSettingsStore

  constructor(options: ClaudeApiAccountPoolOptions = {}) {
    const legacyStore = options.store === undefined ? new ClaudeApiCredentialStore() : options.store
    const settings = options.settingsStore ?? new ClaudeApiSettingsStore()
    const hooks: AccountPoolHooks<ClaudeApiPoolCredentials, ClaudeApiPoolAccount, ClaudeApiAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: claudeApiPoolPath(),
      keychainService: 'dsh-claude-api-pool',
      parsePoolData: parseClaudeApiPoolData,
      dedupeKey: claudeApiAccountKey,
      defaultAlias: aliasFor,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id, alias, credentials, addedAt, isPrimary,
      }),
      emptyMessage: 'Claude API 尚未配置账号，请先添加 Base URL 和 API Key。',
      extendSummary: (account, base) => ({ ...base, baseUrl: account.credentials.baseUrl }),
      ...(legacyStore === null ? {} : {
        legacyAccount: async () => {
          const [legacy, current] = await Promise.all([legacyStore.read().catch(() => null), settings.read()])
          if (legacy === null) return null
          const credentials: ClaudeApiPoolCredentials = { ...legacy, baseUrl: current.baseUrl }
          return {
            id: 'acc_primary',
            alias: aliasFor(credentials, 1),
            credentials,
            addedAt: legacy.authenticatedAt,
            isPrimary: true,
          }
        },
        // Keep the pre-pool credential as a primary-account compatibility projection.
        mirrorPrimary: async (credentials) => {
          if (credentials === null) {
            await legacyStore.delete()
            return
          }
          await legacyStore.write({ apiKey: credentials.apiKey, authenticatedAt: credentials.authenticatedAt })
          await settings.update({ baseUrl: credentials.baseUrl })
        },
      }),
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.legacyStore = legacyStore
    this.settings = settings
  }

  /** Stable account for the shared model catalog and connection defaults. */
  async stableAccount(): Promise<ClaudeApiPoolAccount | null> {
    const data = await this.read().catch(() => null)
    if (data === null) return null
    return data.accounts.find(account => account.isPrimary) ?? data.accounts[0] ?? null
  }

  async accountForTest(accountId?: string): Promise<ClaudeApiPoolAccount | null> {
    if (accountId === undefined) return this.stableAccount()
    const data = await this.read().catch(() => null)
    return data?.accounts.find(account => account.id === accountId) ?? null
  }

  async activeAccountId(): Promise<string | undefined> {
    const data = await this.read().catch(() => null)
    return data?.activeAccountId ?? data?.accounts.find(account => account.isPrimary)?.id ?? data?.accounts[0]?.id
  }

  async strategy(): Promise<AccountRotationStrategy> {
    return (await this.read().catch(() => null))?.rotationStrategy ?? 'sequential'
  }

  async saveAccount(input: ClaudeApiSaveAccountInput): Promise<ClaudeApiPoolAccount> {
    const normalized = normalizeClaudeApiBaseUrl(input.baseUrl)
    if (!normalized.ok) throw new Error('Invalid baseUrl (' + normalized.reason + ').')
    const apiKey = input.apiKey?.trim()
    if (apiKey !== undefined && (apiKey === '' || apiKey.length > 4096)) throw new Error('A valid Claude API key is required.')
    if (input.accountId === undefined) {
      if (apiKey === undefined) throw new Error('A valid Claude API key is required.')
      return this.addAccount({ apiKey, authenticatedAt: Date.now(), baseUrl: normalized.value }, input.alias)
    }
    const accountId = input.accountId
    return this.updatePool(data => {
      const target = data.accounts.find(account => account.id === accountId)
      if (target === undefined) throw new Error('The Claude API account was not found.')
      const credentials: ClaudeApiPoolCredentials = {
        apiKey: apiKey ?? target.credentials.apiKey,
        authenticatedAt: apiKey === undefined ? target.credentials.authenticatedAt : Date.now(),
        baseUrl: normalized.value,
      }
      const duplicate = data.accounts.some(account => account.id !== accountId && claudeApiAccountKey(account.credentials) === claudeApiAccountKey(credentials))
      if (duplicate) throw new Error('This Base URL and API key are already configured.')
      target.credentials = credentials
      if (input.alias?.trim()) target.alias = input.alias.trim()
      target.authStatus = undefined
      target.authFailedReason = undefined
      target.cooldownUntil = undefined
      target.cooldownReason = undefined
      return target
    })
  }

  mirrorStore(): ClaudeApiCredentialStore | null {
    return this.legacyStore
  }
}

/**
 * Wrap a standalone single-credential store in an in-memory pool adapter so legacy
 * callers and tests never read or mutate the host's on-disk encrypted pool file.
 */
export function claudeApiPoolFor(
  store: ClaudeApiCredentialStore | ClaudeApiAccountPool,
  settingsStore: ClaudeApiSettingsStore,
): ClaudeApiAccountPool {
  if (store instanceof ClaudeApiAccountPool) return store
  let memory: PoolData<ClaudeApiPoolAccount> | null = null
  return new ClaudeApiAccountPool({
    store,
    settingsStore,
    backend: {
      load: async () => memory === null ? null : structuredClone(memory),
      save: async value => { memory = structuredClone(value) },
      clear: async () => { memory = null },
    },
  })
}
