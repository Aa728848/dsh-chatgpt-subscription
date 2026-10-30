import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { WorkBuddyWebStatus } from '../../shared/workbuddy-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import { useLineDict } from '../common/line-locale.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_WORKBUDDY, zh } from './locales.ts'

const api = createLineApi('/workbuddy/api', 'WorkBuddy')

export interface WorkBuddyComposerQuotaProps {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
}

/**
 * Pick the most meaningful number for the badge.
 *
 * The three cases are deliberately distinct, because collapsing any two of them
 * states something the card does not know:
 *
 *   - a BOUNDED allowance is what a user spends down, so the cycle meter's
 *     remaining share wins the text slot when both exist, since that is the one
 *     that actually resets; the number is enough here and the shared badge draws
 *     no trailing meter, matching every sibling line's compact badge;
 *   - a reported share of ZERO is a measurement ("nothing left"), not a missing
 *     value: it renders `0%` at danger level and must never be confused with the
 *     unavailable case below;
 *   - a bare credit balance is a quantity with no percentage, so it is shown as
 *     a number and no meter bar is drawn beside it;
 *   - nothing reported at all (no status, no quota, no meter, no balance) is
 *     UNKNOWN: the badge says so and asks for a click, instead of fabricating a
 *     `0` that reads as "you are out of quota".
 *
 * `percent` is deliberately never carried: the WorkBuddy badge is text-only so it
 * matches the other lines' compact badges. A bar filled from a guess would be
 * worse than no bar, and this line has no sibling that draws one.
 */
export function selectBadgeFacts(
  status: WorkBuddyWebStatus | null,
  _modelId?: string,
): ComposerQuotaFacts | null {
  // The pool's state is decided FIRST, before anything is read off a quota
  // snapshot. A pause is a fact about the POOL — nothing will be served — and a
  // host whose pool stopped before any snapshot existed answers `quota: null` or
  // omits it entirely. Testing the snapshot first made those two cases
  // unreachable and reported a neutral "unavailable" for a pool that serves
  // nothing, which reads as "we have not looked yet".
  const pool = status?.pool
  if (pool?.paused === true) {
    const reason = pool.pauseReason === undefined || pool.pauseReason === ''
      ? ''
      : ` — ${pool.pauseReason}`
    return { text: '—', tooltip: `[WorkBuddy] pool paused${reason}`, level: 'danger' }
  }

  const quota = status?.quota
  const unknown: ComposerQuotaFacts = {
    text: '—',
    tooltip: 'WorkBuddy quota unavailable — click to refresh',
    level: 'normal',
  }
  if (quota === null || quota === undefined) return unknown

  const meters = quota.meters ?? []
  const meter = meters.find((candidate) => candidate.id === 'cycle' && candidate.remainingFraction !== null)
    ?? meters.find((candidate) => candidate.remainingFraction !== null)
  if (meter !== undefined && meter.remainingFraction !== null && Number.isFinite(meter.remainingFraction)) {
    const remaining = Math.round(Math.min(1, Math.max(0, meter.remainingFraction)) * 100)
    return {
      text: `${remaining}%`,
      tooltip: `[WorkBuddy] ${meter.label}: ${remaining}% left`,
      level: quotaLevel(remaining),
    }
  }

  if (quota.remainingCredits !== null && Number.isFinite(quota.remainingCredits)) {
    return {
      text: String(quota.remainingCredits),
      tooltip: `[WorkBuddy] Remaining credits: ${quota.remainingCredits}`,
      level: 'normal',
    }
  }
  return unknown
}

export function WorkBuddyComposerQuota({ directory, loadModelDirectory }: WorkBuddyComposerQuotaProps): React.JSX.Element | null {
  // Read through the locale registry rather than a captured dictionary: the
  // badge stays mounted across a locale switch, so its label has to follow.
  const t = useLineDict(NS_WORKBUDDY, zh)
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="workbuddy-subscription"
    readStatus={(refresh) => (refresh
      ? api.post<WorkBuddyWebStatus>('/quota')
      : api.get<WorkBuddyWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t.composerLabel}
  />
}
