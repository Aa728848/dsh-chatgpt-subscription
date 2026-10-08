/**
 * The ChatGPT account pool.
 *
 * TWO KINDS OF ACCOUNT, AND ONLY ONE OF THEM MAY BE REFRESHED.
 *
 * - managed — signed in through this plugin. Its credential lives in the pool's
 *   encrypted storage AND in the pre-pool credential document beside it, it is
 *   refreshable, and deleting it is this plugin's business.
 * - adopted — a SNAPSHOT read out of a local Codex CLI sign-in by 'codex-adopt.ts'
 *   (marker 'adopted: true', source 'codex'). It is used only while its own access
 *   token is still valid.
 *
 * An adopted snapshot is NEVER refreshed, and the reason is not an optimisation:
 * the ChatGPT refresh token the CLI stores rotates, and the CLI refreshes its own
 * file in place. Two processes spending one grant invalidate each other, and
 * whoever loses the race holds a token the server has already retired — which
 * leaves the user signed OUT of the Codex CLI by this plugin's good intentions. An
 * in-process single-flight cannot fix that, because the race is across PROCESSES
 * and the only state they share is a file 'codex-adopt.ts' must never write. Once
 * such a snapshot has expired the pool takes it out of rotation and surfaces
 * ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT — sign in again in the CODEX CLI and
 * re-import, not here.
 *
 * The rule is enforced twice on purpose: the needsRefresh hook answers false for
 * an adopted credential no matter what its expiry says, and the refresh hook
 * itself refuses one, so a future caller that forgets the first fails loudly
 * instead of silently spending a grant that is not ours to spend.
 *
 * MANAGED BEATS ADOPTED on a conflict, and the marker is therefore written on
 * EVERY account this file creates, including the explicit false case: the core
 * merges a re-authorization as { ...existing, ...created }, so an omitted key
 * would leave a stored 'adopted: true' — and its never-refresh consequence — on a
 * record that is now plugin-owned.
 */

import path from 'node:path'
import { TOKEN_REFRESH_MARGIN_MS } from '../compat.ts'
import { dshHomeDir } from './common/home.ts'
import {
  AccountPoolCore,
  normalizeRotationStrategy,
  type AccountPoolHooks,
  type PoolAccountShape,
  type PoolData,
} from './common/account-pool.ts'
import {
  parseStoredCredentials,
  type CredentialStore,
  type StoredOAuthCredentials,
  type TokenStore,
} from './token-store.ts'
import { createPlatformTokenStore } from './platform-token-store.ts'
import { ConcurrencyGate } from './common/concurrency-gate.ts'
import { OAuthServiceError } from './oauth-service.ts'
import type { AccountRotationStrategy, PoolAccountQuotaDto, PoolAccountSummaryDto } from '../shared/account-pool-contracts.ts'
import type { QuotaUsageDto } from '../shared/contracts.ts'
import { poolQuota, quotaWindow } from './common/account-quota.ts'
import {
  ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT,
  CODEX_CLI_CREDENTIAL_SOURCE,
  isAdoptedCodexCredentialExpired,
} from './codex-adopt.ts'

/** Where a pooled account's credential came from. */
export type CodexPoolAccountSource = 'managed' | typeof CODEX_CLI_CREDENTIAL_SOURCE

/** One pooled ChatGPT account: the credential plus the facts the card renders. */
export interface CodexPoolAccount extends PoolAccountShape<StoredOAuthCredentials> {
  /**
   * Which store owns the credential. Only managed rows may be refreshed.
   *
   * Derived from the credential rather than trusted from the row, so the two
   * spellings of the marker can never disagree about one account.
   */
  source: CodexPoolAccountSource
  /**
   * Whether this row is a borrowed snapshot.
   *
   * Required rather than optional: every construction site has to state it, which
   * is what keeps a stale true from surviving an in-place re-authorization.
   */
  adopted: boolean
  /** The Codex CLI file an adopted snapshot was read from; absent for managed rows. */
  sourcePath?: string
  email?: string
  planType?: string
  accountId?: string
}

/**
 * Whether a pooled credential is an adopted snapshot.
 *
 * The two fields, and only those two: a plain credential carries no 'adopted'
 * field and must never be mistaken for a snapshot, because treating a
 * plugin-owned account as a disposable one would freeze it out of refreshing and
 * make deleteAccount refuse to remove an account the user signed in here.
 */
export function isAdoptedCodexPoolCredential(credentials: StoredOAuthCredentials): boolean {
  return credentials.adopted === true && credentials.source === CODEX_CLI_CREDENTIAL_SOURCE
}

