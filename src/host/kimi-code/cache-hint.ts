/**
 * When it is worth telling the user their prompt cache has gone cold.
 *
 * Kimi's cache is automatic and content-hash based, so a client gets no marker
 * that it is no longer being reused — the only evidence is the read ratio in
 * the usage stream. A conversation that sat idle past the cache TTL pays the
 * full prompt again on its next turn, and it is large enough on a real
 * codebase to be worth a sentence.
 *
 * The trigger mirrors the official client's: idle beyond the tier's lifetime
 * AND a context large enough that reprocessing it actually costs something.
 * The upstream rules arrive from a remote config that a private deployment
 * cannot reach, so the thresholds here are the documented defaults; the
 * decision function itself is written to take them, so swapping the source
 * later changes only where the numbers come from.
 */

import type { KimiCodeCacheTtl } from '../../shared/kimi-code-contracts.ts'

/**
 * How long an entry written at each tier survives.
 *
 * The tier is LOCKED when the prefix is first written, so this is the lifetime
 * of the entry a request actually created rather than of the tier as a name.
 */
export const CACHE_TTL_MS: Record<KimiCodeCacheTtl, number> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
}

/**
 * Context below which a cold cache is not worth mentioning.
 *
 * Reprocessing a few thousand tokens is invisible; reprocessing a few hundred
 * thousand is the difference between an instant and a visible pause, and
 * telling someone about the former trains them to ignore the notice.
 */
export const MIN_TOKENS_TO_HINT = 100_000

/** Tier assumed when the conversation states none. */
const DEFAULT_TIER: KimiCodeCacheTtl = '5m'

/**
 * Last time each session did something, epoch ms.
 *
 * Bounded like the mapper's own per-session diagnostics, for the same reason:
 * the hint is only as good as this timestamp, and a map that grew for the life
 * of the process would be a leak for a purely advisory feature.
 */
const lastActiveBySession = new Map<string, number>()

/** Bound on remembered sessions. */
const MAX_TRACKED_SESSIONS = 256

/**
 * Note that a session just did something.
 *
 * Called on every turn, so the timestamp answers how long since this
 * conversation last ran, which is what decides whether its cache entry can
 * still be alive.
 */
export function markSessionActive(sessionId: string | undefined, now: number = Date.now()): void {
  if (sessionId === undefined || sessionId.trim() === '') return
  const key = sessionId.trim()
  // Re-insert so Map order stays least-recently-written first.
  lastActiveBySession.delete(key)
  lastActiveBySession.set(key, now)
  if (lastActiveBySession.size <= MAX_TRACKED_SESSIONS) return
  const oldest = lastActiveBySession.keys().next()
  if (oldest.done !== true) lastActiveBySession.delete(oldest.value)
}

/** When a session last did something, or undefined when it never has. */
export function sessionLastActiveAt(sessionId: string | undefined): number | undefined {
  if (sessionId === undefined || sessionId.trim() === '') return undefined
  return lastActiveBySession.get(sessionId.trim())
}

/** Forget one session's activity, or all of it. Test seam and teardown. */
export function resetSessionActivity(sessionId?: string): void {
  if (sessionId === undefined) {
    lastActiveBySession.clear()
    return
  }
  lastActiveBySession.delete(sessionId.trim())
}

export interface CacheHintInput {
  /** Current time, epoch ms. */
  readonly now: number
  /**
   * When the conversation last did anything, epoch ms.
   *
   * Absent means nothing is known, and the hint is skipped: a client that
   * cannot say how long the session was idle cannot claim the entry expired.
   */
  readonly lastActiveAt?: number
  /** Context currently loaded, in tokens. Absent means no local estimate. */
  readonly totalTokens?: number
  /** Tier the conversation's entries were written at. */
  readonly cacheTtl?: KimiCodeCacheTtl | null
}

export type CacheHintDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'hint'; readonly idleMs: number; readonly totalTokens: number }

/**
 * Whether one conversation should be warned about a cold cache.
 *
 * Every missing-data branch skips. That asymmetry is deliberate and matches
 * the official client: a false negative costs one turn nobody noticed, while a
 * false positive teaches the user the notice is noise and stops them reading
 * the one that mattered.
 */
export function evaluateCacheHint(input: CacheHintInput): CacheHintDecision {
  const { now, lastActiveAt, totalTokens } = input
  if (lastActiveAt === undefined || totalTokens === undefined) return { kind: 'skip' }
  if (!Number.isFinite(lastActiveAt) || !Number.isFinite(totalTokens)) return { kind: 'skip' }
  if (totalTokens < MIN_TOKENS_TO_HINT) return { kind: 'skip' }

  const tier = input.cacheTtl ?? DEFAULT_TIER
  const idleMs = now - lastActiveAt
  // Strictly greater: an entry alive exactly to its TTL has not expired, and
  // rounding must not turn that into a warning.
  if (idleMs <= CACHE_TTL_MS[tier]) return { kind: 'skip' }
  return { kind: 'hint', idleMs, totalTokens }
}
