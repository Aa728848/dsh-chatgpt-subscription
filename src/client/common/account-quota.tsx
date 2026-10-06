/**
 * The quota block that lives INSIDE one account row.
 *
 * Quota follows the account: a rotation decides which account spends the next
 * request, so a line-level quota figure describes whichever account happened to
 * be active when it was read. The host therefore reports each account's own
 * newest snapshot on that account's summary, and this renders it where the
 * account is — beside its alias, its cooldown and its last-used time.
 *
 * Every line disagrees about the wire (buckets, groups, meters, ISO strings,
 * unix seconds, remaining fractions) and agrees about the shape the host
 * normalizes into: a labeled window, a consumed share, and usually a moment it
 * reopens. Nothing here fetches: an account whose quota was never read shows
 * that it was never read, which is a different statement from "nothing used".
 */
import type { PoolAccountQuotaDto, PoolAccountQuotaWindowDto } from '../../shared/account-pool-contracts.ts'
import { formatPoolLabel, type AccountPoolLabels } from './account-pool-labels.ts'

/** The label keys this block needs, all of them already on every tab's set. */
export type AccountQuotaLabels = Pick<
  AccountPoolLabels,
  'accountQuota' | 'quotaNone' | 'quotaSnapshot' | 'quotaResets' | 'quotaExhausted' | 'quotaWindow' | 'quotaUsed'
>

/**
 * Percent with at most one decimal.
 *
 * A share that is not a finite number renders as `0%` rather than `NaN%`. Every
 * caller has already tested `Number.isFinite` and skips the row, so this is the
 * last line of defence, not a claim about an unmeasured window.
 */
export function formatQuotaPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  try {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`
  } catch {
    return `${value}%`
  }
}

/**
 * When a window reopens, in the reader's own words.
 *
 * Always a distance. The page's own quota block counts down ("7天 3时"), and a
 * row that switched to an absolute date past a threshold described the same
 * window two different ways inside one card. Days carry a long window, hours
 * the short ones, minutes the last stretch.
 */
export function formatQuotaReset(resetsAt: number | null | undefined, now = Date.now()): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= now) return '—'
  const deltaMinutes = Math.round((resetsAt - now) / 60_000)
  try {
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    if (deltaMinutes < 60) return relative.format(deltaMinutes, 'minute')
    if (deltaMinutes < 36 * 60) return relative.format(Math.round(deltaMinutes / 60), 'hour')
    return relative.format(Math.round(deltaMinutes / 1440), 'day')
  } catch {
    return '—'
  }
}

/**
 * When the snapshot was read.
 *
 * A time alone reads as "just now" — which is a lie about a snapshot taken
 * yesterday, and the card's whole promise is that this is what we last saw.
 */
export function formatQuotaSnapshot(fetchedAt: number, now = Date.now()): string {
  try {
    const sameDay = new Date(fetchedAt).toDateString() === new Date(now).toDateString()
    return new Intl.DateTimeFormat(undefined, sameDay
      ? { timeStyle: 'short' }
      : { dateStyle: 'short', timeStyle: 'short' }).format(fetchedAt)
  } catch {
    return '—'
  }
}

/** A window's name: the line's own label, else its length, else a generic one. */
export function quotaWindowLabel(window: PoolAccountQuotaWindowDto, labels: AccountQuotaLabels): string {
  if (window.label !== '') return window.label
  const minutes = window.windowDurationMins
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return labels.quotaWindow
  const [value, unit]: [number, Intl.NumberFormatOptions['unit']] = minutes % 1440 === 0
    ? [minutes / 1440, 'day']
    : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [Math.round(minutes), 'minute']
  try {
    return new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'long' }).format(value)
  } catch {
    return `${value} ${unit}`
  }
}

function levelFor(usedPercent: number): 'normal' | 'warning' | 'danger' {
  return usedPercent >= 95 ? 'danger' : usedPercent >= 80 ? 'warning' : 'normal'
}

/**
 * One account's quota, or the honest statement that none was ever read.
 *
 * `showEmpty` lets the hosting card stay quiet on a line that has no quota to
 * speak of, while still saying "not read yet" for an account the line does read
 * (its active one, or any account once a sibling has a snapshot).
 */
export function AccountQuota(props: {
  quota: PoolAccountQuotaDto | undefined
  labels: AccountQuotaLabels
  /** True to render the "no quota read yet" line instead of nothing. */
  showEmpty: boolean
  now?: number
}): React.JSX.Element | null {
  const { quota, labels } = props
  if (quota === undefined) {
    return props.showEmpty
      ? <div className="dsha-account-quota"><span className="dsha-account-quota-empty">{labels.quotaNone}</span></div>
      : null
  }
  const now = props.now ?? Date.now()
  return <div className="dsha-account-quota">
    <span className="dsha-account-quota-head">
      {labels.accountQuota}
      {quota.fetchedAt > 0 && (
        <em>{formatPoolLabel(labels.quotaSnapshot, { time: formatQuotaSnapshot(quota.fetchedAt, now) })}</em>
      )}
    </span>
    {quota.windows.length === 0
      ? <span className="dsha-account-quota-empty">{labels.quotaNone}</span>
      : quota.windows.map((window, index) => {
        const percent = Number.isFinite(window.usedPercent) ? window.usedPercent : 0
        const label = quotaWindowLabel(window, labels)
        const reset = formatQuotaReset(window.resetsAt, now)
        return <div key={`${label}:${index}`} className="dsha-account-quota-row" data-level={levelFor(percent)}>
          <span className="dsha-account-quota-name" title={label}>{label}</span>
          <span
            className="dsha-account-quota-track"
            role="progressbar"
            aria-label={`${label}: ${formatQuotaPercent(percent)} ${labels.quotaUsed}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <i className="dsha-account-quota-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </span>
          <span className="dsha-account-quota-value">
            {percent >= 100 ? labels.quotaExhausted : formatQuotaPercent(percent)}
          </span>
          <span className="dsha-account-quota-meta">{reset === '—' ? '—' : `${labels.quotaResets} ${reset}`}</span>
        </div>
      })}
  </div>
}
