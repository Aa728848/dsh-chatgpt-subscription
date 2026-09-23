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
  parseZhipuCredentials,
  zhipuAccountKey,
  zhipuKeyHint,
  type ZhipuCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME, apiBaseForRegion } from './types.ts'
import type { ZhipuAccountSummaryDto, ZhipuRegion } from '../../shared/zhipu-contracts.ts'

/** One pooled GLM Coding Plan key: the credential plus the facts the card renders. */
export interface ZhipuPoolAccount extends PoolAccountShape<ZhipuCredentials> {
  region: ZhipuRegion
  keyHint?: string
  apiBase?: string
  planLabel?: string
  planLevel?: string
}

export type { ZhipuAccountSummaryDto }

/** Encrypted pool file this line owns; the pre-pool credential file stays the mirror. */
export function zhipuPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'zhipu-pool.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('GLM Coding Plan pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseZhipuPoolData(value: unknown): PoolData<ZhipuPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GLM Coding Plan pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: ZhipuPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    // One unreadable entry is dropped rather than failing the whole document: a
    // pool whose read throws reports "not signed in" for every account in it, so
    // a single damaged row would take the entire line offline.
    let credentials: ZhipuCredentials
    try {
      credentials = parseZhipuCredentials(raw.credentials)
    } catch {
      continue
    }
    const account: ZhipuPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : defaultAliasFor(credentials),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
      region: credentials.region,
      keyHint: zhipuKeyHint(credentials.apiKey),
      apiBase: apiBaseForRegion(credentials.region),
    }
    for (const key of ['keyHint', 'planLabel', 'planLevel'] as const) {
      const parsed = optionalString(raw, key)
      if (parsed !== undefined) account[key] = parsed
    }
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<ZhipuPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

/**
 * Alias a key gets when the user names none.
 *
 * The key text is never shown, so the alias is built from the deployment and
 * the key's own last characters — enough for a user to tell two keys apart
 * without any part of the secret being recoverable from it.
 */
function defaultAliasFor(credentials: ZhipuCredentialLike): string {
  const region = credentials.region === 'cn' ? '国区' : '国际区'
  return `${region} ${zhipuKeyHint(credentials.apiKey)}`
}

interface ZhipuCredentialLike {
  apiKey: string
  region: ZhipuRegion
}

export interface ZhipuAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<ZhipuPoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
  /** Account the card pinned, or null for automatic selection. */
  preferAccountId?: () => string | null
}

/**
 * The GLM Coding Plan account pool.
 *
 * A Coding Plan credential is a long-lived console key with nothing to refresh,
 * so this wrapper only supplies identity, display facts, and the mirror of the
 * single-credential file the plugin used before the pool existed. Rotation is
 * meaningful here for the same reason it is on the other key-based lines: a
 * spent plan window is per-account, so another account can serve the turn.
 */
export class ZhipuAccountPool extends AccountPoolCore<
  ZhipuCredentials,
  ZhipuPoolAccount,
  ZhipuAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: ZhipuAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<ZhipuCredentials, ZhipuPoolAccount, ZhipuAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: zhipuPoolPath(),
      keychainService: 'dsh-zhipu-pool',
      parsePoolData: parseZhipuPoolData,
      // Two entries are the same account when they carry the same key text on
      // the same deployment; the key is what the provider authenticates, so two
      // different keys stay separately selectable even from one console.
      dedupeKey: zhipuAccountKey,
      // Keying by that same digest keeps every account id the settings card
      // sends back — a pinned account, a cooling one — meaningful to the pool
      // without a translation layer.
      accountId: zhipuAccountKey,
      defaultAlias: (credentials) => defaultAliasFor(credentials),
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        region: credentials.region,
        keyHint: zhipuKeyHint(credentials.apiKey),
        apiBase: apiBaseForRegion(credentials.region),
        ...(credentials.planLabel === undefined ? {} : { planLabel: credentials.planLabel }),
        ...(credentials.planLevel === undefined ? {} : { planLevel: credentials.planLevel }),
      }),
      // Projecting the pre-pool key as the primary account keeps an existing
      // install working with no migration step.
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return {
          id: zhipuAccountKey(stored),
          alias: defaultAliasFor(stored),
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
          region: stored.region,
          keyHint: zhipuKeyHint(stored.apiKey),
          apiBase: apiBaseForRegion(stored.region),
          ...(stored.planLabel === undefined ? {} : { planLabel: stored.planLabel }),
          ...(stored.planLevel === undefined ? {} : { planLevel: stored.planLevel }),
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
        const region = account.region ?? account.credentials.region
        const hint = account.keyHint ?? zhipuKeyHint(account.credentials.apiKey)
        return {
          ...base,
          region,
          keyHint: hint,
          // The alias is the recognisable label; surfacing it as the summary's
          // "email" slot is how the shared pool card shows a per-account name.
          email: base.alias,
          ...(account.planLabel === undefined ? {} : { planLabel: account.planLabel }),
          apiBase: account.apiBase ?? apiBaseForRegion(region),
        }
      },
      emptyMessage: '未登录 GLM Coding Plan 账号，请在「设置 → 订阅服务 → GLM」中添加 API Key。',
      ...(options.preferAccountId === undefined ? {} : { preferAccountId: options.preferAccountId }),
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /** The pre-pool credential file this pool mirrors its primary account into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }
}
