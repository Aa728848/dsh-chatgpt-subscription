/**
 * The capacity, date and countdown formatting every provider settings card shares.
 *
 * Each card used to carry its own copy of the capacity pair. The five copies
 * were byte-identical except Antigravity's `formatCapacity`, which had lost the
 * 1K floor and so rendered a zero as "0K" while its siblings rendered "0". The
 * parse has to mean the same thing on every line — it takes free-text user input
 * that feeds the overflow judgement — so this is the one place it lives. The
 * date helpers were copied the same way; the countdown to a reset instant is
 * here for the same reason.
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

/**
 * Render a token count as the compact figure a capability line carries.
 *
 * `formatCapacity` above is the capacity FIELD's seeder: it prints only exact
 * multiples, so 131072 seeds the input as "131072" (a precise draft for an
 * editable number, which is right). A summary line is a different job — vendor
 * windows and output caps are binary multiples and raw digits turn the line into
 * soup. One decimal tells 1M from 1.05M without pretending the figure is exact.
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  // Millions keep two decimals (1.05M must not become 1.1M); thousands are
  // whole numbers (131,072 reads as 131k — a tenth there is noise).
  const trim = (text: string): string => text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  if (value >= 1_000_000) return trim((value / 1_000_000).toFixed(2)) + 'M'
  if (value >= 1_000) return Math.round(value / 1_000) + 'k'
  return String(value)
}

/**
 * A share as a person reads it: at most `digits` decimals, no trailing zeros.
 *
 * The formatting has to happen on the RESULT rather than on its inputs. Most
 * percentages on these cards are a remainder — `100 - used` — and that
 * subtraction is exactly where binary floating point shows up: `100 - 8.04` is
 * `91.96000000000001`, `100 - 0.0007 * 100` is `99.93` but `100 - 0.0014 * 100`
 * is `99.86` only because it happens to land on a friendly neighbour. String
 * interpolation of the difference therefore prints a long tail for roughly a
 * third of all two-decimal inputs, which reads as "sometimes" — and no amount of
 * rounding the used share beforehand fixes a subtraction done afterwards.
 *
 * Anything non-finite renders as `0`, because every caller has already decided
 * the window is measured; this is the last line of defence, not a claim.
 */
export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0'
  const factor = 10 ** Math.min(6, Math.max(0, Math.trunc(digits)))
  // Dividing an integer by a power of ten gives a double whose shortest
  // representation is that decimal, so this cannot reintroduce a tail.
  return String(Math.round(value * factor) / factor)
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
 * The remaining part of a cooldown, split into whole minutes and seconds.
 *
 * A cooldown counted in whole minutes only is frozen for a whole minute at a
 * time: the badge says "剩 5 分" while the wait drops from 5:00 to 4:01, and
 * the user is left watching a number that does not move. The seconds are what
 * make the wait legible, so they are carried separately - and rounded UP,
 * because a cooldown with 30.2 seconds left is still 31 seconds of waiting, and
 * rounding down would announce "0 seconds left" while the wait is not over.
 */
export function cooldownRemainingParts(remainingMs: number): { minutes: number; seconds: number } {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 }
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
