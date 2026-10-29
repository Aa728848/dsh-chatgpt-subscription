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
import { refreshCredentials, getCachedQuotaFor } from './client.ts'
import { poolQuota, quotaWindow } from '../common/account-quota.ts'
import { hasStableIdentity, withResolvedIdentity } from './identity.ts'
import { PROVIDER_ID, PROVIDER_NAME, regionForDomain } from './types.ts'
import type { PoolAccountQuotaDto } from '../../shared/account-pool-contracts.ts'
import {
  WORKBUDDY_RESTRICTED_ACCOUNT_CODE,
  type WorkBuddyAccountQuota,
  type WorkBuddyAccountRestrictionDto,
  type WorkBuddyAccountSummaryDto,
  type WorkBuddyMeter,
  type WorkBuddyModelCooldownDto,
  type WorkBuddyPoolStateDto,
  type WorkBuddyRegion,
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

/**
 * Error code the adapter routes on when the WHOLE pool is paused.
 *
 * Deliberately not `RATE_LIMIT`: a pause says the pool will not be served at
 * all — the upstream barred accounts, it did not answer 429 for one request —
 * and confusing the two would send the user to wait out a window that has
 * nothing to do with their accounts. The pause lifts by itself and the RESTRICTED
 * accounts do not, so the remedy is also different.
 */
export const WORKBUDDY_POOL_PAUSED_CODE = 'WORKBUDDY_POOL_PAUSED' as const

/**
 * Thrown instead of selecting an account while the whole pool is paused.
 *
 * Exported so the protocol worker's caller can tell "upstream barred two
 * accounts" (wait for the pause, then sign the restricted ones in again) from
 * "this request was rate limited". It is never reported as an upstream 429.
 */
export class WorkBuddyPoolPausedError extends LlmError {
  /** Unix milliseconds the pause lifts on its own; absent when nothing named one. */
  readonly pausedUntil: number | undefined

  constructor(message: string, pausedUntil?: number) {
    super(message, WORKBUDDY_POOL_PAUSED_CODE)
    this.name = 'WorkBuddyPoolPausedError'
    this.pausedUntil = pausedUntil
  }
}

/**
 * How long a second barred account stops the whole pool.
 *
 * Thirty minutes is the confirmed Wave 2A policy: long enough that an upstream
 * refusing every account is not hammered once per turn, short enough that a
 * transient bar does not take the line offline for a working day. When it
 * passes the pool resumes by itself — the restricted accounts do not, because
 * nothing upstream said they may serve again.
 */
export const WORKBUDDY_POOL_PAUSE_MS = 30 * 60 * 1000

/**
 * Window in which a second, DIFFERENT barred account stops the whole pool.
 *
 * Measured from each refusal to the next. One barred account is that account's
 * problem and the rest still serve; two different accounts barred inside this
 * window is the pool's problem, because the same thing is about to happen to
 * the third.
 */
export const WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS = 30 * 60 * 1000

/** One account's `11140` as this pool's own document keeps it. */
export interface WorkBuddyPoolRestrictionRecord {
  /** Gateway code; {@link WORKBUDDY_RESTRICTED_ACCOUNT_CODE} is the only one recorded. */
  code: number
  /** Upstream `msg` when one came with the code. Never a credential. */
  message?: string
  /** Instant the gateway named, when it named one. Reported, never enforced. */
  until?: number
  /** When this pool observed the refusal; drives the escalation window. */
  observedAt: number
}

/** A pause of the WHOLE pool, as its own document keeps it. */
export interface WorkBuddyPoolPauseRecord {
  /** Composed sentence for the card; never a token. */
  reason: string
  pausedSince: number
  /** Unix milliseconds the pause lifts by itself. */
  pausedUntil: number
  /** Account ids whose `11140` caused the pause, in observation order. */
  triggeredBy: string[]
}

/** Whole-pool state kept inside the pool document. */
export interface WorkBuddyPoolDocumentState {
  /** Account id → its `11140`. A restricted account is out of rotation. */
  restrictions: Record<string, WorkBuddyPoolRestrictionRecord>
  pause?: WorkBuddyPoolPauseRecord
}

/**
 * This line's pool document: the shared shape plus the pool-wide state.
 *
 * The state lives in the SAME document rather than a second store, so one
 * encrypted write keeps "which account may serve" and "may the pool serve at
 * all" in step: two documents could be observed half-updated, and the pool
 * would then select an account its own restriction record bars.
 */
export interface WorkBuddyPoolData extends PoolData<WorkBuddyPoolAccount> {
  pool?: WorkBuddyPoolDocumentState
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('WorkBuddy pool account field is invalid')
  return value
}

/**
 * Read whole-pool state out of a stored document.
 *
 * Absent means "no pool-wide state", which is exactly what a document written
 * before Wave 2A holds — and what an untouched pool still writes, so an install
 * that never met `11140` carries no extra keys at all. A malformed ENTRY is
 * dropped rather than failing the document: losing one memory of a refusal must
 * not make the accounts unreadable, while silently keeping an unparseable pause
 * could take the line offline forever.
 */
export function parseWorkBuddyPoolState(value: unknown): WorkBuddyPoolDocumentState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const restrictions: Record<string, WorkBuddyPoolRestrictionRecord> = {}
  if (typeof raw.restrictions === 'object' && raw.restrictions !== null && !Array.isArray(raw.restrictions)) {
    for (const [accountId, entry] of Object.entries(raw.restrictions as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (typeof record.code !== 'number' || !Number.isFinite(record.code)) continue
      if (typeof record.observedAt !== 'number' || !Number.isFinite(record.observedAt)) continue
      restrictions[accountId] = {
        code: record.code,
        observedAt: record.observedAt,
        ...(typeof record.message === 'string' ? { message: record.message } : {}),
        ...(typeof record.until === 'number' && Number.isFinite(record.until) ? { until: record.until } : {}),
      }
    }
  }
  let pause: WorkBuddyPoolPauseRecord | undefined
  if (typeof raw.pause === 'object' && raw.pause !== null && !Array.isArray(raw.pause)) {
    const record = raw.pause as Record<string, unknown>
    if (typeof record.pausedSince === 'number' && Number.isFinite(record.pausedSince)
      && typeof record.pausedUntil === 'number' && Number.isFinite(record.pausedUntil)) {
      pause = {
        reason: typeof record.reason === 'string' ? record.reason : '号池已暂停。',
        pausedSince: record.pausedSince,
        pausedUntil: record.pausedUntil,
        triggeredBy: Array.isArray(record.triggeredBy)
          ? record.triggeredBy.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }
  }
  if (Object.keys(restrictions).length === 0 && pause === undefined) return undefined
  return { restrictions, ...(pause === undefined ? {} : { pause }) }
}

/**
 * Validate and normalize one whole pool document.
 *
 * A record whose credential is unusable is dropped rather than repaired: the
 * account can always be adopted again from its file or by signing in again, and
 * keeping a credential-less row would offer the user an account nothing can use.
 */
export function parseWorkBuddyPoolData(value: unknown): WorkBuddyPoolData {
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

  const result: WorkBuddyPoolData = {
    version: 1,
    rotationStrategy: normalizeRotationStrategy(record.rotationStrategy),
    accounts: [...collapsed.values()],
  }
  // A stored pointer names the row's old id; it has to follow the heal or the
  // settings document would address an account the pool no longer has.
  if (typeof record.activeAccountId === 'string') {
    result.activeAccountId = heal.get(record.activeAccountId) ?? record.activeAccountId
  }
  // The pool-wide state is carried through the SAME normalization every write
  // runs, so a restriction or a pause can never be dropped by a save that
  // rebuilt the document: it would silently unbar the account.
  const pool = parseWorkBuddyPoolState(record.pool)
  if (pool !== undefined) result.pool = pool
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

/**
 * A meter's consumed share, from whichever fraction this line measured.
 *
 * `usedFraction` is the DTO's own "share consumed"; `remainingFraction` is the
 * same statement read from the other end, and is the one the rest of the card
 * renders. A meter that states neither is dropped (null) rather than drawn at
 * 0, which would claim a full window no reading supports.
 */
function meterUsedPercent(meter: WorkBuddyMeter): number | null {
  if (typeof meter.usedFraction === 'number' && Number.isFinite(meter.usedFraction)) return meter.usedFraction * 100
  if (typeof meter.remainingFraction === 'number' && Number.isFinite(meter.remainingFraction)) {
    return (1 - meter.remainingFraction) * 100
  }
  return null
}

/**
 * One cached snapshot as the shared account card renders it.
 *
 * Only what the DTO states is published: every meter that measured a share
 * becomes a window, and a meter that measured none is dropped rather than drawn
 * at 0 — which would claim an unspent allowance no reading supports.
 *
 * Exported for the pool's regression tests; the card only reaches it through
 * the summary hook.
 */
export function workBuddyPoolQuota(snapshot: WorkBuddyAccountQuota): PoolAccountQuotaDto | undefined {
  const windows = snapshot.meters.map((meter) => quotaWindow(
    meter.label,
    meterUsedPercent(meter),
    { resetsAt: meter.resetsAt },
  ))
  // The cycle counters are the one allowance the meters may not carry: the
  // line surfaces the cycle as its own `cycle` meter when it is usable, so it
  // is published here only when no meter states it — otherwise the same
  // allowance would draw two bars under two names.
  const cycleStated = snapshot.meters.some((meter) => meter.id === 'cycle')
  if (!cycleStated
    && snapshot.cycleCredits !== null
    && snapshot.cycleCredits > 0
    && snapshot.cycleUsedCredits !== null) {
    windows.push(quotaWindow(
      snapshot.packageName ?? 'Billing cycle',
      (snapshot.cycleUsedCredits / snapshot.cycleCredits) * 100,
      { resetsAt: snapshot.cycleEndsAt },
    ))
  }
  return poolQuota(snapshot.fetchedAt, windows)
}

/**
 * This account's own newest snapshot, ready for the account card.
 *
 * Quota follows the account, so the pool reports the snapshot the line already
 * remembered for THIS account id. The lookup is a pure memory read: the card
 * builds its account list here, and that must never cost one upstream request
 * per pooled account. Undefined means exactly that — never read — which is not
 * the same statement as "nothing used".
 */
function quotaFor(accountId: string): PoolAccountQuotaDto | undefined {
  const snapshot = getCachedQuotaFor(accountId)
  return snapshot === undefined ? undefined : workBuddyPoolQuota(snapshot)
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
  /**
   * Per-model parks, in memory only: account id → model → the instant it lifts.
   *
   * The subscription meters an account × MODEL over a 24h window (429 `code
   * 6004` names when it lifts), so cooling the whole ACCOUNT for one exhausted
   * model throws away every other model that account can still serve. Process
   * local on purpose, like the sibling gateway's model cooldowns: the window is
   * short, and a restart re-measures it with the first request rather than
   * trusting a stale timestamp.
   */
  private readonly modelCooldowns = new Map<string, Map<string, number>>()
  /**
   * Whole-pool state as of the LAST load through {@link loadPoolData}.
   *
   * A cache rather than a read per check: eligibility runs once per account per
   * pick, and asking the encrypted store each time would pay a DPAPI unprotect
   * per candidate. Every read and every mutation loads the document first, so
   * this cannot be stale for longer than one storage round trip.
   */
  private restrictions: Record<string, WorkBuddyPoolRestrictionRecord> = {}
  private pause: WorkBuddyPoolPauseRecord | undefined

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
      extendSummary: (account, base, now) => ({
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
        // This account's own newest snapshot, when it was read before. Absent
        // means exactly that: never read — which is not "nothing used".
        ...(() => {
          const quota = quotaFor(account.id)
          return quota === undefined ? {} : { quota }
        })(),
        // The models this account is parked on, with the instant each park
        // lifts. The account itself stays eligible, so a card that drew only
        // the account cooldown would report it as available while the model
        // the request wants is the one that is refused.
        ...(() => {
          const modelCooldowns = this.liveModelCooldowns(account.id, now)
          return modelCooldowns.length === 0 ? {} : { modelCooldowns }
        })(),
        // The account-scale refusal, so the card can explain why an otherwise
        // healthy-looking account is not being routed to. Reported through the
        // line's own DTO extension: the shared summary knows nothing of a
        // gateway code.
        ...(() => {
          const record = this.restrictionFor(account)
          if (record === undefined) return {}
          return {
            restriction: {
              code: record.code,
              ...(record.message === undefined ? {} : { message: record.message }),
              ...(record.until === undefined ? {} : { until: record.until }),
            } satisfies WorkBuddyAccountRestrictionDto,
          }
        })(),
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
   * Load the pool, refreshing the legacy-key index on the way.
   *
   * Every routing decision and mutation goes through this method before it
   * consults the settings selection, so building the index here is what keeps
   * a pin written before the identity fix resolvable when
   * {@link resolveSelectionId} is asked for it.
   */
  protected override async loadPoolData(): Promise<PoolData<WorkBuddyPoolAccount>> {
    const data = await super.loadPoolData()
    this.legacyIds.clear()
    for (const account of data.accounts) {
      for (const alias of workBuddyAccountIdAliases(account.credentials)) {
        if (alias !== account.id) this.legacyIds.set(alias, account.id)
      }
    }
    this.observePoolState(data)
    return data
  }

  /** Keep the pool-wide cache in step with the document just loaded. */
  private observePoolState(data: PoolData<WorkBuddyPoolAccount>): void {
    const pool = (data as WorkBuddyPoolData).pool
    this.restrictions = pool?.restrictions ?? {}
    this.pause = pool?.pause
  }

  /** This account's live `11140`, matched through every key it answers to. */
  private restrictionFor(account: WorkBuddyPoolAccount): WorkBuddyPoolRestrictionRecord | undefined {
    for (const id of workBuddyAccountIdAliases(account.credentials)) {
      const record = this.restrictions[id]
      if (record !== undefined) return record
    }
    return this.restrictions[account.id]
  }

  /** The pause that is still running, or undefined when it lifted or never began. */
  private activePause(now = Date.now()): WorkBuddyPoolPauseRecord | undefined {
    const pause = this.pause
    return pause !== undefined && pause.pausedUntil > now ? pause : undefined
  }

  /** The error every selection raises while the pool is paused. */
  private pausedError(pause: WorkBuddyPoolPauseRecord, now = Date.now()): WorkBuddyPoolPausedError {
    const minutes = Math.max(1, Math.ceil((pause.pausedUntil - now) / 60_000))
    return new WorkBuddyPoolPausedError(
      `${PROVIDER_NAME} 号池已暂停：${pause.reason} 预计 ${minutes} 分钟后自动恢复；被上游限制的账号需要重新登录后才能回到轮换。`,
      pause.pausedUntil,
    )
  }

  /**
   * Record an account-scoped refusal reported by the protocol worker.
   *
   * This is the ONE entry point for `11140`, and the policy it implements is
   * the confirmed Wave 2A one:
   *
   * - the first barred account leaves rotation immediately and its restriction
   *   is PERSISTED (in the pool document, so a second pool instance over the
   *   same store sees it), while every other account keeps serving;
   * - a SECOND, different account barred within
   *   {@link WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS} pauses the whole pool
   *   for {@link WORKBUDDY_POOL_PAUSE_MS} — during which no account is selected
   *   at all — and that pause is persisted too;
   * - the pause lifts by itself, the restricted accounts do NOT: only a
   *   completed sign-in ({@link addAccount}) puts one back in rotation.
   *
   * Only {@link WORKBUDDY_RESTRICTED_ACCOUNT_CODE} is accepted. `11128` is the
   * channel/request-shape block and `11158` is one model an account has no
   * entitlement for; neither says the ACCOUNT may not serve, so recording either
   * would take a working account out of rotation and — with two inside the
   * window — stop the whole pool over a request-shape mistake. The call is
   * therefore refused loudly, which keeps that misrouting visible in a test or a
   * log instead of silently barring a healthy account.
   */
  async markAccountRestriction(accountId: string, restriction: WorkBuddyAccountRestrictionDto): Promise<void> {
    if (restriction.code !== WORKBUDDY_RESTRICTED_ACCOUNT_CODE) {
      throw new Error(
        `${PROVIDER_NAME} 号池只记录账号级限制（${WORKBUDDY_RESTRICTED_ACCOUNT_CODE}），收到业务码 ${restriction.code}；`
        + '11128 与 11158 不是账号级拒绝，必须由协议层分别处理。',
      )
    }
    const now = Date.now()
    const record: WorkBuddyPoolRestrictionRecord = {
      code: restriction.code,
      observedAt: now,
      ...(restriction.message === undefined ? {} : { message: restriction.message }),
      ...(restriction.until === undefined ? {} : { until: restriction.until }),
    }
    await this.updatePool((data) => {
      const document = data as WorkBuddyPoolData
      const state = document.pool ?? (document.pool = { restrictions: {} })
      // Counted BEFORE this account's own record is written: escalation is
      // about a SECOND, DIFFERENT account, so the one being recorded now must
      // never be its own trigger.
      const others = Object.entries(state.restrictions).filter(([id, entry]) => (
        id !== accountId && now - entry.observedAt <= WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS
      ))
      state.restrictions[accountId] = record
      // A RUNNING pause keeps its own clock: extending it on every further
      // refusal would turn a burst into an outage nobody can wait out.
      const running = state.pause !== undefined && state.pause.pausedUntil > now
      if (!running) {
        if (others.length > 0) {
          const windowMinutes = Math.round(WORKBUDDY_RESTRICTION_ESCALATION_WINDOW_MS / 60_000)
          state.pause = {
            reason: `上游以 ${restriction.code} 在 ${windowMinutes} 分钟内拒绝了 ${others.length + 1} 个不同账号`,
            pausedSince: now,
            pausedUntil: now + WORKBUDDY_POOL_PAUSE_MS,
            triggeredBy: Object.keys(state.restrictions),
          }
        } else if (state.pause !== undefined) {
          // An expired pause is dropped rather than carried forward: it is a
          // state no reading may report once its window has passed.
          delete state.pause
        }
      }
      // Written before the storage round trip on purpose. A failed write leaves
      // the cache saying "paused", which refuses requests — the closed
      // direction — and the next load replaces it with what is on disk.
      this.restrictions = state.restrictions
      this.pause = state.pause
    })
  }

  /** Clear one account's restriction; a completed sign-in is what does this. */
  private clearRestriction(accountId: string): Promise<void> {
    return this.updatePool((data) => {
      const state = (data as WorkBuddyPoolData).pool
      if (state === undefined || state.restrictions[accountId] === undefined) return
      delete state.restrictions[accountId]
      this.restrictions = state.restrictions
    })
  }

  /**
   * Whole-pool state for the wire: whether the pool is paused, why, until when,
   * which accounts are barred, and where this document lives.
   *
   * `pausedUntil` is the pause's remaining time in absolute form, which is what
   * a card can count down and a route can answer without a second call. An
   * expired pause is reported as not paused — it never needs a write to lift.
   */
  async poolState(): Promise<WorkBuddyPoolStateDto> {
    await this.read()
    const now = Date.now()
    const pause = this.activePause(now)
    const storage = await this.poolStorage()
    return {
      paused: pause !== undefined,
      ...(pause === undefined
        ? {}
        : { pauseReason: pause.reason, pausedSince: pause.pausedSince, pausedUntil: pause.pausedUntil }),
      restrictedAccountIds: Object.keys(this.restrictions),
      ...(storage === undefined ? {} : { storage }),
    }
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
    const candidates: WorkBuddyCredentials[] = []
    const seen = new Set<string>()
    for (const raw of discovered) {
      const credentials = withResolvedIdentity({ ...raw, source: 'desktop' })
      const id = workBuddyAccountId(credentials)
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push(credentials)
    }

    if (candidates.length > 0) {
      await this.updatePool((data) => {
        const existingKeys = new Set<string>()
        for (const account of data.accounts) {
          existingKeys.add(account.id)
          const key = this.hooks.dedupeKey?.(account.credentials)
          if (key !== undefined) existingKeys.add(key)
        }
        for (const credentials of candidates) {
          const key = this.hooks.dedupeKey?.(credentials)
          const id = this.hooks.accountId?.(credentials)
          if ((key !== undefined && existingKeys.has(key)) || (id !== undefined && existingKeys.has(id))) {
            continue
          }
          this.addAccountToPool(data, credentials)
          if (key !== undefined) existingKeys.add(key)
          if (id !== undefined) existingKeys.add(id)
        }
      })
    }
    return this.listAccounts()
  }

  /**
   * A stale `authStatus` is cleared once the credential in force has moved on.
   *
   * The marker records that ONE token was refused; it does not record that the
   * sign-in is gone. This line can still produce it from a token-endpoint
   * refusal, and the copy that refusal was about can be replaced afterwards by
   * whoever owns it — the IDE rotates a desktop account's token on its own
   * schedule, and the daily check-in renews a managed one and writes it back to
   * this plugin's store. Nothing else in the system ever revisits an
   * `authStatus`, so without this a row stays out of rotation for good and the
   * card keeps saying "需要重新登录" for an account that is signed in.
   *
   * The verdict is re-checked against what the store holds NOW: a row whose
   * account has a DIFFERENT, unexpired token is routable again and adopts it,
   * while a row still holding the refused token keeps its marker — that one
   * really does need a sign-in.
   */
  private async healStaleAuthFailures(current?: PoolData<WorkBuddyPoolAccount>): Promise<boolean> {
    const data = current ?? await this.read()
    if (!data.accounts.some(isMarkedFailed)) return false
    // The scan is file I/O and the pool transaction must not do any, so the
    // authoritative copy is read before the lock is taken.
    const live = await this.store.list().catch(() => [])
    if (live.length === 0) return false
    const byId = new Map<string, WorkBuddyCredentials>()
    for (const credentials of live) byId.set(workBuddyAccountId(credentials), credentials)
    return await this.updatePool((draft) => {
      let changed = false
      for (const account of draft.accounts) {
        if (!isMarkedFailed(account)) continue
        const candidate = byId.get(account.id)
        if (candidate === undefined) continue
        // The same token in force means nothing has moved: the refusal still
        // describes the credential this row holds.
        if (candidate.accessToken === account.credentials.accessToken) continue
        if (isExpired(candidate)) continue
        account.authStatus = undefined
        account.authFailedReason = undefined
        account.credentials = candidate
        changed = true
      }
      return changed
    })
  }

  /** Account summaries, with a marker the credentials have outlived cleared. */
  override async listAccounts(): Promise<WorkBuddyAccountSummaryDto[]> {
    const summaries = await super.listAccounts()
    if (!summaries.some(isMarkedFailed)) return summaries
    await this.healStaleAuthFailures().catch(() => undefined)
    return await super.listAccounts()
  }

  /**
   * Pick an account, healing a stale marker first.
   *
   * The healing belongs on the request path, not only on the card: an account
   * marked expired is excluded by the core's eligibility rule, so until the
   * marker is gone the next request is answered with "全部 N 个账号都需要重新登录"
   * for a credential the store has already replaced.
   */
  override async getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn: typeof fetch = fetch,
    forceRefresh = false,
  ): Promise<{ account: WorkBuddyPoolAccount; credentials: WorkBuddyCredentials }> {
    const data = await this.read()
    // Checked before the heal and before any candidate is considered: while the
    // pool is paused NOTHING may be selected, so this is a refusal rather than
    // an exclusion that would let the caller rotate elsewhere.
    const pause = this.activePause()
    if (pause !== undefined) throw this.pausedError(pause)
    if (data.accounts.some(isMarkedFailed)) {
      await this.healStaleAuthFailures(data).catch(() => undefined)
    }
    return await super.getEffectiveAccount(excludeIds, fetchFn, forceRefresh)
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
    model?: string,
  ): Promise<{ account: WorkBuddyPoolAccount; credentials: WorkBuddyCredentials }> {
    // A model park is an exclusion for THIS request only: the account stays in
    // rotation for every other model, which is what makes the park worth having.
    const parked = model === undefined ? new Set<string>() : this.parkedAccountIds(model)
    const effective = await this.getEffectiveAccount(
      parked.size === 0 ? excludeIds : new Set<string>([...(excludeIds ?? []), ...parked]),
      fetchFn,
    )
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
      const updated = await this.updateAccountCredentials(
        effective.account.id,
        live,
        effective.credentials,
      ).catch(() => undefined)
      if (updated) {
        return { account: updated, credentials: updated.credentials }
      }
    }
    return { account: effective.account, credentials: live }
  }

  /**
   * Park ONE model on one account; every other model keeps serving.
   *
   * Returns the instant the park lifts, or undefined for a non-positive
   * duration (which clears any existing park rather than extending it).
   */
  markModelCooldown(accountId: string, model: string, durationMs: number): number | undefined {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      this.modelCooldowns.get(accountId)?.delete(model)
      return undefined
    }
    const until = Date.now() + durationMs
    const forAccount = this.modelCooldowns.get(accountId) ?? new Map<string, number>()
    forAccount.set(model, until)
    this.modelCooldowns.set(accountId, forAccount)
    return until
  }

  /** When this account's park on this model lifts, or undefined when it may serve. */
  modelCooldownUntil(accountId: string, model: string, now = Date.now()): number | undefined {
    const until = this.modelCooldowns.get(accountId)?.get(model)
    return until !== undefined && until > now ? until : undefined
  }

  /**
   * The models this account is parked on right now, with the instant each park
   * lifts.
   *
   * Only LIVE parks are reported: a window that has passed is dropped here, so
   * the card never shows a model that may already serve. The lift instant is
   * the one the upstream named, stored verbatim by
   * {@link markModelCooldown}; it is never recomputed from a duration that has
   * since drifted, because a re-derived instant would drift with it.
   */
  private liveModelCooldowns(accountId: string, now: number): WorkBuddyModelCooldownDto[] {
    const models = this.modelCooldowns.get(accountId)
    if (models === undefined) return []
    const live: WorkBuddyModelCooldownDto[] = []
    for (const [model, until] of models) {
      if (until > now) live.push({ model, cooldownUntil: until })
      // A window that has passed is not a park any more. Keeping it would grow
      // this map for every model the account ever exhausted.
      else models.delete(model)
    }
    if (models.size === 0) this.modelCooldowns.delete(accountId)
    return live
  }

  /**
   * Clear one account's cooldown AND the models it is parked on.
   *
   * The card's "reset cooldown" button promises the account is usable again. A
   * model park is a cooldown too — the account stays eligible, but it still
   * refuses the model the request wants — so leaving the park behind would
   * report a reset that did not happen, and the park would outlive the only
   * control the user has over it.
   *
   * The base write comes first: it is the half that can fail, and a failed
   * write must leave the account's state as it was rather than half-cleared.
   */
  override async clearCooldown(accountId: string): Promise<void> {
    await super.clearCooldown(accountId)
    this.modelCooldowns.delete(accountId)
  }

  /** Accounts currently parked on one model, with lifted entries pruned on the way. */
  private parkedAccountIds(model: string, now = Date.now()): ReadonlySet<string> {
    const parked = new Set<string>()
    for (const [accountId, models] of this.modelCooldowns) {
      const until = models.get(model)
      if (until === undefined) continue
      if (until > now) parked.add(accountId)
      else models.delete(model)
    }
    return parked
  }

  /**
   * Whether another account besides `triedAccountIds` can serve THIS model.
   *
   * The plain {@link hasAnotherAvailableAccount} answers for any model, so a
   * rotation loop that consulted it would keep trying while every remaining
   * account is parked on the model it is asking for — turning one exhausted
   * window into a burst of refused requests.
   */
  async hasAnotherAvailableAccountFor(triedAccountIds: ReadonlySet<string>, model: string): Promise<boolean> {
    // The pause is decided first: a paused pool has nothing another account can
    // take over, and answering "yes" would send a rotation loop straight back
    // into a refusal.
    if (this.activePause() !== undefined) return false
    const parked = this.parkedAccountIds(model)
    if (parked.size === 0) return this.hasAnotherAvailableAccount(triedAccountIds)
    return this.hasAnotherAvailableAccount(new Set<string>([...triedAccountIds, ...parked]))
  }

  /**
   * Whether another account may serve right now.
   *
   * Answered from ONE read that also carries the pool-wide state, and false
   * while the pool is paused: the rotation loop consults this before retrying,
   * so a pause has to end the loop there rather than after another selection it
   * would only refuse.
   */
  override async hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean> {
    const data = await this.read()
    if (this.activePause() !== undefined) return false
    const now = Date.now()
    return data.accounts.some((account) => this.isEligible(account, now, triedAccountIds))
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
    // An account the gateway barred is out of rotation until a sign-in restores
    // it. Matched through every key it answers to, like the hidden set above, so
    // a restriction recorded before an identity heal still applies.
    if (this.restrictionFor(account) !== undefined) return false
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
    const account = await super.addAccount(withResolvedIdentity(credentials), alias)
    // A completed sign-in is the ONLY thing that puts a barred account back into
    // rotation: nothing upstream said it may serve again, and a rescan of the
    // IDE's files must not quietly restore it either — which is why this clear
    // lives here and not in addAccountToPool, where desktop adoption goes.
    await this.clearRestriction(account.id).catch(() => undefined)
    return account
  }

  /**
   * Remove one account inside a transaction.
   *
   * A desktop account is refused: the plugin does not own that credential file,
   * so removing it from the pool would strand the IDE's session while telling
   * the user their account was deleted. Hiding is the supported action there.
   */
  protected override deleteAccountFromPool(data: PoolData<WorkBuddyPoolAccount>, accountId: string): void {
    if (data.accounts.find((account) => account.id === accountId)?.source === 'desktop') {
      throw new Error('桌面账号由 CodeBuddy 客户端所有，只能隐藏，不能删除。')
    }
    super.deleteAccountFromPool(data, accountId)
  }
}

/**
 * Whether a row's credential was reported as refused and never cleared.
 *
 * Mirrors the core's own eligibility predicate (`authStatus` present and not
 * `ok`), so the heal agrees with the rule that excluded the row.
 */
function isMarkedFailed(account: { authStatus?: string }): boolean {
  return account.authStatus !== undefined && account.authStatus !== 'ok'
}
