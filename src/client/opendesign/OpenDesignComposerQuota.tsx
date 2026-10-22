import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../store.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import type { OpenDesignCodingPlanDto, OpenDesignWebStatus } from '../../shared/opendesign-contracts.ts'
import { OpenDesignApi } from './api.ts'
import { zh } from './locales.ts'

const API = new OpenDesignApi()

export interface OpenDesignComposerQuotaProps {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
}

/**
 * The composer badge for this line.
 *
 * Only OAuth accounts carry a control key, so only they have a wallet reading
 * at all; the badge shows the primary (else first) readable account's latest
 * balance and never triggers a read of its own — a poll must not fan out one
 * upstream call per account. A pasted-key-only pool renders nothing.
 *
 * The Design Plan endpoint also states the tier's allowance windows, each with
 * its own grant and what is left of it, so the badge shows the remaining share
 * of the narrowest window and draws it as a thin bar. A reading without a
 * measurable window keeps the bare balance, which is what every other line
 * renders.
 */
export function OpenDesignComposerQuota(props: OpenDesignComposerQuotaProps): React.JSX.Element {
  return <ComposerQuotaBadge
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory}
    providerId="opendesign"
    label={zh.composerLabel}
    readStatus={() => API.status()}
    selectFacts={selectOpenDesignFacts}
  />
}

/** A number the badge prints bare: the label around it carries the unit. */
function formatDecimal(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
  } catch {
    return String(value)
  }
}

/**
 * A window's length in the words the service sold it in.
 *
 * The settings card makes the same derivation; it is repeated here because the
 * two surfaces read different dictionaries (the section is localized, this badge
 * is not), and one decimal is what keeps "1.5 小时" from reading as "2 小时".
 */
function planWindowName(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) {
    return zh.usageWindowDays.replace('{count}', String(seconds / 86_400))
  }
  if (seconds >= 3_600) {
    return zh.usageWindowHours.replace('{count}', formatDecimal(seconds / 3_600))
  }
  return zh.usageWindowMinutes.replace('{count}', formatDecimal(seconds / 60))
}

/** What a window still has, from the grant and the remainder it states. */
function windowRemaining(limitCredits: string, remainingCredits: string): number | null {
  const limit = Number(limitCredits)
  const left = Number(remainingCredits)
  if (!Number.isFinite(limit) || !Number.isFinite(left) || limit <= 0) return null
  const used = Math.min(100, Math.max(0, Math.round(((limit - left) / limit) * 1000) / 10))
  return Math.min(100, Math.max(0, Math.round((100 - used) * 10) / 10))
}

interface PlanWindowReading {
  seconds: number
  name: string
  remaining: number
}

/** Every window the badge can speak about, narrowest first. */
function planWindows(plan: OpenDesignCodingPlanDto | undefined): PlanWindowReading[] {
  if (plan === undefined || plan.error !== '') return []
  const readings: PlanWindowReading[] = []
  for (const window of plan.windows) {
    const remaining = windowRemaining(window.limitCredits, window.remainingCredits)
    if (remaining === null) continue
    readings.push({ seconds: window.durationSeconds, name: planWindowName(window.durationSeconds), remaining })
  }
  return readings.sort((left, right) => left.seconds - right.seconds)
}

/** The line's own number picker, exported so a test can pin the rule. */
export function selectOpenDesignFacts(
  status: OpenDesignWebStatus | null,
  _modelId?: string,
): ComposerQuotaFacts | null {
  if (status === null || !status.authenticated || status.usage === null) return null
  const readings = status.usage.accounts.filter((account) => account.ok && account.balanceUsd !== null)
  if (readings.length === 0) return null
  const primaryId = status.pool.activeAccountId ?? status.pool.accounts.find((account) => account.isPrimary)?.id
  const reading = readings.find((account) => account.accountId === primaryId) ?? readings[0]!
  const amount = reading.balanceUsd!
  const readAt = zh.usageReadAt.replace('{time}', new Date(reading.fetchedAt).toLocaleTimeString())
  const windows = planWindows(reading.codingPlan)
  if (windows.length === 0) {
    // No measurable window: this is the wallet balance the badge always showed,
    // and it carries no bar, exactly like every other line.
    return {
      text: `$${amount}`,
      tooltip: `${reading.alias} · ${readAt}`,
      // An exactly-zero wallet fails the next request outright; anything else is
      // a balance, not a warning threshold this line gets to invent.
      level: Number(amount) === 0 ? 'danger' : 'normal',
    }
  }
  const narrowest = windows[0]!
  return {
    // The narrowest window runs out first, so it is the number worth showing;
    // the tooltip carries every window the plan states, in the same words.
    text: zh.usageWindowRemaining.replace('{remaining}', formatDecimal(narrowest.remaining)),
    tooltip: `${reading.alias} · ${windows
      .map((window) => `${window.name} ${zh.usageWindowRemaining.replace('{remaining}', formatDecimal(window.remaining))}`)
      .join(' · ')} · ${readAt}`,
    // The badge grades what is left, and that is what quotaLevel names: 5% left
    // is the emergency the other lines mark as danger.
    level: quotaLevel(narrowest.remaining),
    // Remaining share, not consumed: the meter fills with what is still there.
    percent: narrowest.remaining,
  }
}
