/**
 * The capacity, date and countdown formatting every provider settings card shares.
 *
 * Each card used to carry its own copy of the capacity pair. The five copies
 * were byte-identical except Antigravity's `formatCapacity`, which had lost the
 * 1K floor and so rendered a zero as "0K" while its siblings rendered "0". The
 * parse has to mean the same thing on every line — it takes free-text user input
 * that feeds the overflow judgement — so this is the one place it lives. The
 * date helpers were copied the same way; WorkBuddy's countdown is here for the
 * same reason.
 */

/**
 * Parse "1M", "512K", "200000" into a positive integer token count.
 *
 * Anything that is not a plain capacity — including `0`, which no model has —
 * returns null rather than a coerced number, so the caller can leave the draft
 * uncommitted instead of storing a length that would silently break compaction.
 */
export function parsePositiveCapacity(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/[,_\s]/g, '')
  const matched = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (matched === null) return null
  const multiplier = matched[2] === 'm' ? 1_000_000 : matched[2] === 'k' ? 1_000 : 1
  const parsed = Number(matched[1]) * multiplier
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

/** Render a token capacity the way the capacity field seeds itself. */
export function formatCapacity(value: number): string {
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}

/** A stamp in the reader's own locale, or an em dash when there is none. */
export function formatDate(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
  } catch {
    return '—'
  }
}

/**
 * Countdown to a reset instant ("3d 4h"), empty when there is nothing to count
 * down to. Empty rather than "—" because callers append it to a date they have
 * already rendered, and a dash there would read as a second missing value.
 */
export function formatReset(resetsAt?: number | null): string {
  if (resetsAt === undefined || resetsAt === null || resetsAt <= 0) return ''
  const diff = resetsAt - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}
