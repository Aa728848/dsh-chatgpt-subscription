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
import type { OllamaAccountSummaryDto } from '../../shared/ollama-contracts.ts'

/** One pooled Ollama key: the bearer key plus the display facts the card renders. */
export interface OllamaPoolAccount extends PoolAccountShape<OllamaCredentials> {
  /** Model id this account last served, for the card's detail line. */
  lastModelId?: string
  // What this key has consumed, accumulated locally. Counted from the token
  // counts Ollama's own API reports on each response (prompt_eval_count and
  // eval_count) and summed here. This measures spend, it is NOT a quota: the
  // service publishes no account limit, no remaining balance and no reset time,
  // so nothing can report what is left - only what has gone. A user who needs a
  // remaining figure has to read the web dashboard.
  usage?: {
    inputTokens: number
    outputTokens: number
    requestCount: number
    /** Unix milliseconds the last completed turn was counted. */
    lastCountedAt?: number
  }
}

// The summary carries this line's extra facts, so it is the contract's own type
// rather than the shared base. The base alone type-checked the card and then
// dropped `usage` on the way across the route boundary.
export type { OllamaAccountSummaryDto }
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

/** Non-negative integer, or undefined for anything else. */
function counter(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Read one account's counters, dropping the whole record if it is unusable. */
function readUsage(value: unknown): OllamaPoolAccount['usage'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const inputTokens = counter(record.inputTokens)
  const outputTokens = counter(record.outputTokens)
  const requestCount = counter(record.requestCount)
  // All three travel together; a partial record means a hand-edited file, and
  // keeping half of it would show a request count with no tokens beside it.
  if (inputTokens === undefined || outputTokens === undefined || requestCount === undefined) return undefined
  const lastCountedAt = counter(record.lastCountedAt)
  return {
    inputTokens,
    outputTokens,
    requestCount,
    ...(lastCountedAt === undefined ? {} : { lastCountedAt }),
  }
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
    // Counters are read back rather than trusted blindly: a hand-edited pool file
    // with a negative or non-numeric total would otherwise shrink the card's
    // numbers on the next request rather than merely displaying wrongly.
    const usage = readUsage(raw.usage)
    if (usage !== undefined) account.usage = usage
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
        // `planLabel` is the shared card's free-text slot for one extra fact.
        // Reusing it keeps this tab on the shared component; the structured
        // counters travel in the contract's own fields so the card can render
        // them as numbers rather than parsing a sentence.
        const extra: Record<string, unknown> = {}
        if (account.lastModelId !== undefined) extra.planLabel = account.lastModelId
        if (account.usage !== undefined) extra.usage = { ...account.usage }
        return Object.keys(extra).length === 0 ? base : { ...base, ...extra }
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

  // Add one completed turn to an account's running totals. Called after the
  // stream ends, so a turn that failed mid-answer contributes nothing even
  // though the service may still have billed for it: the counts are only read
  // off a completed response. The write goes through the core's locked mutation
  // path so a concurrent rotation cannot lose it, and a missing account is not
  // an error - the pool may have been edited while a request was in flight.
  async recordUsage(accountId: string, inputTokens: number, outputTokens: number): Promise<void> {
    if (inputTokens <= 0 && outputTokens <= 0) return
    await this.updatePool((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId)
      if (account === undefined) return false
      const previous = account.usage
      account.usage = {
        inputTokens: (previous?.inputTokens ?? 0) + inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
        requestCount: (previous?.requestCount ?? 0) + 1,
        lastCountedAt: Date.now(),
      }
      return true
    }).catch(() => undefined)
  }
}
