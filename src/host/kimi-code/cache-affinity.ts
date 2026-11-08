/**
 * Which account should serve this request when one of them still has it warm.
 *
 * Kimi's prefix cache lives on the service, one cache per account, so two
 * accounts in the same pool do not share a warm prefix: the account that
 * answered this exact prompt a minute ago reads it back at the cache price,
 * while the account the rotation strategy happens to pick reprocesses the whole
 * thing. Rotation cannot see that difference — it knows cooldowns, tokens and
 * last use, never prompt content — so the request names the accounts it would
 * rather use and the pool honours the order.
 *
 * The whole decision is here, as a pure function of four inputs, for the same
 * reason `cache-hint` is: the numbers behind it (how long an entry survives, how
 * much a cache read costs against a fresh one) are measured elsewhere, and
 * swapping a source must change only where a value comes from, never the rule.
 *
 * @module dsh-chatgpt-subscription/kimi-code-cache-affinity
 */

import type { KimiCodeAccountQuota } from '../../shared/kimi-code-contracts.ts'

/**
 * Remaining share below which a warm account stops being preferred.
 *
 * Affinity is a discount, not a right: an account holding 4% of its window can
 * serve a few cheap cache reads and then take the line offline mid-conversation,
 * which costs far more than the prefix it saved. 20% is the same floor the
 * background warmup uses before it spends anything (`DEFAULT_MIN_WARMUP_QUOTA_RATIO`),
 * so the two decisions agree about when an account is running dry instead of
 * each inventing its own answer.
 */
export const AFFINITY_QUOTA_FLOOR_SHARE = 0.2

/**
 * The share of its tightest window an account has left, or null when unknown.
 *
 * The TIGHTEST window is the only honest answer: a pool row can carry several
 * at once, and an account with 90% of a weekly window but 2% of its five-hour
 * one is about to be refused. A window whose consumption was never measured
 * is skipped rather than read as empty or full, and a snapshot with no measured
 * window at all answers null — "unknown", which the caller treats as "not
 * provably short" instead of blocking the account on a number nobody measured.
 *
 * @param quota - The account's newest quota snapshot, when one was ever read.
 * @returns the smallest remaining fraction in `[0, 1]`, or null when unknown.
 */
export function remainingQuotaShare(quota: KimiCodeAccountQuota | null | undefined): number | null {
  if (quota === null || quota === undefined || quota.windows.length === 0) return null
  let tightest: number | null = null
  for (const window of quota.windows) {
    // Every window in a snapshot was built from a ratio the service actually
    // reported (an unmeasured one is dropped where the snapshot is built), so
    // `usedFraction` is a measurement here and never a default.
    const used = window.usedFraction
    if (typeof used !== 'number' || !Number.isFinite(used)) continue
    const remaining = clampShare(1 - used)
    tightest = tightest === null ? remaining : Math.min(tightest, remaining)
  }
  return tightest
}

/** Clamp a computed share into `[0, 1]`; rounding must not invent a negative. */
function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Settings-card description for the cache-affinity switch. */
export const CACHE_AFFINITY_SETTING_DESCRIPTION =
  'Kimi Code 专用：多账号轮换时优先选「这条前缀的缓存还热着」的账号，前提是它剩余额度不低于 20%；'
  + '热账号已接近用尽时照旧让位给额度更足的账号，关闭后完全按原轮换策略；非 Kimi 线路开关无影响。'

/**
 * Environment override for the affinity switch.
 *
 * The same contract as the wait-time warmup switch beside it in settings: an
 * explicit value wins over the stored setting, so a deployment can pin the
 * behavioural change without editing preferences on disk.
 */
export const CACHE_AFFINITY_ENV = 'DSH_KIMI_CODE_CACHE_AFFINITY'

/**
 * Resolve whether cache-affinity routing is enabled.
 *
 * Enabled by default. `0`/`false`/`no`/`off` and `1`/`true`/`yes`/`on` override
 * the stored setting; otherwise the live `cacheAffinity` setting (default
 * `true`) governs. Anything unreadable falls back to enabled rather than
 * throwing inside a request path.
 *
 * @param config - Plugin config carrying the live setting.
 * @param env - Environment to consult; `process.env` in production.
 * @returns whether a request may state an account preference.
 */
export function resolveCacheAffinityEnabled(
  config?: { cacheAffinity?: { get(): boolean | undefined } | boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CACHE_AFFINITY_ENV]?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  const field = config?.cacheAffinity
  if (field === undefined || field === null) return true
  if (typeof field === 'object' && typeof (field as { get(): boolean | undefined }).get === 'function') {
    try {
      return (field as { get(): boolean | undefined }).get() !== false
    } catch {
      return true
    }
  }
  return field !== false
}

/** One account the request could be served by. */
export interface AffinityCandidate {
  /** Pool account id. */
  readonly id: string
  /**
   * Whether this account's own prefix group for this request is warm right now.
   *
   * Per account by design: the pool's cache is per account, so "the prefix is
   * warm" is a fact about one account, never about the pool.
   */
  readonly warm: boolean
}

export interface AffinityOrderInput {
  /** Accounts that may serve this request right now, in pool order. */
  readonly candidates: readonly AffinityCandidate[]
  /** Remaining share per account id; a missing or null entry means unknown. */
  readonly remainingShareById?: Readonly<Record<string, number | null | undefined>>
  /** Floor below which a warm account gives way; defaults to {@link AFFINITY_QUOTA_FLOOR_SHARE}. */
  readonly floorShare?: number
}

/**
 * Order the accounts this request would rather use, warmest and safest first.
 *
 * Only accounts whose prefix is warm AND whose remaining share is either
 * unknown or at least the floor are returned: a warm account that is nearly
 * spent is deliberately absent, because the pool then falls back to its own
 * rotation instead of spending the last of a window on a discount. An empty
 * result means "no preference" — the caller passes no hint at all and the
 * strategy behaves exactly as it would have without this module.
 *
 * Order: a warm account with a known-and-sufficient share first (largest
 * remaining first, so two warm accounts spread the load instead of always
 * spending one), then a warm account whose share nobody measured. Unknown last
 * because a measured account is a better bet than an unmeasured one, but still
 * listed: an unmeasured warm account is not evidence of anything bad.
 *
 * @param input - candidates plus the quota evidence behind them.
 * @returns account ids in preference order; empty when nothing is preferred.
 */
export function orderAffinityCandidates(input: AffinityOrderInput): string[] {
  const floor = input.floorShare ?? AFFINITY_QUOTA_FLOOR_SHARE
  const measured: Array<{ id: string; share: number }> = []
  const unmeasured: string[] = []
  for (const candidate of input.candidates) {
    if (!candidate.warm) continue
    const share = input.remainingShareById?.[candidate.id]
    if (share === null || share === undefined || !Number.isFinite(share)) {
      unmeasured.push(candidate.id)
      continue
    }
    // At the floor is still usable: a floor is a boundary, not a trap, and
    // flipping the comparison would silently raise it by one request's worth.
    if (share < floor) continue
    measured.push({ id: candidate.id, share })
  }
  // Stable sort over the candidate order, so two equally full accounts stay in
  // pool order rather than swapping on every request.
  measured.sort((left, right) => right.share - left.share)
  return [...measured.map((entry) => entry.id), ...unmeasured]
}