/**
 * Whether a credential must be refreshed before the next request.
 *
 * FALSE for every adopted snapshot, valid or expired. That is this pool's core
 * rule: an adopted credential is borrowed for exactly as long as the Codex CLI
 * vouched for it, and this pool has no business rotating a token another process
 * is rotating too. See the module comment.
 */
export function codexNeedsRefresh(credentials: StoredOAuthCredentials, now: number): boolean {
  if (isAdoptedCodexPoolCredential(credentials)) return false
  return credentials.expiresAt - now <= TOKEN_REFRESH_MARGIN_MS
}

/**
 * Why a stored credential is already known to be unusable, or nothing.
 *
 * Reported purely — nothing is written here — and consulted by the core for both
 * routing eligibility and credential usability, which is what makes an expired
 * snapshot non-routable WITHOUT a write on every read. The hint names the remedy
 * in the Codex CLI, because that is where the user has to go: re-adopting here is
 * only possible after the CLI itself signed in again.
 */
export function codexAuthRejectedReason(credentials: StoredOAuthCredentials): string | undefined {
  if (!isAdoptedCodexPoolCredential(credentials)) return undefined
  return isAdoptedCodexCredentialExpired(credentials) ? ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT : undefined
}

/**
 * Message raised if a refresh of a still-valid adopted snapshot were attempted.
 *
 * Unreachable through this pool's own paths (see the module comment); it exists
 * because 'unreachable' is a claim the guard has to be able to make good on.
 */
export const ADOPTED_NEVER_REFRESHED_MESSAGE =
  'The sign-in imported from the Codex CLI is never refreshed by this plugin: the Codex '
  + 'CLI refreshes the same rotating token, and two refreshers would invalidate each '
  + 'other. Sign in again in the Codex CLI, then import the new sign-in from this settings card.'

/** Raised when a refresh of an adopted snapshot is attempted. Never a 401. */
export class CodexAdoptedCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAdoptedCredentialError'
  }
}

/**
 * One account as the ChatGPT settings card renders it.
 *
 * Declared here rather than under 'src/shared/', for the same reason the Claude
 * line declares its own: source and provenance are this pool's vocabulary, and a
 * second copy in the shared contracts module is one that can drift. The base is
 * the shared summary, so every existing consumer of listAccounts() keeps working
 * unchanged — the extra fields are additive.
 */
export interface CodexAccountSummaryDto extends PoolAccountSummaryDto {
  /** Where the credential came from; a card offers different actions per source. */
  source?: CodexPoolAccountSource
  /** Whether this row is a snapshot borrowed from a local Codex CLI sign-in. */
  adopted?: boolean
  /** The Codex CLI file an adopted snapshot was read from. */
  sourcePath?: string
}

/** Encrypted pool file the ChatGPT line owns; the single-credential store stays the mirror. */
export function codexPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'codex-pool.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('ChatGPT pool account field is invalid')
  return value
}

/** Validate and normalize one whole pool document. */
export function parseCodexPoolData(value: unknown): PoolData<CodexPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ChatGPT pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  const accounts: CodexPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const credentials = parseStoredCredentials(raw.credentials)
    // The marker lives on the CREDENTIAL (see AdoptedCredentialMarkers) and is
    // read back by parseStoredCredentials, so it survives this round trip instead
    // of being dropped by a write the pool made for some other reason. A row that
    // lost it would come back looking plugin-owned and would be handed to a token
    // endpoint that rotates a grant the Codex CLI is also rotating.
    const adopted = isAdoptedCodexPoolCredential(credentials)
    const account: CodexPoolAccount = {
      id: raw.id,
      alias: typeof raw.alias === 'string' ? raw.alias : (credentials.email || '账号'),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
      adopted,
      source: adopted ? CODEX_CLI_CREDENTIAL_SOURCE : 'managed',
    }
    // The row's own spelling first, then the credential's: a row written before
    // the marker was carried on the credential still names its file.
    const sourcePath = optionalString(raw, 'sourcePath') ?? credentials.sourcePath
    if (adopted && sourcePath !== undefined) account.sourcePath = sourcePath
    const email = optionalString(raw, 'email') ?? credentials.email
    if (email !== undefined) account.email = email
    const planType = optionalString(raw, 'planType') ?? credentials.planType
    if (planType !== undefined) account.planType = planType
    const accountId = optionalString(raw, 'accountId') ?? credentials.accountId
    if (accountId !== undefined) account.accountId = accountId
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    accounts.push(account)
  }
  const result: PoolData<CodexPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts,
  }
  if (typeof record.activeAccountId === 'string') result.activeAccountId = record.activeAccountId
  return result
}

