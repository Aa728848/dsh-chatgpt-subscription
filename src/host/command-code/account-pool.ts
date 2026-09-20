import path from 'node:path'
import { createHash } from 'node:crypto'
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
  parseCommandCodeCredentials,
  type CommandCodeCredentials,
} from './token-store.ts'
import { commandCodePlanLabel } from './plans.ts'
import { PROVIDER_ID, resolveApiEnv } from './types.ts'
import type { CommandCodeAccountSummaryDto, CommandCodeApiEnv } from '../../shared/command-code-contracts.ts'

/** One pooled Command Code key: the bearer key plus the account facts the card renders. */
export interface CommandCodePoolAccount extends PoolAccountShape<CommandCodeCredentials> {
  email?: string
  userName?: string
  keyName?: string
  organizationName?: string
  planLabel?: string
  planId?: string
  userId?: string
}

export type { CommandCodeAccountSummaryDto }

/** Encrypted pool file this line owns; the pre-pool credential file stays the mirror. */
export function commandCodePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'command-code-pool.json')
}

/**
 * Stable identity of one key.
 *
 * A user id plus the key name is what Command Code Studio itself shows, so two
 * keys minted from the same account stay distinguishable; without a user id the
 * key's digest is the identity. The digest is never written anywhere.
 */
export function commandCodeAccountKey(credentials: CommandCodeCredentials): string {
  if (credentials.userId !== undefined && credentials.userId !== '') {
    return `${credentials.userId}:${credentials.keyName ?? ''}`
  }
  return createHash('sha256').update(credentials.apiKey).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Command Code pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseCommandCodePoolData(value: unknown): PoolData<CommandCodePoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Command Code pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: CommandCodePoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseCommandCodeCredentials(raw.credentials)
    const account: CommandCodePoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : (credentials.email || credentials.keyName || '账号'),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    for (const key of ['email', 'userName', 'keyName', 'organizationName', 'planLabel', 'planId', 'userId'] as const) {
      const parsed = optionalString(raw, key)
      if (parsed !== undefined) account[key] = parsed
    }
    if (account.email === undefined && credentials.email !== undefined) account.email = credentials.email
    if (account.userId === undefined && credentials.userId !== undefined) account.userId = credentials.userId
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<CommandCodePoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface CommandCodeAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<CommandCodePoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
}

/**
 * Command Code's account pool.
 *
 * A Command Code credential is a long-lived bearer key with nothing to refresh,
 * so this wrapper only supplies identity, display facts and the mirror of the
 * single-credential file the plugin used before the pool existed.
 */
export class CommandCodeAccountPool extends AccountPoolCore<
  CommandCodeCredentials,
  CommandCodePoolAccount,
  CommandCodeAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: CommandCodeAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<CommandCodeCredentials, CommandCodePoolAccount, CommandCodeAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: 'Command Code',
      poolFile: commandCodePoolPath(),
      keychainService: 'dsh-command-code-pool',
      parsePoolData: parseCommandCodePoolData,
      dedupeKey: commandCodeAccountKey,
      defaultAlias: (credentials, position) => credentials.email
        ?? credentials.userName
        ?? credentials.keyName
        ?? `账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        ...(credentials.email === undefined ? {} : { email: credentials.email }),
        ...(credentials.userName === undefined ? {} : { userName: credentials.userName }),
        ...(credentials.keyName === undefined ? {} : { keyName: credentials.keyName }),
        ...(credentials.organizationName === undefined ? {} : { organizationName: credentials.organizationName }),
        ...(credentials.planLabel === undefined ? {} : { planLabel: credentials.planLabel }),
        ...(credentials.planId === undefined ? {} : { planId: credentials.planId }),
        ...(credentials.userId === undefined ? {} : { userId: credentials.userId }),
      }),
      // Projecting the pre-pool key as the primary account keeps an existing
      // install working with no migration step.
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return {
          id: 'acc_primary',
          alias: stored.email || stored.userName || stored.keyName || '主账号',
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
          ...(stored.email === undefined ? {} : { email: stored.email }),
          ...(stored.userName === undefined ? {} : { userName: stored.userName }),
          ...(stored.keyName === undefined ? {} : { keyName: stored.keyName }),
          ...(stored.organizationName === undefined ? {} : { organizationName: stored.organizationName }),
          ...(stored.planLabel === undefined ? {} : { planLabel: stored.planLabel }),
          ...(stored.planId === undefined ? {} : { planId: stored.planId }),
          ...(stored.userId === undefined ? {} : { userId: stored.userId }),
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
        // The stored plan id is a machine id; show the name the service would.
        const planLabel = commandCodePlanLabel(account.planId ?? account.credentials.planId)
          ?? account.planLabel
          ?? account.credentials.planLabel
        const email = account.email ?? account.credentials.email
        const keyName = account.keyName ?? account.credentials.keyName
        return {
          ...base,
          ...(email === undefined ? {} : { email }),
          ...(planLabel === undefined ? {} : { planLabel }),
          ...(keyName === undefined ? {} : { keyName }),
          ...(account.userName === undefined ? {} : { userName: account.userName }),
          ...(account.organizationName === undefined ? {} : { organizationName: account.organizationName }),
          ...(account.planId === undefined ? {} : { planId: account.planId }),
          ...(account.userId === undefined ? {} : { userId: account.userId }),
        }
      },
      // The message keeps the wording the adapter's missing-credential error
      // used before the pool existed, so existing diagnostics still match.
      emptyMessage: 'Not signed in to Command Code. 请在「设置 → 订阅服务 → Command Code」中添加账号或粘贴 API Key。',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /**
   * Pick the key for the next request, with the API environment it belongs to.
   *
   * A key issued for one deployment must not be sent to another, so the
   * environment travels with the credential rather than with the process.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: CommandCodePoolAccount; credentials: CommandCodeCredentials; apiEnv: CommandCodeApiEnv }> {
    const { account, credentials } = await this.getEffectiveAccount(excludeIds, fetchFn)
    return { account, credentials, apiEnv: credentials.apiEnv ?? resolveApiEnv() }
  }

  /** The pre-pool credential file this pool mirrors its primary account into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }
}
