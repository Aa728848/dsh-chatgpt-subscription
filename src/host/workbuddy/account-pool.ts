/**
 * WorkBuddy's account pool.
 *
 * This line is the one that adopts accounts it does not own: alongside the
 * accounts a user signs in through this plugin, it reads the CodeBuddy desktop
 * client's own `*.info` credentials so an existing IDE sign-in needs no second
 * login. Both kinds take part in scheduling through the shared
 * {@link AccountPoolCore}, and the difference is enforced here:
 *
 * - **managed** accounts were signed in through this plugin. They live in the
 *   pool's encrypted storage and may be deleted.
 * - **desktop** accounts belong to the IDE. Their credential is re-read from the
 *   IDE's file on every pick, because the IDE rotates it on its own schedule and
 *   a cached copy would go stale; they are never deleted, only hidden.
 */

import path from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
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
  isExpired,
  workBuddyAccountId,
  workBuddyAccountIdAliases,
  type WorkBuddyCredentials,
} from './token-store.ts'
import { refreshCredentials } from './client.ts'
import { hasStableIdentity, withResolvedIdentity } from './identity.ts'
import { PROVIDER_ID, PROVIDER_NAME, regionForDomain } from './types.ts'
import type {
  WorkBuddyAccountSummaryDto,
  WorkBuddyRegion,
} from '../../shared/workbuddy-contracts.ts'

/** One pooled WorkBuddy account: the credential plus the facts the card renders. */
export interface WorkBuddyPoolAccount extends PoolAccountShape<WorkBuddyCredentials> {
  region: WorkBuddyRegion
  nickname?: string
  uin?: string
  /** Which store owns the credential; only managed accounts may be deleted. */
  source: 'desktop' | 'managed'
  /** IDE file a desktop account came from; absent for managed accounts. */
  sourceFile?: string
}

/** Encrypted pool file this line owns. */
export function workBuddyPoolPath(): string {
  return path.join(dshHomeDir(), 'storages', 'workbuddy-pool.json')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('WorkBuddy pool account field is invalid')
  return value
}

/**
 * Validate and normalize one whole pool document.
 *
 * A record whose credential is unusable is dropped rather than repaired: the
 * account can always be adopted again from its file or by signing in again, and
 * keeping a credential-less row would offer the user an account nothing can use.
 */
