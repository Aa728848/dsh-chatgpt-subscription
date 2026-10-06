import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeWebStatus } from '../../shared/command-code-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_COMMAND_CODE } from './locales.ts'

const api = createLineApi('/command-code/api', 'Command Code')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_COMMAND_CODE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * Pick the most meaningful number for the badge.
 *
 * A bounded usage window is the number a user actually spends down, so it wins
 * over a credit balance; the balance shows only when no window is reported.
 */
export function selectBadgeFacts(status: CommandCodeWebStatus | null): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: 'Command Code quota unavailable — click to refresh', level: 'normal' }
  }

  const window = [...(quota.windows ?? [])].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))[0]
  if (window !== undefined) {
    const remaining = Math.max(0, 100 - window.usedPercent)
    return {
      text: `${remaining}%`,
      tooltip: `[Command Code] ${window.label}: ${remaining}% left`,
      level: quotaLevel(remaining),
    }
  }

  const meter = (quota.meters ?? []).find((candidate) => candidate.remainingFraction !== null)
  if (meter !== undefined && meter.remainingFraction !== null) {
    const remaining = Math.round(meter.remainingFraction * 100)
    return {
      text: `${remaining}%`,
      tooltip: `[Command Code] ${meter.label}: ${remaining}% left`,
      level: quotaLevel(remaining),
    }
  }

  if (quota.unlimited) {
    return { text: '∞', tooltip: '[Command Code] Unlimited plan allowance', level: 'normal' }
  }
  if (quota.creditBalance !== null) {
    return { text: quota.creditBalance, tooltip: `[Command Code] Remaining credits: ${quota.creditBalance}`, level: 'normal' }
  }
  return { text: '—', tooltip: 'Command Code quota unavailable — click to refresh', level: 'normal' }
}

export function CommandCodeComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="command-code"
    readStatus={(refresh) => (refresh
      ? api.post<CommandCodeWebStatus>('/quota')
      : api.get<CommandCodeWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
