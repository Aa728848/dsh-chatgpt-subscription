import path from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomeDir } from '../../common/home.ts'
import { AccountPoolCore, normalizeRotationStrategy, type AccountPoolHooks, type AccountSelectionHint, type PoolAccountShape, type PoolData } from '../../common/account-pool.ts'
import { poolQuota, quotaWindow } from '../../common/account-quota.ts'
import type { CredentialStore } from '../../infra/storage/token-store.ts'
import type { AccountRotationStrategy } from '../../../shared/account-pool-contracts.ts'
import type { OpenCodeGoAccountSummaryDto, OpenCodeGoMonthlyUsage, OpenCodeGoPlanId, OpenCodeGoQuotaSnapshotDto } from '../../../shared/opencode-go-contracts.ts'
import { parseOpenCodeGoCredentials } from './token-store.ts'
import { getCachedOpenCodeGoQuota, parseOpenCodeGoQuotaSnapshot } from './client.ts'
import { PROVIDER_ID, PROVIDER_NAME, type OpenCodeGoCredentials } from './types.ts'

interface OpenCodeGoAllowanceCost {
  averageAmount: number
  uses: number
  updatedAt: number
}

export interface OpenCodeGoAllowanceModel {
  id: string
  monthlyUsage: OpenCodeGoMonthlyUsage
}

export interface OpenCodeGoSelectionHint extends AccountSelectionHint {
  model?: OpenCodeGoAllowanceModel
}

export interface OpenCodeGoPoolAccount extends PoolAccountShape<OpenCodeGoCredentials> {
  planName?: string
  region?: string
  lastModelId?: string
  quota?: OpenCodeGoQuotaSnapshotDto
  allowanceSinceQuota?: number
  allowanceCosts?: Record<string, OpenCodeGoAllowanceCost>
}

export function openCodeGoPoolPath(): string { return path.join(dshHomeDir(), 'storages', 'opencode-go-pool.json') }
export function openCodeGoAccountKey(credentials: OpenCodeGoCredentials): string {
  return 'key:' + createHash('sha256').update(credentials.apiKey).digest('hex').slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function defaultAlias(position: number): string { return 'OpenCode Go #' + position }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function planIdFor(account: OpenCodeGoPoolAccount): OpenCodeGoPlanId | null {
  if (account.planName === 'Go') return 'go'
  if (account.planName === 'Go Plus') return 'go-plus'
  if (account.planName === 'Go Teams') return 'go-teams'
  return null
}
function parseAllowanceCosts(value: unknown): Record<string, OpenCodeGoAllowanceCost> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, OpenCodeGoAllowanceCost> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !nonNegative(raw.averageAmount) || !Number.isSafeInteger(raw.uses) || (raw.uses as number) <= 0 || !nonNegative(raw.updatedAt)) continue
    out[id] = { averageAmount: raw.averageAmount, uses: raw.uses as number, updatedAt: raw.updatedAt }
  }
  return out
}

/** Projected pressure across the three shared windows; unknown facts never invent a score. */
export function openCodeGoProjectedPressure(account: OpenCodeGoPoolAccount, model: OpenCodeGoAllowanceModel): number | null {
  const plan = planIdFor(account)
  const limit = plan === null ? undefined : model.monthlyUsage[plan]
  const quota = account.quota
  if (limit === undefined || quota === undefined) return null
  const expected = account.allowanceCosts?.[model.id]?.averageAmount ?? 0
  const spent = account.allowanceSinceQuota ?? 0
  let pressure = 0
  for (const window of quota.windows) {
    const factor = window.key === 'rolling' ? 5 : window.key === 'weekly' ? 2 : 1
    pressure = Math.max(pressure, window.usedPercent + (spent + expected) / limit * 100 * factor)
  }
  return pressure
}

