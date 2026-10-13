import path from 'node:path'
import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { AccountPoolCore, type AccountPoolHooks } from '../common/account-pool.ts'
import { poolQuota, quotaWindow } from '../common/account-quota.ts'
import { dshHomeDir } from '../common/home.ts'
import {
  FileCredentialStore,
  parseAntigravityCredentials,
  type AntigravityCredentials,
} from './token-store.ts'
import { refreshAntigravityToken } from './oauth.ts'
import { getCachedQuota } from './client.ts'
import type {
  AntigravityAccountQuota,
  AntigravityAccountSummaryDto,
  AccountRotationStrategy,
} from '../../shared/antigravity-contracts.ts'
import type { PoolAccountQuotaDto, PoolAccountQuotaWindowDto } from '../../shared/account-pool-contracts.ts'

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

/**
 * The rotation strategy this line defaults to, and the reader for it.
 *
 * Sticky rather than the shared core's sequential default, because the account a
 * request is served by may also decide which server-side prefix cache it can
 * reach: each account is a separate quota domain, and an account that changes mid
 * conversation plausibly lands on a cache the previous one had not warmed, so the
 * next turn may reprocess a prefix that was already paid for. Holding the account
 * that served the previous request is the cheap way to not find out the hard way,
 * and a request that is rate limited still falls through to another account.
 *
 * That account identity selects a cache namespace is INFERRED, not measured.
 * Nothing here observes an account-scoped cache metric, no live capture has been
 * taken, and docs/antigravity-claude-cache-audit.md records the upstream position
 * — on-wire session affinity still needs transport diagnostics — against a run
 * that had a single account, so cross-account behaviour was never exercised.
 * The default stands as a design assumption until one of those is done.
 *
 * Only the DEFAULT differs. An explicit stored choice is returned unchanged, and
 * a pool file written before this change carries an explicit 'sequential' — so
 * upgrading does not silently move an existing user onto a different strategy.
 * The shared core keeps its own sequential default for every other line.
 */
export function poolRotationStrategy(value: unknown): AccountRotationStrategy {
  return value === 'sequential' || value === 'round-robin' || value === 'sticky'
    ? value
    : 'sticky'
}

export function parseAntigravityPoolData(value: unknown): AntigravityPoolData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Antigravity pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const strategy: AccountRotationStrategy = poolRotationStrategy(record.rotationStrategy)
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
 * One bucket's reset moment as Unix milliseconds, when it parses as a date.
 *
 * The service states it as an ISO-ish string; anything `Date.parse` refuses is
 * dropped rather than guessed at, because a wrong instant on the card is worse
 * than none.
 */
