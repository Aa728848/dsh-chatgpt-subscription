import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomeDir } from '../../common/home.ts'
import { AccountPoolCore, normalizeRotationStrategy, type AccountPoolHooks, type AccountSelectionHint, type PoolAccountShape, type PoolData } from '../../common/account-pool.ts'
import { poolQuota, quotaWindow } from '../../common/account-quota.ts'
import type { CredentialStore } from '../../infra/storage/token-store.ts'
import type { AccountRotationStrategy } from '../../../shared/account-pool-contracts.ts'
import type { OpenCodeGoAccountSummaryDto } from '../../../shared/opencode-go-contracts.ts'
import { parseOpenCodeGoCredentials } from './token-store.ts'
import { getCachedOpenCodeGoQuota } from './client.ts'
import { PROVIDER_ID, PROVIDER_NAME, type OpenCodeGoCredentials } from './types.ts'

export interface OpenCodeGoPoolAccount extends PoolAccountShape<OpenCodeGoCredentials> {
  planName?: string
  region?: string
  lastModelId?: string
}

export function openCodeGoPoolPath(): string { return path.join(dshHomeDir(), 'storages', 'opencode-go-pool.json') }
export function openCodeGoAccountKey(credentials: OpenCodeGoCredentials): string {
  return 'key:' + createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export function parseOpenCodeGoPoolData(value: unknown): PoolData<OpenCodeGoPoolAccount> {
  if (!isRecord(value)) throw new Error('OpenCode Go pool payload is invalid')
  const accounts: OpenCodeGoPoolAccount[] = []
  for (const raw of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    let credentials: OpenCodeGoCredentials
    try { credentials = parseOpenCodeGoCredentials(raw.credentials) } catch { continue }
    const account: OpenCodeGoPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : 'OpenCode Go 账号 ' + (accounts.length + 1),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    if (typeof raw.planName === 'string' && raw.planName !== '') account.planName = raw.planName
    if (typeof raw.region === 'string' && raw.region !== '') account.region = raw.region
    if (typeof raw.lastModelId === 'string' && raw.lastModelId !== '') account.lastModelId = raw.lastModelId
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<OpenCodeGoPoolAccount> = { version: 1, rotationStrategy: normalizeRotationStrategy(value.rotationStrategy), accounts }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

export interface OpenCodeGoAccountPoolOptions {
  backend?: CredentialStore<PoolData<OpenCodeGoPoolAccount>>
  maxAccounts?: number
  preferAccountId?: () => string | null
}

export class OpenCodeGoAccountPool extends AccountPoolCore<OpenCodeGoCredentials, OpenCodeGoPoolAccount, OpenCodeGoAccountSummaryDto> {
  constructor(options: OpenCodeGoAccountPoolOptions = {}) {
    const hooks: AccountPoolHooks<OpenCodeGoCredentials, OpenCodeGoPoolAccount, OpenCodeGoAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: openCodeGoPoolPath(),
      keychainService: 'dsh-opencode-go-pool',
      parsePoolData: parseOpenCodeGoPoolData,
      dedupeKey: openCodeGoAccountKey,
      defaultAlias: (_credentials, position) => 'OpenCode Go 账号 ' + position,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({ id, alias, credentials, addedAt, isPrimary }),
      legacyAccount: async () => {
        const apiKey = process.env.OPENCODE_API_KEY?.trim()
        if (apiKey === undefined || apiKey === '') return null
        return { id: 'acc_primary', alias: 'OpenCode Go 账号 1', credentials: { apiKey, authenticatedAt: Date.now() }, addedAt: Date.now(), isPrimary: true }
      },
      extendSummary: (account, base) => {
        const snapshot = getCachedOpenCodeGoQuota(account.id)
        const quota = snapshot === null ? undefined : poolQuota(snapshot.fetchedAt, snapshot.windows.map(window => quotaWindow('', window.usedPercent, {
          windowDurationMins: window.key === 'rolling' ? 300 : window.key === 'weekly' ? 10_080 : 43_200,
          resetsAt: window.resetsAt ?? undefined,
        })))
        return {
          ...base,
          authKind: 'api-key',
          ...(account.planName === undefined ? {} : { planName: account.planName }),
          ...(account.region === undefined ? {} : { region: account.region }),
          ...(quota === undefined ? {} : { quota }),
        }
      },
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
      ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
    }
    super(hooks)
  }
  async getEffectiveCredential(excludeIds?: ReadonlySet<string>, fetchFn: typeof fetch = fetch, selection?: AccountSelectionHint): Promise<{ account: OpenCodeGoPoolAccount; credentials: OpenCodeGoCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn, false, undefined, selection)
  }
  async replaceApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.updatePool(data => {
      const account = data.accounts.find(entry => entry.id === accountId)
      if (account === undefined) throw new Error('OpenCode Go account was not found')
      account.credentials = parseOpenCodeGoCredentials({ apiKey, authenticatedAt: Date.now() })
      account.authStatus = undefined
      account.authFailedReason = undefined
      account.cooldownUntil = undefined
      account.cooldownReason = undefined
    })
  }
  async strategy(): Promise<AccountRotationStrategy> { return (await this.read()).rotationStrategy }
  async recordModel(accountId: string, model: string): Promise<void> {
    await this.updatePool(data => {
      const account = data.accounts.find(entry => entry.id === accountId)
      if (account !== undefined) { account.lastModelId = model; account.lastUsedAt = Date.now() }
    }).catch(() => undefined)
  }
  async recordPlan(accountId: string, planName: string): Promise<void> {
    await this.updatePool(data => {
      const account = data.accounts.find(entry => entry.id === accountId)
      if (account !== undefined) account.planName = planName
    }).catch(() => undefined)
  }
}
