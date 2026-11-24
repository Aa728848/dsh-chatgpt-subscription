/**
 * The RelayOne account pool: several API keys behind one line.
 *
 * RelayOne is a New API / one-api style gateway: a user is handed a bare
 * `sk-…` token and nothing else — no account id, no email. That shapes the pool
 * the same way it shaped Cline Pass's:
 *
 * - identity is the key's own digest, never a stored secret;
 * - there is no token refresh — a key either authenticates or it does not;
 * - the pre-pool single-key file stays readable, so an install that already
 *   pasted one key becomes the primary account instead of losing it.
 *
 * Unlike every other pooled line, this one does NOT rotate automatically. The
 * user switches between stored keys by hand: the active account serves every
 * request until they pick another one. That is a deliberate product decision —
 * a RelayOne token is billed per key, so a request silently landing on a
 * different key than the one the user selected is the wrong behaviour here.
 *
 * Storage, validation and eligibility are still the kernel's
 * (`AccountPoolCore`); only selection and the key handling below are this line's.
 */
import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
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
import type { RelayOneAccountSummaryDto } from '../../../shared/relayone-contracts.ts'
import {
  relayOneCredentialFingerprint,
  type RelayOneCredentialStore,
  type RelayOneCredentials,
} from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts'

/** One pooled RelayOne key: the bearer token plus the facts the card renders. */
export interface RelayOnePoolAccount extends PoolAccountShape<RelayOneCredentials> {
  /** Model id this account last served, for the card's detail line. */
  lastModelId?: string
}

/** Encrypted pool file this line owns. */
export function relayOnePoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'relayone-pool.json')
}

/**
 * Stable identity of one key.
 *
 * RelayOne hands the user a bare token and nothing else, so the key's digest is
 * the only identity available. It is never written anywhere a user can read it
 * back, and it is not a credential: it exists to tell two pasted keys apart
 * inside the pool document and to scope the catalog snapshot per account.
 */
export function relayOneAccountKey(credentials: RelayOneCredentials): string {
  return relayOneCredentialFingerprint(credentials)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('RelayOne pool account field is invalid: ' + key)
  return value
}

/**
 * Validate one whole pool document.
 *
 * An unreadable key is dropped rather than thrown out of the whole document: a
 * pool that lost one row to a truncated write must still serve the others, and
 * the row is re-addable by pasting the key again.
 */
export function parseRelayOnePoolData(value: unknown): PoolData<RelayOnePoolAccount> {
  if (!isRecord(value)) throw new Error('RelayOne pool payload is invalid.')
  const accounts: RelayOnePoolAccount[] = []
  for (const item of Array.isArray(value.accounts) ? value.accounts : []) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue
    const raw = isRecord(item.credentials) ? item.credentials : undefined
    const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : ''
    if (apiKey === '') continue
    const account: RelayOnePoolAccount = {
      id: item.id,
      alias: typeof item.alias === 'string' && item.alias.trim() !== '' ? item.alias.trim() : 'RelayOne 账号',
      credentials: {
        apiKey,
        authenticatedAt: typeof raw?.authenticatedAt === 'number' && Number.isFinite(raw.authenticatedAt)
          ? raw.authenticatedAt : Date.now(),
      },
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      isPrimary: item.isPrimary === true,
    }
    const lastModelId = optionalString(item, 'lastModelId')
    if (lastModelId !== undefined) account.lastModelId = lastModelId
    if (typeof item.lastUsedAt === 'number') account.lastUsedAt = item.lastUsedAt
    if (typeof item.cooldownUntil === 'number') account.cooldownUntil = item.cooldownUntil
    if (typeof item.cooldownReason === 'string') account.cooldownReason = item.cooldownReason
    if (item.authStatus === 'expired' || item.authStatus === 'invalid') account.authStatus = item.authStatus
    if (typeof item.authFailedReason === 'string') account.authFailedReason = item.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<RelayOnePoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(value.rotationStrategy),
    accounts,
  }
  if (typeof value.activeAccountId === 'string') result.activeAccountId = value.activeAccountId
  return result
}