export function parseWorkBuddyPoolData(value: unknown): PoolData<WorkBuddyPoolAccount> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('WorkBuddy pool payload is invalid')
  }
  const record = value as Record<string, unknown>
  /** Stored id → healed id, so a persisted pointer can follow the heal. */
  const heal = new Map<string, string>()
  const parsedRows: WorkBuddyPoolAccount[] = []
  for (const item of Array.isArray(record.accounts) ? record.accounts : []) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string') continue
    const parsed = parsePoolCredential(raw.credentials)
    if (parsed === null) continue
    // Healing a stored row's identity is what lets the id be re-derived from
    // it: a row written by the old name-fallback holds the display name where
    // its own token states the uid, and re-keying it is how a duplicate pair
    // collapses back into one account.
    const credentials = withResolvedIdentity(parsed)
    // Re-key only when the credential names its own account. One that states no
    // identity at all has nothing to derive a better key from, and replacing a
    // stored key with the domain-derived fallback would both lose the row's
    // address and merge unrelated accounts on the same deployment.
    const id = hasStableIdentity(credentials) ? workBuddyAccountId(credentials) : raw.id
    heal.set(raw.id, id)
    const account: WorkBuddyPoolAccount = {
      id,
      alias: typeof raw.alias === 'string' ? raw.alias : defaultAliasFor(credentials, parsedRows.length + 1),
      credentials,
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
      isPrimary: raw.isPrimary === true,
      region: credentials.region,
      source: raw.source === 'desktop' ? 'desktop' : 'managed',
    }
    const nickname = optionalString(raw, 'nickname') ?? credentials.nickname
    if (nickname !== undefined) account.nickname = nickname
    const uin = optionalString(raw, 'uin') ?? credentials.uin
    if (uin !== undefined) account.uin = uin
    const sourceFile = optionalString(raw, 'sourceFile')
    if (sourceFile !== undefined) account.sourceFile = sourceFile
    if (typeof raw.lastUsedAt === 'number') account.lastUsedAt = raw.lastUsedAt
    if (typeof raw.cooldownUntil === 'number') account.cooldownUntil = raw.cooldownUntil
    if (typeof raw.cooldownReason === 'string') account.cooldownReason = raw.cooldownReason
    if (raw.authStatus === 'expired' || raw.authStatus === 'invalid') account.authStatus = raw.authStatus
    if (typeof raw.authFailedReason === 'string') account.authFailedReason = raw.authFailedReason
    parsedRows.push(account)
  }

  // Re-keying can make two stored rows name the same account — precisely the
  // duplicate this heal exists to remove — so the healed id, not the stored
  // one, decides what is distinct. The credential store reports a managed row
  // ahead of a desktop row for one account, so that same precedence is applied
  // here rather than letting the file order decide, and the routing state the
  // discarded row carried is folded into the winner.
  const collapsed = new Map<string, WorkBuddyPoolAccount>()
  for (const account of parsedRows) {
    const existing = collapsed.get(account.id)
    if (existing === undefined) {
      collapsed.set(account.id, account)
      continue
    }
    const winner = existing.source !== 'managed' && account.source === 'managed' ? account : existing
    const loser = winner === existing ? account : existing
    winner.isPrimary = winner.isPrimary || loser.isPrimary === true
    winner.addedAt = Math.min(winner.addedAt, loser.addedAt)
    winner.lastUsedAt ??= loser.lastUsedAt
    if (winner.cooldownUntil === undefined) {
      winner.cooldownUntil = loser.cooldownUntil
      winner.cooldownReason = loser.cooldownReason
    }
    if (winner.authStatus === undefined) {
      winner.authStatus = loser.authStatus
      winner.authFailedReason = loser.authFailedReason
    }
    // The discarded row can be the only one that carried a fact the card
    // renders — the IDE file states the UIN and the file path while a login
    // response states neither — so those display fields are folded across too.
    winner.nickname ??= loser.nickname
    winner.uin ??= loser.uin
    winner.sourceFile ??= loser.sourceFile
    collapsed.set(account.id, winner)
  }

  const result: PoolData<WorkBuddyPoolAccount> = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts: [...collapsed.values()],
  }
  // A stored pointer names the row's old id; it has to follow the heal or the
  // settings document would address an account the pool no longer has.
  if (typeof record.activeAccountId === 'string') {
    result.activeAccountId = heal.get(record.activeAccountId) ?? record.activeAccountId
  }
  return result
}

/** Parse one pooled credential; null when the row cannot serve a request. */
function parsePoolCredential(value: unknown): WorkBuddyCredentials | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.accessToken !== 'string' || raw.accessToken === '') return null
  const domain = typeof raw.domain === 'string' && raw.domain !== '' ? raw.domain : 'www.codebuddy.cn'
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === 'string' ? raw.refreshToken : '',
    expiresAt,
    region: regionForDomain(domain),
    domain,
    backend: typeof raw.backend === 'string' && raw.backend !== ''
      ? raw.backend
      : backendFromDomain(domain),
    ...(typeof raw.uid === 'string' ? { uid: raw.uid } : {}),
    ...(typeof raw.nickname === 'string' ? { nickname: raw.nickname } : {}),
    ...(typeof raw.uin === 'string' ? { uin: raw.uin } : {}),
    ...(typeof raw.accountType === 'string' ? { accountType: raw.accountType } : {}),
    ...(typeof raw.enterpriseId === 'string' ? { enterpriseId: raw.enterpriseId } : {}),
    sourceFile: typeof raw.sourceFile === 'string' ? raw.sourceFile : '',
    sourceMtimeMs: typeof raw.sourceMtimeMs === 'number' ? raw.sourceMtimeMs : 0,
    source: raw.source === 'desktop' ? 'desktop' : 'managed',
  }
}

