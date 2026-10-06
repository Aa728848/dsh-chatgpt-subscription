/**
 * Turning a line's own quota snapshot into the per-account shape the account
 * card draws.
 *
 * Quota follows the account: a rotation decides which account spends the next
 * request, so one line-level figure describes whichever account happened to be
 * active when it was read. Every line already remembers what it read per
 * account identity; these helpers are the single place that decides what of a
 * snapshot is worth publishing, so seven lines cannot drift apart on the two
 * questions that matter:
 *
 *   - a window whose share nobody measured is NOT zero — it is dropped, because
 *     "0% used" and "not stated" are different claims and the bar would lie;
 *   - a snapshot with no read time is not a snapshot — the card's whole promise
 *     is "this is what we last saw, at this time".
 */
import type { PoolAccountQuotaDto, PoolAccountQuotaWindowDto } from '../../shared/account-pool-contracts.ts'

/**
 * A reset instant as Unix milliseconds.
 *
 * Providers state this in seconds, in milliseconds, or not at all, and the two
 * numeric forms are told apart by magnitude rather than by a flag: 10^10
 * seconds is the year 2286, so anything larger is already milliseconds.
 */
export function quotaResetMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value > 10_000_000_000 ? value : value * 1000
}

/**
 * One window, or null when its consumed share was never measured.
 *
 * `label` may be empty: the card names an unlabeled window from its length, and
 * only falls back to a generic name when the line stated neither.
 */
export function quotaWindow(
  label: string,
  usedPercent: number | null | undefined,
  options: { windowDurationMins?: number | null; resetsAt?: number | null } = {},
): PoolAccountQuotaWindowDto | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null
  const windowDurationMins = typeof options.windowDurationMins === 'number' && Number.isFinite(options.windowDurationMins)
    ? options.windowDurationMins
    : null
  return {
    label,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowDurationMins,
    resetsAt: quotaResetMs(options.resetsAt),
  }
}

/**
 * The snapshot to publish for one account, or undefined when there is none.
 *
 * Undefined is the honest answer for "never read" and for "read before this
 * process started": both mean the card has nothing to show, and neither means
 * the account is unspent.
 */
export function poolQuota(
  fetchedAt: number | null | undefined,
  windows: readonly (PoolAccountQuotaWindowDto | null)[],
): PoolAccountQuotaDto | undefined {
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return undefined
  return { windows: windows.filter((window): window is PoolAccountQuotaWindowDto => window !== null), fetchedAt }
}
