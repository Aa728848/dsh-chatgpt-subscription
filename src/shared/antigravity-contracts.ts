export interface AntigravityModelBucket {
  bucketId: string
  displayName: string
  window?: string
  resetTime?: string
  description?: string
  /**
   * Share of this allowance still available, 0-1, or `null` when the service
   * stated no usable number for it.
   *
   * `null` is NOT zero. Zero is a real measurement meaning "nothing left", while
   * an absent field means nobody measured the bucket at all — publishing that as
   * 0 would draw a fully consumed bar no reading supports.
   */
  remainingFraction: number | null
}

export interface AntigravityQuotaGroup {
  displayName: string
  description?: string
  buckets: AntigravityModelBucket[]
}

export interface AntigravityModelOption {
  id: string
  name: string
  enabled: boolean
  defaultContextWindow: number
  contextWindow?: number
  description?: string
  reasoningEfforts?: string[]
}

export interface AntigravityAccountQuota {
  projectId?: string
  endpoint?: string
  planLabel?: string
  productTier?: { id?: string; name?: string; description?: string }
  paidTier?: { id?: string; name?: string; description?: string }
  groups: AntigravityQuotaGroup[]
  groupDescription?: string
  models: Array<{ modelId: string; displayName?: string; description?: string }>
  catalogModels: Array<{ id: string; name?: string; description?: string }>
  defaultAgentModelId?: string
  fetchedAt: number
}

import type { AccountRotationStrategy, PoolAccountSummaryDto } from './account-pool-contracts.ts'

export type { AccountRotationStrategy }

/**
 * The part of an Antigravity request that changed since that session's previous
 * request.
 *
 * The line's cache is implicit and server-side: nothing in the request turns it
 * on, so a hit ratio alone cannot say why a turn went cold. `'none'` means the
 * prefix held; every other value names the input that broke it.
 *
 * Read `'none'` narrowly. It says the segments this line fingerprints are
 * byte-identical to the previous request of the same session — not that nothing
 * about the turn changed. The serving account is one input it cannot see: the
 * snapshots are keyed by session while the token totals are keyed by session and
 * account, so a conversation that fell through to another pooled account reports
 * `'none'` even though the account changed. Whether that accounts for anything
 * server-side is inferred, not measured.
 */
export type AntigravityPrefixDriftCause =
  | 'none'
  | 'contents'
  | 'systemInstruction'
  | 'tools'
  /**
   * The session identifier the request carries changed inside one session scope.
   * It names the client-side string and promises nothing about the service's
   * cache, which is why it is spelled out rather than shortened to "session ID".
   */
  | 'session-id'
  | 'new-session'

/**
 * How well Antigravity's implicit prefix cache is working for one session.
 *
 * Reported because the cache is invisible otherwise: there is no marker to set
 * and no client-side control field, so the served-from-cache share of the prompt
 * is the only evidence a conversation is reusing its prefix.
 */
export interface AntigravityCacheStatsDto {
  /** Requests that reported usage. */
  requests: number
  /** Prompt tokens served from cache across those requests. */
  cachedTokens: number
  /** Prompt tokens processed afresh across those requests. */
  freshTokens: number
  /** cached / (cached + fresh); null until a request reports usage. */
  hitRatio: number | null
  /** Why the most recent request's prefix broke, when it did. */
  lastDriftCause?: AntigravityPrefixDriftCause
}

/** One pooled Antigravity account as the settings card renders it. */
export interface AntigravityAccountSummaryDto extends PoolAccountSummaryDto {
  projectId?: string
  planLabel?: string
}

export interface AntigravityWebStatus {
  enabled?: boolean
  authenticated: boolean
  email?: string
  projectId?: string
  planLabel?: string
  hasCredentials: boolean
  storagePath: string
  lastFetchedAt?: number
  /**
   * Whether a quota refresh is running behind this answer.
   *
   * The card renders the snapshot it already had instead of waiting on the
   * upstream request; when this is true the client asks again shortly so the
   * refreshed snapshot reaches the UI.
   */
  quotaRefreshing?: boolean
  quota?: AntigravityAccountQuota
  models: AntigravityModelOption[]
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
  accounts?: AntigravityAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy?: AccountRotationStrategy
  /**
   * Rolling prefix-cache effectiveness for the requested session, or for the
   * whole process when the request named none. Null while nothing has reported
   * usage yet — which is not the same fact as a 0% hit ratio.
   */
  cache?: AntigravityCacheStatsDto | null
}

export interface AntigravitySettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[]
  /** A number sets an override for that model; `null` restores the catalog default. */
  contextWindowOverrides?: Record<string, number | null>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
}
