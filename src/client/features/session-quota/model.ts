import type { SessionQuotaLocaleKey } from './locales.ts'

export type QuotaLevel = 'normal' | 'warning' | 'danger'

export interface QuotaBarItem {
  key: string
  label: string
  /** Remaining share in [0, 100]. */
  remainingPercent: number
  /** Human-readable reset countdown or clock text, when known. */
  resetText?: string
  /** Optional secondary detail (e.g. absolute remaining credits). */
  detailText?: string
  level: QuotaLevel
}

export interface QuotaFactItem {
  key: string
  label: string
  value: string
  level?: QuotaLevel
}

export interface SessionQuotaSnapshot {
  providerId: string
  providerName: string
  planBadge?: string
  /** Compact summary shown when the session panel section is folded. */
  summaryText: string
  summaryLevel: QuotaLevel
  summaryPercent?: number | null
  bars: QuotaBarItem[]
  facts: QuotaFactItem[]
  note?: string
}

export type SessionQuotaDict = Record<SessionQuotaLocaleKey, string>

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/**
 * Format a future reset timestamp (Unix ms, Unix seconds, or ISO string) as a
 * compact countdown matching the session panel's narrow column.
 */
export function formatResetCountdown(
  resetAt: number | string | null | undefined,
  dict: SessionQuotaDict,
  nowMs: number = Date.now(),
): string | undefined {
  if (resetAt === null || resetAt === undefined || resetAt === '') return undefined
  let targetMs: number
  if (typeof resetAt === 'number') {
    if (!Number.isFinite(resetAt) || resetAt <= 0) return undefined
    // Codex and some APIs report Unix seconds (~1.7e9); others report ms (~1.7e12).
    targetMs = resetAt < 1e11 ? resetAt * 1000 : resetAt
  } else {
    const parsed = Date.parse(resetAt)
    if (!Number.isFinite(parsed)) {
      return dict.resetAt.replace('{time}', resetAt)
    }
    targetMs = parsed
  }

  const diffMs = targetMs - nowMs
  if (diffMs <= 60_000) return dict.resetSoon
  const totalMinutes = Math.ceil(diffMs / 60_000)
  if (totalMinutes < 60) {
    return dict.resetInMinutes.replace('{minutes}', String(totalMinutes))
  }
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) {
    return dict.resetInHoursMinutes
      .replace('{hours}', String(totalHours))
      .replace('{minutes}', String(minutes))
  }
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return dict.resetInDaysHours
    .replace('{days}', String(days))
    .replace('{hours}', String(hours))
}

/** Localize a window length in minutes to a concise limit label. */
export function formatWindowDurationLabel(
  minutes: number | null | undefined,
  fallback: string,
  dict: SessionQuotaDict,
): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return fallback
  }
  if (minutes === 300) return dict.windowFiveHour
  if (minutes === 10_080) return dict.windowWeekly
  if (minutes >= 40_320 && minutes <= 44_640) return dict.windowMonthly
  if (minutes % 1_440 === 0) {
    return dict.windowDays.replace('{count}', String(minutes / 1_440))
  }
  if (minutes % 60 === 0) {
    return dict.windowHours.replace('{count}', String(minutes / 60))
  }
  return dict.windowMinutes.replace('{count}', String(Math.round(minutes)))
}