/** Token refresh the OAuth service lends the pool; refresh tokens rotate, so this must be the only writer. */
export interface CodexTokenRefresher {
  /** Refresh one account with the service's own token-endpoint fetch. */
  refreshAccount(credentials: StoredOAuthCredentials): Promise<StoredOAuthCredentials>
}

export interface CodexAccountPoolOptions {
  /** Single-credential store the pool mirrors its primary account into. */
  store?: TokenStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<CodexPoolAccount>>
  /** Accounts this pool accepts; defaults to the core's limit. */
  maxAccounts?: number
}

/**
 * Per-account in-flight requests, shared by every ChatGPT request this host
 * makes. A fan-out of subagents is what reaches a plan's concurrency bound, so
 * the bound is enforced here rather than discovered by cooling every account at
 * once. Limits are learned from upstream evidence (see
 * {@link CodexAccountPool.noteConcurrencySignal}), never assumed.
 */
const concurrency = new ConcurrencyGate()

export function chatGPTConcurrency(): ConcurrencyGate {
  return concurrency
}

/**
 * One ChatGPT usage snapshot as the account card's per-account quota.
 *
 * A bucket lists its windows either in `windows` or, on older payloads, only as
 * the `primary`/`secondary` pair — the same fallback the quota card itself
 * applies, so the account row cannot show fewer windows than the card does. The
 * label stays empty on purpose: a ChatGPT window is named by its length, and
 * the card localizes that length in the reader's own language.
 */
export function codexAccountQuota(snapshot: { usage: QuotaUsageDto; fetchedAt: number }): PoolAccountQuotaDto | undefined {
  return poolQuota(snapshot.fetchedAt, snapshot.usage.buckets.flatMap((bucket) => {
    const windows = bucket.windows.length > 0
      ? bucket.windows
      : [bucket.primary, bucket.secondary].filter((window) => window !== null)
    return windows.map((window) => quotaWindow('', window.usedPercent, {
      windowDurationMins: window.windowDurationMins,
      resetsAt: window.resetsAt,
    }))
  }))
}

export class CodexAccountPool extends AccountPoolCore<StoredOAuthCredentials, CodexPoolAccount, CodexAccountSummaryDto> {
  private readonly refresherRef: { current?: CodexTokenRefresher }
  private readonly store: TokenStore
  private readonly quotaSnapshotRef: { current?: (account: CodexPoolAccount) => PoolAccountQuotaDto | undefined }
  private quotaBlockedUntil?: (account: CodexPoolAccount, now: number) => number | undefined