/** Backend base URL for a domain, mirroring the token layer without importing it. */
function backendFromDomain(domain: string): string {
  const value = domain.trim().toLowerCase()
  if (!value.endsWith('.workbuddy.ai') && !value.endsWith('.codebuddy.ai')) return 'https://copilot.tencent.com'
  return `https://www.${value.split('.').slice(-2).join('.')}`
}

/**
 * The name a freshly adopted account is labelled with.
 *
 * The human-recognizable facts come first: the display name, then the Tencent
 * UIN a user can actually check against their own account page. A uid is a
 * uuid, so it is offered only as a last resort — and only when it is real,
 * which is what the identity heal guarantees before this runs. A positional
 * label is reachable only for a credential that states no identity at all,
 * which is the case that used to be reported as "the account shows 账号 1".
 */
function defaultAliasFor(credentials: WorkBuddyCredentials, position: number): string {
  return credentials.nickname || credentials.uin || credentials.uid || `账号 ${position}`
}

export interface WorkBuddyAccountPoolOptions {
  /** Credential store the desktop scan reads through; the pool owns scheduling. */
  store?: FileCredentialStore
  /** Test seam; production builds the platform backend from the pool path. */
  backend?: CredentialStore<PoolData<WorkBuddyPoolAccount>>
  maxAccounts?: number
  /**
   * The settings selection: the account the user pinned and the ones hidden.
   *
   * Read on every pick rather than captured once, because both change from the
   * settings card while the adapter is serving requests.
   */
  selection?: () => { selectedAccountId: string | null; hiddenAccountIds: readonly string[] }
}

/**
 * WorkBuddy's account pool.
 *
 * Desktop accounts are adopted into the pool so they can be scheduled and
 * cooled down like any other, but they stay owned by the IDE: the pool refreshes
 * their credential from the IDE's own file on every pick, and deletion is
 * refused for them.
 */
export class WorkBuddyAccountPool extends AccountPoolCore<
  WorkBuddyCredentials,
  WorkBuddyPoolAccount,
  WorkBuddyAccountSummaryDto
