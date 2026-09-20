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
   * Whether the card may offer to delete this account.
   *
   * Absent means deletable, which is what every account this plugin signed in
   * is. A provider that adopts accounts it does not own sets this to false so
   * the card offers its own action instead of destroying someone else's file.
   */
  removable?: boolean
}

/** The pool slice every provider status DTO carries. */
export interface AccountPoolStatusDto {
  accounts: PoolAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountRotationStrategy
}
