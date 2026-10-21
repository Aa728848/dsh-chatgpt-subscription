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
  credentialsIdentity,
  credentialsLabel,
  isOpenDesignOAuthCredentials,
  parseOpenDesignCredentials,
  type OpenDesignCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
} from '../../shared/account-pool-contracts.ts'
import type { OpenDesignAccountSummaryDto } from '../../shared/opendesign-contracts.ts'

/** One pooled OpenDesign key: the bearer key plus the display facts the card renders. */
export interface OpenDesignPoolAccount extends PoolAccountShape<OpenDesignCredentials> {
  /** Model id this account last served, for the card's detail line. */
  lastModelId?: string
}

export type OpenDesignPoolStatusDto = AccountPoolStatusDto

/** Encrypted pool file this line owns. */
export function opendesignPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'opendesign-pool.json')
}

/** The credential name a deployment can export instead of pasting a key. */
export const OPENDESIGN_API_KEY_ENV = 'OPENDESIGN_API_KEY'

/** The launching environment's key, projected as the primary account on read. */
function ambientCredentials(): OpenDesignCredentials | null {
  const value = process.env[OPENDESIGN_API_KEY_ENV]?.trim()
  return value === undefined || value === '' ? null : { kind: 'api-key', apiKey: value }
}

/** Stable identity of one key; see token-store for why the digest is safe to hold. */
export function opendesignAccountKey(credentials: OpenDesignCredentials): string {
  return credentialsIdentity(credentials)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('OpenDesign pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseOpenDesignPoolData(value: unknown): PoolData<OpenDesignPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('OpenDesign pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: OpenDesignPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseOpenDesignCredentials(raw.credentials)
    const account: OpenDesignPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : 'OpenDesign 账号',
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
    }
    const lastModelId = optionalString(raw, 'lastModelId')
    if (lastModelId !== undefined) account.lastModelId = lastModelId
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<OpenDesignPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface OpenDesignAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<OpenDesignPoolAccount>>
  maxAccounts?: number
}

/**
 * OpenDesign's account pool.
 *
 * One credential kind only: a static API key. None of the kernel's refresh
 * hooks apply, so they are simply not wired — a key has no expiry to refresh
 * against, and a rejected key is replaced, not refreshed.
 */
export class OpenDesignAccountPool extends AccountPoolCore<
  OpenDesignCredentials,
  OpenDesignPoolAccount,
  OpenDesignAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: OpenDesignAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<OpenDesignCredentials, OpenDesignPoolAccount, OpenDesignAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: opendesignPoolPath(),
      keychainService: 'dsh-opendesign-pool',
      parsePoolData: parseOpenDesignPoolData,
      dedupeKey: opendesignAccountKey,
      defaultAlias: (credentials, position) =>
        credentialsLabel(credentials) ?? `OpenDesign 账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // An existing single-key install becomes the primary account, so nothing a
      // user already configured has to be re-entered. A deployment that exports
      // OPENDESIGN_API_KEY gets the same projection without pasting the key
      // first; it is not persisted.
      legacyAccount: async () => {
        // A platform credential backend that cannot answer (no Secret Service
        // on a bare Linux CI runner, for example) must not take the ambient
        // OPENDESIGN_API_KEY projection down with it: the store and the
        // environment are two independent sources, and the second one does not
        // need the keyring to be readable.
        const stored = await store.read().catch(() => null)
        const ambient = stored ?? ambientCredentials()
        if (ambient === null) return null
        return {
          id: 'acc_primary',
          alias: credentialsLabel(ambient) ?? 'OpenDesign 账号 1',
          credentials: ambient,
          addedAt: ambient.addedAt ?? Date.now(),
          isPrimary: true,
        }
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.clear()
          return
        }
        await store.write(credentials)
      },
      extendSummary: (account, base) => {
        const credentials = account.credentials
        const summary: OpenDesignAccountSummaryDto = {
          ...base,
          authKind: isOpenDesignOAuthCredentials(credentials) ? 'oauth' : 'api-key',
        }
        // OAuth accounts carry the identity the approval returned; a pasted key
        // has no identity, so its detail line stays the model it last served.
        if (isOpenDesignOAuthCredentials(credentials)) {
          if (credentials.user?.email !== undefined && credentials.user.email !== '' && summary.email === undefined) {
            summary.email = credentials.user.email
          }
          if (credentials.user?.plan !== undefined && credentials.user.plan !== '') summary.plan = credentials.user.plan
        }
        if (account.lastModelId !== undefined) summary.planLabel = account.lastModelId
        return summary
      },
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /**
   * Pick the key for the next request, skipping accounts already tried.
   *
   * The credential carries its own base-URL override, so the account and the key
   * are returned together.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: OpenDesignPoolAccount; credentials: OpenDesignCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /** The pre-pool credential file this pool mirrors its primary account into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }

  /** The rotation strategy as the settings card renders it. */
  async strategy(): Promise<AccountRotationStrategy> {
    return (await this.read().catch(() => null))?.rotationStrategy ?? 'sequential'
  }

  /** Remember which model an account last served, best-effort. */
  async recordModel(accountId: string, model: string): Promise<void> {
    await this.updatePool((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId)
      if (account === undefined) return
      account.lastModelId = model
    }).catch(() => undefined)
  }
}
