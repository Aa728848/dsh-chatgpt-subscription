/**
 * When it is worth telling the user their prompt cache has gone cold.
 *
 * Kimi's cache is automatic and content-hash based, so a client gets no marker
 * that it is no longer being reused — the only evidence is the read ratio in
 * the usage stream. A conversation that sat idle past the cache lifetime pays
 * the full prompt again on its next turn, and it is large enough on a real
 * codebase to be worth a sentence.
 *
 * The trigger mirrors the official client's: idle beyond the cache lifetime AND
 * a context large enough that reprocessing it actually costs something. The
 * upstream rules arrive from a remote config that a private deployment cannot
 * reach, so the lifetime here is the measured one; the decision function stays
 * a pure function of its inputs so swapping the source later changes only where
 * the number comes from.
 */

/**
 * How long an entry survives, in milliseconds.
 *
 * MEASURED, not documented. The coding endpoint publishes no cache lifetime and
 * its `5m`/`1h` write tiers cannot be selected from any official client, so the
 * only figure available is the survival curve: 30 minutes, derived from the
 * endpoint's own measured behaviour.
 *
 * The measurement (2026-10-02/03, three replicas per age, one fresh prefix per
 * age so the probe does not renew what it is timing) put Kimi's coding plan at
 * 3/3 warm through 25 minutes, 1/3 at 30 minutes, and 0/3 at 35 minutes — a
 * 25–35 minute bracket around a fuzzy edge.
 *
 * 30 minutes is the first age at which most replicas are already cold, which is
 * what this notice needs: it must not fire while the entry is reliably alive.
 * The alternative — the last fully-warm age of 25 minutes — would warn during
 * the five minutes in which the entry still survives more often than not, and a
 * notice that cries wolf is worse than a late one.
 *
 * The old value was 5 minutes, taken from the `5m` write tier's NAME. On this
 * endpoint the name is not the lifetime: that estimate warned from minute 6
 * onward while the entry was still warm for another 19.
 */
export const CACHE_TTL_MS = 30 * 60 * 1000

/**
 * Context below which a cold cache is not worth mentioning.
 *
 * Reprocessing a few thousand tokens is invisible; reprocessing a few hundred
 * thousand is the difference between an instant and a visible pause, and
 * telling someone about the former trains them to ignore the notice.
 */
export const MIN_TOKENS_TO_HINT = 100_000

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

  const idleMs = now - lastActiveAt
  // Strictly greater: an entry alive exactly to its TTL has not expired, and
  // rounding must not turn that into a warning.
  if (idleMs <= CACHE_TTL_MS) return { kind: 'skip' }
  return { kind: 'hint', idleMs, totalTokens }
}