  constructor(options: CodexAccountPoolOptions = {}) {
    const store = options.store ?? createPlatformTokenStore()
    const ref: { current?: CodexTokenRefresher } = {}
    // A ref rather than a field: the hooks below are built before `super()`, so
    // they may only close over something that already exists.
    const quotaSnapshotRef: { current?: (account: CodexPoolAccount) => PoolAccountQuotaDto | undefined } = {}
    const hooks: AccountPoolHooks<StoredOAuthCredentials, CodexPoolAccount, CodexAccountSummaryDto> = {
      providerId: 'codex-chatgpt',
      displayName: 'ChatGPT',
      poolFile: codexPoolPath(),
      keychainService: 'dsh-chatgpt-subscription-pool',
      parsePoolData: parseCodexPoolData,
      // One ChatGPT account is identified by its account id; the email is the
      // fallback for credentials minted before the id claim was read.
      dedupeKey: (credentials) => credentials.accountId ?? credentials.email,
      defaultAlias: (credentials, position) => credentials.email ?? `账号 ${position}`,
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => {
        const adopted = isAdoptedCodexPoolCredential(credentials)
        return {
          id,
          alias,
          credentials,
          addedAt,
          isPrimary,
          // Written on EVERY path, including the false one: the core merges a
          // re-authorization as { ...existing, ...created }, so an omitted key
          // would leave a stored 'adopted: true' — and its never-refresh
          // consequence — on a record that is now plugin-owned.
          adopted,
          source: adopted ? CODEX_CLI_CREDENTIAL_SOURCE : 'managed',
          // Cleared explicitly rather than omitted, for the same merge reason: a
          // re-authorization that follows an import must not keep naming a file it
          // no longer has anything to do with.
          sourcePath: adopted ? credentials.sourcePath : undefined,
          ...(credentials.email === undefined ? {} : { email: credentials.email }),
          ...(credentials.planType === undefined ? {} : { planType: credentials.planType }),
          ...(credentials.accountId === undefined ? {} : { accountId: credentials.accountId }),
        } satisfies CodexPoolAccount
      },
      expiresAt: (credentials) => credentials.expiresAt,
      needsRefresh: (credentials, now) => codexNeedsRefresh(credentials, now),
      refresh: async (credentials) => {
        // The guard, stated where the call happens: a caller that reaches here
        // with a snapshot fails loudly instead of spending a rotating grant the
        // Codex CLI is also spending. Unreachable from the pool's own paths
        // (needsRefresh answers false), and that is exactly why it is here.
        if (isAdoptedCodexPoolCredential(credentials)) {
          throw new CodexAdoptedCredentialError(
            isAdoptedCodexCredentialExpired(credentials)
              ? ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT
              : ADOPTED_NEVER_REFRESHED_MESSAGE,
          )
        }
        const refresher = ref.current
        if (refresher === undefined) throw new Error('ChatGPT 凭据刷新服务尚未就绪')
        return refresher.refreshAccount(credentials)
      },
      // Pure check — nothing is written — and the reason a borrowed snapshot that
      // has aged out is refused without a refresh ever being attempted.
      authRejectedReason: (credentials) => codexAuthRejectedReason(credentials),
      // A refresh the token endpoint rejects (400/401) means this account must be
      // signed in again; a transport failure must not cost it its place.
      refreshFailureStatus: (error) => (error instanceof OAuthServiceError
        && (error.status === 400 || error.status === 401)
        ? 'expired'
        : undefined),
      // The pre-pool single credential stays usable: reading the pool projects it
      // as the primary account without writing anything back.
      legacyAccount: async () => {
        const stored = await store.load()
        if (stored === null) return null
        return {
          id: 'acc_primary',
          alias: stored.email || '主账号',
          credentials: stored,
          addedAt: Date.now(),
          isPrimary: true,
          // The pre-pool document only ever holds this plugin's own sign-ins: an
          // adopted snapshot is added to the pool and never written here, because
          // it is not this plugin's credential to keep.
          adopted: false,
          source: 'managed',
          ...(stored.email === undefined ? {} : { email: stored.email }),
          ...(stored.planType === undefined ? {} : { planType: stored.planType }),
          ...(stored.accountId === undefined ? {} : { accountId: stored.accountId }),
        } satisfies CodexPoolAccount
      },
      mirrorPrimary: async (credentials) => {
        if (credentials === null) {
          await store.clear()
          return
        }
        // A borrowed snapshot is NEVER copied into this plugin's own
        // single-credential store. It is not this plugin's sign-in to keep, and
        // mirroring it would make the pre-pool projection hand a Codex CLI
        // snapshot back as though the user had signed in here — and would
        // overwrite the managed sign-in this store exists to keep. The pool still
        // routes the row; only the mirror is skipped.
        if (isAdoptedCodexPoolCredential(credentials)) return
        await store.save(credentials)
      },
      extendSummary: (account, base) => {
        const adopted = account.adopted === true
        // LIVE, not stored: a snapshot becomes unusable at its own expiry instant,
        // and persisting that would mean a write on every read.
        const expired = adopted && isAdoptedCodexCredentialExpired(account.credentials)
        return {
          ...base,
          ...(account.email === undefined ? {} : { email: account.email }),
          ...(account.planType === undefined ? {} : { planLabel: account.planType }),
          adopted,
          source: account.source,
          // Deleting the row is the card's action for an account this plugin owns.
          // A borrowed snapshot is not this plugin's file to delete, so the card
          // offers its own remove-import action instead.
          removable: !adopted,
          ...(account.sourcePath === undefined ? {} : { sourcePath: account.sourcePath }),
          // The account's own newest quota snapshot, when the usage service has
          // read this account before. Absent means exactly that: never read.
          ...(() => {
            const quota = quotaSnapshotRef.current?.(account)
            return quota === undefined ? {} : { quota }
          })(),
          ...(expired
            ? { authStatus: 'expired' as const, authFailedReason: ADOPTED_CODEX_CREDENTIAL_EXPIRED_HINT }
            : {}),
        }
      },
      emptyMessage: '未登录 ChatGPT 账号，请在「设置 → 订阅服务 → ChatGPT」中添加并登录账号。',
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.refresherRef = ref
    this.quotaSnapshotRef = quotaSnapshotRef
    this.store = store
  }

  /** Hand the pool the OAuth service's per-account refresh implementation. */
  setRefresher(refresher: CodexTokenRefresher): void {
    this.refresherRef.current = refresher
  }

  /**
   * Wire in a cached-quota verdict.
   *
   * The return value is the time the account's Codex window reopens; a lookup
   * returning undefined (or a past time) leaves the account routable. This is
   * how an exhausted window is skipped before a request is even attempted,
   * instead of discovering it from a 429.
   */
  setQuotaBlockedUntil(lookup: (account: CodexPoolAccount, now: number) => number | undefined): void {
    this.quotaBlockedUntil = lookup
  }

  /**
   * Wire in the account's own newest quota snapshot, for display only.
   *
   * The same map that already spares an exhausted account a wasted request also
   * answers "what did this account's window look like last time we read it".
   * The lookup must be a memory read: it runs while the settings card builds
   * its account list, and that page must never fan out an upstream request per
   * pooled account.
   */
  setQuotaSnapshot(lookup: (account: CodexPoolAccount) => PoolAccountQuotaDto | undefined): void {
    this.quotaSnapshotRef.current = lookup
  }

  protected override isEligible(
    account: CodexPoolAccount,
    now: number,
    triedAccountIds?: ReadonlySet<string>,
  ): boolean {
    if (!super.isEligible(account, now, triedAccountIds)) return false
    const blockedUntil = this.quotaBlockedUntil?.(account, now)
    return blockedUntil === undefined || blockedUntil <= now
  }

  /**
   * Force one account's token refresh and persist the rotated pair.
   *
   * Used after a 401: the core refreshes proactively when a token is close to
   * expiry, but a server-side revocation is only discovered by the request.
   */
  async refreshAccountNow(accountId: string): Promise<StoredOAuthCredentials> {
    const data = await this.read()
    const account = data.accounts.find((entry) => entry.id === accountId)
    if (account === undefined) throw new Error('ChatGPT 账号已不在号池中')
    const refresher = this.refresherRef.current
    if (refresher === undefined) throw new Error('ChatGPT 凭据刷新服务尚未就绪')
    // The core owns the single-flight and the conditional commit, and the
    // generation passed here is the guard: a rotation that started before a
    // re-login must not spend the re-login's refresh token.
    return this.renewCredential(accountId, fetch, account.credentials)
  }

  /**
   * Remove one account inside a transaction, refusing a borrowed snapshot.
   *
   * The check lives HERE rather than in the public delete method so it cannot be
   * separated from the removal by a concurrent change, and so every caller of the
   * core's own deletion inherits it. The remedy is a separate action
   * ({@link removeImportedAccount}): a card must not destroy an account this plugin
   * did not create with the same button that deletes its own.
   */
  protected override deleteAccountFromPool(data: PoolData<CodexPoolAccount>, accountId: string): void {
    if (data.accounts.find((account) => account.id === accountId)?.adopted === true) {
      throw new Error('The sign-in imported from the Codex CLI is not an account this plugin owns; remove the import instead.')
    }
    super.deleteAccountFromPool(data, accountId)
  }

  /**
   * Drop an imported snapshot from the pool — the card's 'remove import' action.
   *
   * Separate from {@link deleteAccount} because that refuses one, and because the
   * user is asking to stop borrowing a sign-in, not to sign out of an account. The
   * Codex CLI's own file is touched by neither path: not deleted, not rewritten,
   * not moved. This only forgets the copy.
   */
  async removeImportedAccount(accountId: string): Promise<void> {
    return this.updatePool((data) => {
      const target = data.accounts.find((account) => account.id === accountId)
      if (target === undefined) return
      if (target.adopted !== true) {
        throw new Error('That account was signed in through this plugin; delete it instead of removing an import.')
      }
      // The core's own deletion, so primary/active/mirror handling stays in one
      // place, and the check above cannot be separated from it by a concurrent
      // change. The credential document is never touched: a snapshot is not this
      // plugin's sign-in to keep.
      super.deleteAccountFromPool(data, accountId)
    })
  }

  /** The single-credential store this pool mirrors its primary account into. */
  mirrorStore(): TokenStore {
    return this.store
  }

  /** Rotation strategy currently configured. */
  async strategy(): Promise<AccountRotationStrategy> {
    return (await this.read()).rotationStrategy
  }
}