export interface RelayOneAccountPoolOptions {
  /**
   * Pre-pool single-key store the pool mirrors its primary account into.
   *
   * It stays the migration source: a deployment that pasted one key before the
   * pool existed still has that file, and `legacyAccount` reads it. Passing
   * `null` disables the mirror entirely, which is what the media tools do when
   * they were handed a pool and no store.
   */
  store?: RelayOneCredentialStore | null
  /** Test seam; production resolves the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<RelayOnePoolAccount>>
  maxAccounts?: number
}

/**
 * RelayOne's account pool.
 *
 * There is no refresh hook on purpose: a New API token has no expiry the client
 * can renew, so an account whose key is refused is marked and rotated past
 * rather than silently retried forever.
 */
export class RelayOneAccountPool extends AccountPoolCore<
  RelayOneCredentials,
  RelayOnePoolAccount,
  RelayOneAccountSummaryDto
> {
  private readonly store: RelayOneCredentialStore | null

  constructor(options: RelayOneAccountPoolOptions = {}) {
    const store = options.store === undefined ? null : options.store
    const hooks: AccountPoolHooks<RelayOneCredentials, RelayOnePoolAccount, RelayOneAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: relayOnePoolPath(),
      keychainService: 'dsh-relayone-pool',
      parsePoolData: parseRelayOnePoolData,
      dedupeKey: relayOneAccountKey,
      defaultAlias: (_credentials, position) => 'RelayOne 账号 ' + position,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
      }),
      // The pool's own rotation state is the routing record; a key the upstream
      // refused stays in the pool with `authStatus` set so the card can offer a
      // replacement instead of deleting the row and losing its alias.
      emptyMessage: '还没有配置任何 RelayOne API Key。请在设置里添加一个。',
      extendSummary: (account, base) => {
        const summary: RelayOneAccountSummaryDto = { ...base }
        if (account.lastModelId !== undefined) summary.planLabel = account.lastModelId
        return summary
      },
      ...(store === null ? {} : {
        // An install that pasted a single key before the pool existed becomes
        // the primary account, so nothing a user already configured has to be
        // re-entered after the upgrade.
        legacyAccount: async () => {
          const legacy = await store.read().catch(() => null)
          if (legacy === null) return null
          return {
            id: 'acc_primary',
            alias: 'RelayOne 账号 1',
            credentials: legacy,
            addedAt: legacy.authenticatedAt,
            isPrimary: true,
          }
        },
        mirrorPrimary: async (credentials) => {
          if (credentials === null) {
            await store.delete()
            return
          }
          await store.write(credentials)
        },
      }),
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
  }

  /** The pre-pool single-key file this pool mirrors its primary account into. */
  mirrorStore(): RelayOneCredentialStore | null {
    return this.store
  }

  /**
   * The key that serves requests right now.
   *
   * This is the MANUAL selection, never a rotation: the user switched to one
   * key, and that key answers every request until they switch again. A key that
   * was rejected or is resting is still reported as the selection — the card
   * shows its state and offers the next one — because silently answering from a
   * different key would spend an account the user did not choose.
   *
   * @throws LlmError with `AUTH` when the pool holds no key at all, or when the
   *   selected key's credential was rejected upstream.
   */
  async getEffectiveCredential(
    _excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: RelayOnePoolAccount; credentials: RelayOneCredentials }> {
    const data = await this.read()
    if (data.accounts.length === 0) {
      throw new LlmError(this.hooks.emptyMessage ?? '还没有配置任何 RelayOne API Key。', 'AUTH', { status: 401 })
    }
    const selected = data.accounts.find((account) => account.id === data.activeAccountId)
      ?? data.accounts.find((account) => account.isPrimary)
      ?? data.accounts[0]!
    if (selected.authStatus !== undefined && selected.authStatus !== 'ok') {
      throw new LlmError(
        '当前 RelayOne Key 已被上游拒绝。请在设置里切换到另一个 Key，或更换这个 Key。',
        'AUTH',
        { status: 401 },
      )
    }
    // Bookkeeping only: remembering the last use must never fail a request.
    await this.updatePool((current) => {
      const latest = current.accounts.find((entry) => entry.id === selected.id)
      if (latest !== undefined) latest.lastUsedAt = Date.now()
    }).catch(() => undefined)
    return { account: selected, credentials: await this.freshKey(selected, fetchFn) }
  }

  /** A key is never refreshed; the hook exists so the kernel's shape is reused. */
  private async freshKey(account: RelayOnePoolAccount, _fetchFn: typeof fetch): Promise<RelayOneCredentials> {
    return account.credentials
  }

  /**
   * Make one key the active one.
   *
   * This is the whole "switch key" feature: the selection is persisted, so it
   * survives a restart, and the next request uses it.
   */
  async switchTo(accountId: string): Promise<void> {
    await this.updatePool((data) => {
      if (!data.accounts.some((account) => account.id === accountId)) {
        throw new Error('这个 RelayOne Key 不在号池里。')
      }
      data.activeAccountId = accountId
    })
  }

  /**
   * A key for work that is not a metered model request — the catalog listing,
   * the quota read and the media tools.
   *
   * Those tools ask "may I have a usable key?" rather than "which account should
   * serve this request?", so a cooldown (rotation bookkeeping) must not take the
   * model list down with it. Returns null instead of throwing, because a line
   * with no key configured is a state the card renders, not an error.
   */
  async anyCredential(fetchFn: typeof fetch = fetch): Promise<RelayOneCredentials | null> {
    const effective = await this.getCredentialAccount(fetchFn).catch(() => null)
    return effective?.credentials ?? null
  }

  /**
   * The key that describes the line as a whole, for work that is NOT a request.
   *
   * A catalog listing and a quota figure are read once and cached, but under
   * round-robin `anyCredential` answers with a different key on every call:
   * both are scoped by key, so the scope would change on each read and the
   * manager would discard the catalog it had just loaded and report "no models"
   * until the next refresh landed. That is a flapping model list, not a
   * rotation.
   *
   * The SELECTED account is the stable answer: under manual switching it is the
   * key that serves requests and the one the panel describes, and it changes
   * only when the user changes it. Falling back to the primary and then the
   * first row keeps a pool that has no explicit selection readable.
   */
  async stableCredential(): Promise<RelayOneCredentials | null> {
    const data = await this.read().catch(() => null)
    if (data === null) return null
    const account = data.accounts.find((entry) => entry.id === data.activeAccountId)
      ?? data.accounts.find((entry) => entry.isPrimary)
      ?? data.accounts[0]
    if (account === undefined) {
      // Nothing pooled yet: fall back to the pre-pool projection so a migrated
      // install still reads its catalog before anything is written.
      return (await this.anyCredential().catch(() => null))
    }
    if (account.authStatus !== undefined && account.authStatus !== 'ok') return null
    return account.credentials
  }

  /** Identity of the key a catalog snapshot or a quota read belongs to. */
  async currentScope(): Promise<string | null> {
    const credentials = await this.stableCredential()
    return credentials === null ? null : relayOneAccountKey(credentials)
  }

  /**
   * The stored strategy, always `sequential`.
   *
   * Kept because the shared pool DTO carries the field; this line never offers
   * a choice, and the card hides the picker.
   */
  async strategy(): Promise<AccountRotationStrategy> {
    return 'sequential'
  }

  /** The account that would serve the next request, for the card's "in use" badge. */
  async activeAccountId(): Promise<string | undefined> {
    return (await this.read().catch(() => null))?.activeAccountId
  }

  /** Remember which model an account last served, best-effort. */
  async recordModel(accountId: string, model: string): Promise<void> {
    await this.updatePool((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId)
      if (account === undefined) return
      account.lastModelId = model
    }).catch(() => undefined)
  }

  /**
   * Forget the auth verdict on one account after a successful call.
   *
   * A transient 401 (an upstream restart, a gateway bug) marks the key; without
   * this, one blip would keep a perfectly good key out of rotation until the
   * user restarted the host.
   */
  async clearRejected(accountId: string): Promise<void> {
    const data = await this.read().catch(() => null)
    const account = data?.accounts.find((entry) => entry.id === accountId)
    if (account?.authStatus === undefined) return
    await this.clearAuthFailed(accountId).catch(() => undefined)
  }
}