function resetTimeMs(resetTime: string | undefined): number | null {
  if (resetTime === undefined || resetTime === '') return null
  const parsed = Date.parse(resetTime)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * One cached Antigravity snapshot as the shared account card renders it.
 *
 * One window per bucket. The service states what is LEFT, and the card draws what
 * is SPENT, so the used share is the complement. A bucket whose fraction is
 * `null` (never measured) or outside 0-1 is dropped rather than drawn as 0% or
 * 100%: "not stated" and "nothing used" are different claims and only one of
 * them is true. A stated 0 is a real measurement — the allowance is exhausted —
 * and is published as 100% used.
 *
 * `windowDurationMins` is deliberately absent. The bucket's `window` field is
 * carried through this line's cache verbatim and nothing in the line interprets
 * it as a duration, so naming a window from it would be a guess; the card names
 * each window from the label below instead.
 */
export function antigravityPoolQuota(quota: AntigravityAccountQuota | undefined): PoolAccountQuotaDto | undefined {
  if (quota === undefined) return undefined
  // A bucket name that repeats across groups identifies nothing on its own, so
  // those rows carry their group's name as well.
  const nameCounts = new Map<string, number>()
  for (const group of quota.groups) {
    for (const bucket of group.buckets) {
      const name = bucket.displayName.trim()
      if (name === '') continue
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
  }
  const windows: Array<PoolAccountQuotaWindowDto | null> = []
  for (const group of quota.groups) {
    const groupName = group.displayName.trim()
    for (const bucket of group.buckets) {
      const remaining = bucket.remainingFraction
      // `null` is unmeasured and must never be read as 0 (which would claim the
      // bucket is spent); a hand-built snapshot can also carry NaN or a share
      // outside 0-1, which is no more publishable than an absent one.
      if (remaining === null || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue
      const name = bucket.displayName.trim()
      const ambiguous = name === '' || (nameCounts.get(name) ?? 0) > 1
      const label = ambiguous && groupName !== '' ? (name === '' ? groupName : groupName + ' · ' + name) : name
      windows.push(quotaWindow(label, (1 - remaining) * 100, { resetsAt: resetTimeMs(bucket.resetTime) }))
    }
  }
  return poolQuota(quota.fetchedAt, windows)
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
          // The cached quota snapshot belongs to the PRIMARY row, and to no other.
          //
          // This line has no per-account quota path: `fetchAccountQuota` reads the
          // legacy single-credential file, which `mirrorPrimary` keeps in step with
          // the primary account alone, and the cache is one global slot with no
          // account key. Under round-robin or sticky the snapshot therefore still
          // describes the primary account, not whichever account is serving, which
          // is exactly why it is attached here rather than to the active row:
          // publishing it on the serving account would put the primary's numbers
          // under another account's name. There is deliberately no upstream read
          // per account — building this list must not fan out one request each.
          ...(account.isPrimary === true ? (() => {
            const quota = antigravityPoolQuota(getCachedQuota())
            return quota === undefined ? {} : { quota }
          })() : {}),
        }
      },
      emptyMessage: '未登录 Antigravity 账号，请在「设置 → Antigravity」中添加并登录账号。',
      allUnavailableMessage: (count, waitMinutes) =>
        `全部 ${count} 个 Antigravity 账号均处于配额限制或冷却中 (429)。`
        + (waitMinutes === null
          ? '目前没有处于冷却中的账号。'
          : `最短预计在 ${waitMinutes} 分钟后解除冷却。`),
      allAuthFailedMessage: (count) =>
        `全部 ${count} 个 Antigravity 账号均需要重新登录。`,
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

  /**
   * Cooldowns keyed by account AND quota family.
   *
   * Antigravity meters Gemini and "Claude and GPT" as separate allowances
   * (`retrieveUserQuotaSummary` reports them as separate groups), so a 429 on
   * one says nothing about the other. The account-wide cooldown the shared core
   * writes took a whole account out of rotation for 15 minutes when only its
   * Claude allowance was spent, and its Gemini allowance went unused.
   *
   * Held in memory rather than in the pool document: it is a routing hint that
   * the next 429 re-establishes, and the shared pool format has no per-family
   * field to put it in.
   */
  private readonly familyCooldowns = new Map<string, { until: number; reason: string }>()

  private familyKey(accountId: string, family: AntigravityQuotaFamily): string {
    return `${family}\u0000${accountId}`
  }

  /** Cool one account down for one quota family after an upstream 429. */
  markFamilyCooldown(accountId: string, family: AntigravityQuotaFamily, durationMs: number, reason: string): void {
    this.familyCooldowns.set(this.familyKey(accountId, family), {
      until: Date.now() + Math.max(1_000, durationMs),
      reason,
    })
  }

  /** Accounts whose allowance for this family is still cooling down. */
  familyCoolingAccountIds(family: AntigravityQuotaFamily, now = Date.now()): Set<string> {
    const ids = new Set<string>()
    const prefix = `${family}\u0000`
    for (const [key, entry] of this.familyCooldowns) {
      if (!key.startsWith(prefix)) continue
      if (entry.until > now) ids.add(key.slice(prefix.length))
      else this.familyCooldowns.delete(key)
    }
    return ids
  }

  private shortestFamilyCooldownMs(family: AntigravityQuotaFamily, now = Date.now()): number | null {
    let shortest = Infinity
    const prefix = `${family}\u0000`
    for (const [key, entry] of this.familyCooldowns) {
      if (key.startsWith(prefix) && entry.until > now) shortest = Math.min(shortest, entry.until - now)
    }
    return Number.isFinite(shortest) ? shortest : null
  }

  /**
   * {@link getEffectiveAccount} for one quota family: accounts whose allowance
   * for that family is cooling down are skipped, every other account stays
   * eligible.
   *
   * @throws LlmError `RATE_LIMIT` naming the family's own wait when every
   *   remaining account is cooling down for this family.
   */
  async getEffectiveAccountFor(
    family: AntigravityQuotaFamily,
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: AntigravityPoolAccount; token: string; projectId?: string }> {
    const cooling = this.familyCoolingAccountIds(family)
    const exclude = new Set([...(excludeIds ?? []), ...cooling])
    try {
      return await this.getEffectiveAccount(exclude, fetchFn)
    } catch (error) {
      if (cooling.size === 0 || !(error instanceof LlmError) || error.code !== 'RATE_LIMIT') throw error
      const wait = this.shortestFamilyCooldownMs(family)
      const label = family === 'gemini' ? 'Gemini' : 'Claude / GPT'
      throw new LlmError(
        `全部可用 Antigravity 账号的 ${label} 配额均处于限制或冷却中 (429)。`
          + (wait === null ? '' : `最短预计在 ${Math.ceil(wait / 60_000)} 分钟后解除冷却。`)
          + '其他模型族的配额不受影响，可切换到其他模型族继续使用。',
        'RATE_LIMIT',
        { status: 429, cause: error },
      )
    }
  }

  /** Whether an account not yet tried may still serve this family. */
  async hasAnotherAvailableAccountFor(
    family: AntigravityQuotaFamily,
    triedAccountIds: ReadonlySet<string>,
  ): Promise<boolean> {
    const exclude = new Set([...triedAccountIds, ...this.familyCoolingAccountIds(family)])
    return this.core.hasAnotherAvailableAccount(exclude)
  }
}

/**
 * The separately metered allowance one model draws from.
 *
 * Mirrors the quota groups `retrieveUserQuotaSummary` reports: Gemini models in
 * one, "Claude and GPT models" in the other.
 */
export type AntigravityQuotaFamily = 'gemini' | 'claude-gpt'

export function quotaFamilyForModel(modelId: string): AntigravityQuotaFamily {
  return modelId.startsWith('claude-') || modelId.startsWith('gpt-') ? 'claude-gpt' : 'gemini'
}