> {
  private readonly store: FileCredentialStore
  private readonly options_selection: WorkBuddyAccountPoolOptions['selection']
  /**
   * Older settings key → the id the account has now.
   *
   * A pin or a hide written before the identity fix names its account by the
   * old name-derived key. Kept in step by {@link read}, which every routing
   * decision goes through, so the mapping is never stale when it is consulted.
   */
  private readonly legacyIds = new Map<string, string>()

  constructor(options: WorkBuddyAccountPoolOptions = {}) {
    const store = options.store ?? new FileCredentialStore()
    const hooks: AccountPoolHooks<WorkBuddyCredentials, WorkBuddyPoolAccount, WorkBuddyAccountSummaryDto> = {
      providerId: PROVIDER_ID,
      displayName: PROVIDER_NAME,
      poolFile: workBuddyPoolPath(),
      keychainService: 'dsh-workbuddy-pool',
      parsePoolData: parseWorkBuddyPoolData,
      // Identity, never a token: the access token rotates on every refresh, so
      // keying on it would make the same account look new each time.
      dedupeKey: (credentials) => workBuddyAccountId(credentials),
      // The settings document already stores this exact key for the pinned and
      // hidden accounts, so the pool adopts it rather than minting its own id:
      // every id the card sends back is then addressable with no migration.
      accountId: (credentials) => workBuddyAccountId(credentials),
      defaultAlias: (credentials, position) => defaultAliasFor(credentials, position),
      createAccount: ({ id, alias, credentials, addedAt, isPrimary }) => ({
        id,
        alias,
        credentials,
        addedAt,
        isPrimary,
        region: credentials.region,
        source: credentials.source,
        ...(credentials.nickname === undefined ? {} : { nickname: credentials.nickname }),
        ...(credentials.uin === undefined ? {} : { uin: credentials.uin }),
        ...(credentials.sourceFile === '' ? {} : { sourceFile: credentials.sourceFile }),
      }),
      expiresAt: (credentials) => credentials.expiresAt,
      needsRefresh: (credentials, now) => isExpired(credentials, now),
      refresh: async (credentials, fetchFn) => {
        const refreshed = await refreshCredentials(credentials, { fetchFn })
        // A desktop credential belongs to the IDE, and the refresh token
        // rotates: the new pair has to reach the IDE's own file, or the IDE is
        // left holding a token this plugin already spent and gets signed out.
        if (refreshed.source === 'desktop') await store.writeBack(refreshed)
        return refreshed
      },
      // Only a rejected credential is that account's problem; a transient
      // refresh failure must not cost it its place in the pool.
      refreshFailureStatus: (error) => (
        error instanceof LlmError && error.code === 'INVALID_CREDENTIAL' ? 'expired' : undefined
      ),
      extendSummary: (account, base) => ({
        ...base,
        region: account.region ?? account.credentials.region,
        source: account.source,
        // The card offers Delete only for accounts this plugin owns; a desktop
        // account is hidden/restored instead, and its file is never touched.
        removable: account.source === 'managed',
        ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
        ...(account.uin === undefined ? {} : { uin: account.uin }),
        ...(account.sourceFile === undefined ? {} : { sourceFile: account.sourceFile }),
        // Identity facts the shared card shows per account, so WorkBuddy needs
        // no separate identity panel of its own.
        ...(account.credentials.domain === '' ? {} : { domain: account.credentials.domain }),
        ...(account.credentials.backend === '' ? {} : { backend: account.credentials.backend }),
        ...(account.credentials.accountType === undefined ? {} : { accountType: account.credentials.accountType }),
        ...(account.credentials.expiresAt > 0 ? {} : { expiresAt: undefined }),
      }),
      // The account the user pinned in settings outranks the rotation strategy.
      // A pin written before the identity fix names the account by its old
      // name-derived key, so it is matched against every key the account has
      // been addressable under rather than being silently ignored.
      preferAccountId: () => this.resolveSelectionId(options.selection?.().selectedAccountId ?? null),
      emptyMessage: `Not signed in to ${PROVIDER_NAME}. Sign in with the CodeBuddy desktop client, or add an account from Settings > WorkBuddy.`,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      ...(options.maxAccounts === undefined ? {} : { maxAccounts: options.maxAccounts }),
    }
    super(hooks)
    this.store = store
    this.options_selection = options.selection
  }

  /**
   * Read the pool, refreshing the legacy-key index on the way.
   *
   * Every routing decision goes through this method before it consults the
   * settings selection, so building the index here is what keeps a pin written
   * before the identity fix resolvable when {@link resolveSelectionId} is asked
   * for it.
   */
  override async read(): Promise<PoolData<WorkBuddyPoolAccount>> {
    const data = await super.read()
    this.legacyIds.clear()
    for (const account of data.accounts) {
      for (const alias of workBuddyAccountIdAliases(account.credentials)) {
        if (alias !== account.id) this.legacyIds.set(alias, account.id)
      }
    }
    return data
  }

  /** Map a settings key from before the identity fix onto the account's real id. */
  private resolveSelectionId(id: string | null): string | null {
    if (id === null) return null
    return this.legacyIds.get(id) ?? id
  }

  /**
   * Adopt any desktop credential the pool does not know yet.
   *
   * The IDE's directory is the source of truth for its own accounts, so a
   * credential that appears there joins the pool. Nothing is ever removed: a
   * file that disappears (the IDE signed out, a profile was moved) leaves the
   * account in place, where the user can hide or delete the managed ones.
   */
  async syncDesktopAccounts(): Promise<WorkBuddyAccountSummaryDto[]> {
    const discovered = await this.store.discoverDesktopCredentials()
    if (discovered.length > 0) {
      const data = await this.read()
      const known = new Set(data.accounts.map((account) => workBuddyAccountId(account.credentials)))
      // The auth directory keeps historical snapshots of the same account, so
      // the scan is collapsed by identity first: adopting each snapshot would
      // re-write the same row through encrypted storage several times over.
      const seen = new Set<string>()
      for (const credentials of discovered) {
        const id = workBuddyAccountId(credentials)
        if (known.has(id) || seen.has(id)) continue
        seen.add(id)
        await this.addAccount({ ...credentials, source: 'desktop' })
      }
    }
    return this.listAccounts()
  }

  /**
   * Pick the account for the next request.
   *
   * A desktop account's credential is re-read from the IDE's file first: the IDE
   * refreshes its own token, so the copy the pool adopted can be older than what
   * is on disk.
   */
  async getEffectiveCredential(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
  ): Promise<{ account: WorkBuddyPoolAccount; credentials: WorkBuddyCredentials }> {
    const effective = await this.getEffectiveAccount(excludeIds, fetchFn)
    if (effective.account.source !== 'desktop' || effective.account.sourceFile === undefined) {
      return effective
    }
    const live = await this.store.readDesktopFile(effective.account.sourceFile)
    if (live === null) return effective
    // The IDE refreshes its own token on its own schedule, so a file holding a
    // usable token is the newer authority. A file whose token is already stale
    // is not: getEffectiveAccount refreshed through the hook above, which wrote
    // the new pair back, so that path must NOT refresh a second time here — the
    // refresh token rotates and a second exchange would invalidate the first.
    if (isExpired(live)) return effective
    if (live.accessToken !== effective.credentials.accessToken) {
      await this.updateAccountCredentials(effective.account.id, live).catch(() => undefined)
    }
    return { account: effective.account, credentials: live }
  }

  /**
   * Whether an account may serve a request.
   *
   * A hidden account keeps its place, its alias and its history, but the user
   * has taken it out of this plugin's rotation, so it is not eligible.
   */
  protected override isEligible(
    account: WorkBuddyPoolAccount,
    now: number,
    triedAccountIds?: ReadonlySet<string>,
  ): boolean {
    // Matched through every key the account has been addressable under: a
    // settings document written before the identity fix hid this account by the
    // name-derived key, and comparing only the current id would let a hidden
    // account quietly rejoin the rotation.
    const hidden = this.selection().hiddenAccountIds
    if (workBuddyAccountIdAliases(account.credentials).some((id) => hidden.includes(id))) return false
    return super.isEligible(account, now, triedAccountIds)
  }

  private selection(): { selectedAccountId: string | null; hiddenAccountIds: readonly string[] } {
    return this.options_selection?.() ?? { selectedAccountId: null, hiddenAccountIds: [] }
  }

  /**
   * Add or re-authorize one account, settling its identity first.
   *
   * A completed browser sign-in states the display name but not always the uid,
   * while the IDE's own file for the same account states the uid. Passing the
   * raw response through would key the login under the name and the file under
   * the uid, so the pool would hold the same account twice — the duplicate this
   * fix exists to remove. Resolving from the credential's own token before the
   * dedupe key is computed is what makes the two paths agree.
   */
  override async addAccount(credentials: WorkBuddyCredentials, alias?: string): Promise<WorkBuddyPoolAccount> {
    return super.addAccount(withResolvedIdentity(credentials), alias)
  }

  /**
   * Delete one account.
   *
   * A desktop account is refused: the plugin does not own that credential file,
   * so removing it from the pool would strand the IDE's session while telling
   * the user their account was deleted. Hiding is the supported action there.
   */
  override async deleteAccount(accountId: string): Promise<void> {
    const data = await this.read()
    if (data.accounts.find((account) => account.id === accountId)?.source === 'desktop') {
      throw new Error('桌面账号由 CodeBuddy 客户端所有，只能隐藏，不能删除。')
    }
    await super.deleteAccount(accountId)
  }
}