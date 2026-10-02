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
  parseOllamaCredentials,
  type OllamaCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'
import type { AccountPoolStatusDto } from '../../shared/account-pool-contracts.ts'

/** One pooled Ollama key: the bearer key plus the display facts the card renders. */
export interface OllamaPoolAccount extends PoolAccountShape<OllamaCredentials> {
  /** Model ids this account was last seen serving, for the card's detail line. */
  lastModelId?: string
}

export type OllamaAccountSummaryDto = AccountPoolStatusDto['accounts'][number]
export type OllamaPoolStatusDto = AccountPoolStatusDto

/** Encrypted pool file this line owns. */
export function ollamaPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'ollama-pool.json')
}

/**
 * Stable identity of one key.
 *
 * Ollama hands the user a bare key and nothing else — no account id, no email —
 * so the key's own digest is the only identity available. It is never written
 * anywhere: it exists to tell two pasted keys apart inside the pool document,
 * and it is not a credential and cannot be used as one.
 */
export function ollamaAccountKey(credentials: OllamaCredentials): string {
  return createHash('sha256').update(credentials.apiKey).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Ollama pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseOllamaPoolData(value: unknown): PoolData<OllamaPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Ollama pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: OllamaPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseOllamaCredentials(raw.credentials)
    const account: OllamaPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : 'Ollama 账号',
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
  const result: PoolData<OllamaPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

export interface OllamaAccountPoolOptions {
  /** Pre-pool credential file the pool mirrors its primary account into. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<OllamaPoolAccount>>
  maxAccounts?: number
}

/**
 * Ollama's account pool.
 *
 * An Ollama credential is a static key that never expires, so this wrapper
 * supplies identity, the display alias a user chose, and the mirror of the
 * single-credential file — no refresh logic is needed anywhere.
 */
export class OllamaAccountPool extends AccountPoolCore<
  OllamaCredentials,
  OllamaPoolAccount,
  OllamaAccountSummaryDto
> {
  private readonly store: FileCredentialStore

  constructor(options: OllamaAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<OllamaCredentials, OllamaPoolAccount, OllamaAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: ollamaPoolPath(),
      keychainService: 'dsh-ollama-pool',
      parsePoolData: parseOllamaPoolData,
      dedupeKey: ollamaAccountKey,
      defaultAlias: (credentials, position) =>
        credentials.alias ?? `Ollama 账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // An existing single-key install becomes the primary account, so nothing a
      // user already configured has to be re-entered.
      legacyAccount: async () => {
        const stored = await store.read()
        if (stored === null) return null
        return {
          id: 'acc_primary',
          alias: stored.alias ?? 'Ollama 账号 1',
          credentials: stored,
          addedAt: stored.addedAt ?? Date.now(),
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
        if (account.lastModelId !== undefined) {
          return { ...base, planLabel: account.lastModelId }
        }
        return base
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
   * Ollama's credential carries no deployment dimension - there is one cloud
   * endpoint and every key is valid for it - so the account and its key are
   * returned together and nothing has to be attached to the credential.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: OllamaPoolAccount; credentials: OllamaCredentials }> {
    return this.getEffectiveAccount(excludeIds, fetchFn)
  }

  /** The pre-pool credential file this pool mirrors its primary account into. */
  mirrorStore(): FileCredentialStore {
    return this.store
  }
}
