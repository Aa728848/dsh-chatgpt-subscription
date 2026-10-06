/**
 * Shared wire contracts for the multi-account pools every provider line uses.
 *
 * Everything here is public: no credential ever crosses this boundary, only the
 * non-secret facts a settings card needs to render an account list.
 */

/**
 * How the pool picks the account for the next request.
 *
 * - `sequential` — drain the primary account first, fail over when it cools down.
 * - `round-robin` — spread requests over eligible accounts, least recently used first.
 * - `sticky` — keep the account that served the previous request while it stays eligible.
 */
export type AccountRotationStrategy = 'sequential' | 'round-robin' | 'sticky'

/**
 * Permanent routing state of one pooled account.
 *
 * `expired` / `invalid` mean the stored credential can no longer authenticate and
 * the account must be signed in again. The account is kept, not deleted, because
 * signing into it again is what restores it.
 */
export type AccountAuthStatus = 'ok' | 'expired' | 'invalid'

/** One account as the settings card renders it. Never carries a secret. */
export interface PoolAccountSummaryDto {
  id: string
  alias: string
  isPrimary: boolean
  email?: string
  planLabel?: string
  /** Unix milliseconds the account last served a request. */
  lastUsedAt?: number
  /** Unix milliseconds a 429 cooldown lifts; absent when the account is eligible. */
  cooldownUntil?: number
  cooldownReason?: string
  /** Permanent auth state; `ok` or absent means routable. */
  authStatus?: AccountAuthStatus
  authFailedReason?: string
  /** Unix milliseconds the stored access token expires, when the provider has one. */
  expiresAt?: number
  /**
   * The newest quota snapshot the host already holds for THIS account.
   *
   * Quota follows the account, not the line: a rotation moves which account
   * spends the next request, so a single line-level quota figure describes
   * whichever account happened to be active when it was read. Every line
   * remembers the snapshot it read per account identity and reports it here, so
   * the account card can draw each account's own progress.
   *
   * Absent means nothing was ever read for this account — which is a different
   * statement from "nothing used", and the reason this field is optional rather
   * than an empty snapshot. Reading quota for every pooled account when the
   * settings page opens would cost one upstream request per account; nothing
   * here triggers a read.
   */
  quota?: PoolAccountQuotaDto
  /**
   * Whether the card may offer to delete this account.
   *
   * Absent means deletable, which is what every account this plugin signed in
   * is. A provider that adopts accounts it does not own sets this to false so
   * the card offers its own action instead of destroying someone else's file.
   */
  removable?: boolean
}

/**
 * One quota window, normalized so every line's account row draws the same bar.
 *
 * The lines disagree about the wire (buckets, groups, meters, ISO strings,
 * unix seconds, remaining fractions); they agree about this: a window has a
 * name, a consumed share, and usually a moment it reopens.
 */
export interface PoolAccountQuotaWindowDto {
  /** Display label the line already has, e.g. `5 小时` / `Weekly (7 days)`. */
  label: string
  /** Share of the window consumed, 0-100. */
  usedPercent: number
  /** Nominal window length in minutes, when the source stated one. */
  windowDurationMins?: number | null
  /** Unix milliseconds the window reopens, when the source stated one. */
  resetsAt?: number | null
}

/** The newest quota snapshot one line holds for one account. */
export interface PoolAccountQuotaDto {
  /**
   * Windows in the order the line's own card lists them, unlabeled ones
   * included: no code sorts this list, and the lines that know a window's length
   * happen to state the shortest first.
   */
  windows: PoolAccountQuotaWindowDto[]
  /** Unix milliseconds this snapshot was read, never when it was served. */
  fetchedAt: number
}

/** The pool slice every provider status DTO carries. */
export interface AccountPoolStatusDto {
  accounts: PoolAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
}
