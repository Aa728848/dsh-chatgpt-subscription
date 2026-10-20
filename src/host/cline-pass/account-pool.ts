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
  parseClinePassCredentials,
  type ClinePassCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type {
  AccountPoolStatusDto,
  AccountRotationStrategy,
} from '../../shared/account-pool-contracts.ts'
import type { ClinePassAccountSummaryDto } from '../../shared/cline-pass-contracts.ts'

/** One pooled Cline Pass key: the bearer key plus the display facts the card renders. */
export interface ClinePassPoolAccount extends PoolAccountShape<ClinePassCredentials> {
  /** Model id this account last served, for the card's detail line. */
  lastModelId?: string
}

export type ClinePassPoolStatusDto = AccountPoolStatusDto

/** Encrypted pool file this line owns. */
export function clinePassPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'cline-pass-pool.json')
}

/** The credential name the standalone plugin reads when no key was pasted. */
export const CLINE_PASS_API_KEY_ENV = 'CLINE_PASS_API_KEY'

/** The launching environment's key, projected as the primary account on read. */
function ambientCredentials(): ClinePassCredentials | null {
  const value = process.env[CLINE_PASS_API_KEY_ENV]?.trim()
  return value === undefined || value === '' ? null : { apiKey: value }
}

/**
 * Stable identity of one key.
 *
 * Cline hands the user a bare key and nothing else — no account id, no email —
 * so the key's own digest is the only identity available. It is never written
 * anywhere: it exists to tell two pasted keys apart inside the pool document,
 * and it is not a credential and cannot be used as one.
 */
export function clinePassAccountKey(credentials: ClinePassCredentials): string {
  return createHash('sha256').update(credentials.apiKey).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Cline Pass pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseClinePassPoolData(value: unknown): PoolData<ClinePassPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Cline Pass pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: ClinePassPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseClinePassCredentials(raw.credentials)
    const account: ClinePassPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : 'Cline Pass 账号',
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
  const result: PoolData<ClinePassPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface ClinePassAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<ClinePassPoolAccount>>
  maxAccounts?: number
}

/**
 * Cline Pass's account pool.
 *
 * A Cline Pass credential is a static key that never expires, so this wrapper
 * supplies identity, the display alias a user chose, and the mirror of the
 * single-credential file — no refresh logic is needed anywhere.
 */
export class ClinePassAccountPool extends AccountPoolCore<
  ClinePassCredentials,
  ClinePassPoolAccount,
  ClinePassAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: ClinePassAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<ClinePassCredentials, ClinePassPoolAccount, ClinePassAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: clinePassPoolPath(),
      keychainService: 'dsh-cline-pass-pool',
      parsePoolData: parseClinePassPoolData,
      dedupeKey: clinePassAccountKey,
      defaultAlias: (credentials, position) =>
        credentials.alias ?? `Cline Pass 账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // An existing single-key install becomes the primary account, so nothing a
      // user already configured has to be re-entered. A deployment that exports
      // CLINE_PASS_API_KEY (what the standalone dsh-cline-pass plugin reads) gets
      // the same projection without pasting the key first; it is not persisted.
      legacyAccount: async () => {
        const stored = await store.read()
        const ambient = stored ?? ambientCredentials()
        if (ambient === null) return null
        return {
          id: 'acc_primary',
          alias: ambient.alias ?? 'Cline Pass 账号 1',
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
        if (account.lastModelId === undefined) return base
        return { ...base, planLabel: account.lastModelId } as ClinePassAccountSummaryDto
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
  ): Promise<{ account: ClinePassPoolAccount; credentials: ClinePassCredentials }> {
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
