import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkBuddyWebStatus } from '../../shared/workbuddy-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_WORKBUDDY } from './locales.ts'

const api = createLineApi('/workbuddy/api', 'WorkBuddy')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_WORKBUDDY> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * Pick the most meaningful number for the badge.
 *
 * A bounded allowance is what a user spends down, so it wins over a bare credit
 * balance; the balance shows only when no percentage is reported. The billing
 * payload reports both a cycle meter and a package meter, and the cycle meter
 * is the one that actually resets, so it is preferred when both exist.
 */
export function selectBadgeFacts(status: WorkBuddyWebStatus | null): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: 'WorkBuddy quota unavailable — click to refresh', level: 'normal' }
  }

  const meter = (quota.meters ?? []).find((candidate) => candidate.id === 'cycle' && candidate.remainingFraction !== null)
    ?? (quota.meters ?? []).find((candidate) => candidate.remainingFraction !== null)
  if (meter !== undefined && meter.remainingFraction !== null) {
    const remaining = Math.round(meter.remainingFraction * 100)
    return {
      text: `${remaining}%`,
      tooltip: `[WorkBuddy] ${meter.label}: ${remaining}% left`,
      level: quotaLevel(remaining),
    }
  }

  if (quota.remainingCredits !== null) {
    return {
      text: String(quota.remainingCredits),
      tooltip: `[WorkBuddy] Remaining credits: ${quota.remainingCredits}`,
      level: 'normal',
    }
  }
  return { text: '—', tooltip: 'WorkBuddy quota unavailable — click to refresh', level: 'normal' }
}

export function WorkBuddyComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="workbuddy-subscription"
    readStatus={(refresh) => (refresh
      ? api.post<WorkBuddyWebStatus>('/quota')
      : api.get<WorkBuddyWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