export function parseOpenCodeGoPoolData(value: unknown): PoolData<OpenCodeGoPoolAccount> {
  if (!isRecord(value)) throw new Error('OpenCode Go pool payload is invalid')
  const accounts: OpenCodeGoPoolAccount[] = []
  for (const raw of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    let credentials: OpenCodeGoCredentials
    try { credentials = parseOpenCodeGoCredentials(raw.credentials) } catch { continue }
    const account: OpenCodeGoPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : defaultAlias(accounts.length + 1),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    if (typeof raw.planName === 'string' && raw.planName !== '') account.planName = raw.planName
    if (typeof raw.region === 'string' && raw.region !== '') account.region = raw.region
    if (typeof raw.lastModelId === 'string' && raw.lastModelId !== '') account.lastModelId = raw.lastModelId
    const quota = parseOpenCodeGoQuotaSnapshot(raw.quota)
    if (quota !== undefined) account.quota = quota
    if (nonNegative(raw.allowanceSinceQuota)) account.allowanceSinceQuota = raw.allowanceSinceQuota
    const costs = parseAllowanceCosts(raw.allowanceCosts)
    if (costs !== undefined) account.allowanceCosts = costs
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
      defaultAlias: (_credentials, position) => defaultAlias(position),
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({ id, alias, credentials, addedAt, isPrimary }),
      legacyAccount: async () => {
        const apiKey = process.env.OPENCODE_API_KEY?.trim()
        if (apiKey === undefined || apiKey === '') return null
        return { id: 'acc_primary', alias: defaultAlias(1), credentials: { apiKey, authenticatedAt: Date.now() }, addedAt: Date.now(), isPrimary: true }
      },
      extendSummary: (account, base) => {
        const snapshot = account.quota ?? getCachedOpenCodeGoQuota(account.id)
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
  async getEffectiveCredential(excludeIds?: ReadonlySet<string>, fetchFn: typeof fetch = fetch, selection?: OpenCodeGoSelectionHint): Promise<{ account: OpenCodeGoPoolAccount; credentials: OpenCodeGoCredentials }> {
    let nextSelection: AccountSelectionHint | undefined = selection
    if (selection?.model !== undefined) {
      const data = await this.read()
      const scored = data.accounts.map((account, index) => ({ id: account.id, index, pressure: openCodeGoProjectedPressure(account, selection.model!) }))
      if (scored.some(entry => entry.pressure !== null)) {
        const rank = (pressure: number | null): number => pressure === null ? 1 : pressure >= 100 ? 2 : 0
        scored.sort((a, b) => rank(a.pressure) - rank(b.pressure) || (a.pressure ?? 0) - (b.pressure ?? 0) || a.index - b.index)
        const preferred = selection.preferAccountIds ?? []
        nextSelection = { preferAccountIds: [...new Set([...preferred, ...scored.map(entry => entry.id)])] }
      }
    }
    return this.getEffectiveAccount(excludeIds, fetchFn, false, undefined, nextSelection)
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
      account.planName = undefined
      account.quota = undefined
      account.allowanceSinceQuota = undefined
      account.allowanceCosts = undefined
    })
  }
  async strategy(): Promise<AccountRotationStrategy> { return (await this.read()).rotationStrategy }
  async recordQuota(accountId: string, snapshot: OpenCodeGoQuotaSnapshotDto): Promise<void> {
    await this.updatePool(data => {
      const account = data.accounts.find(entry => entry.id === accountId)
      if (account !== undefined) { account.quota = snapshot; account.allowanceSinceQuota = 0 }
    }).catch(() => undefined)
  }
  async recordAllowance(accountId: string, model: OpenCodeGoAllowanceModel, amount: number, planName?: string): Promise<void> {
    if (!nonNegative(amount)) return
    await this.updatePool(data => {
      const account = data.accounts.find(entry => entry.id === accountId)
      if (account === undefined) return
      account.allowanceSinceQuota = (account.allowanceSinceQuota ?? 0) + amount
      const previous = account.allowanceCosts?.[model.id]
      const uses = (previous?.uses ?? 0) + 1
      const averageAmount = previous === undefined ? amount : (previous.averageAmount * previous.uses + amount) / uses
      account.allowanceCosts ??= {}
      account.allowanceCosts[model.id] = { averageAmount, uses, updatedAt: Date.now() }
      if (planName !== undefined) account.planName = planName
    }).catch(() => undefined)
  }
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
