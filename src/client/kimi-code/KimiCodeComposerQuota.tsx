import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KimiCodeWebStatus } from '../../shared/kimi-code-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { formatPercent } from '../common/format.ts'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_KIMI_CODE } from './locales.ts'

const api = createLineApi('/kimi-code/api', 'Kimi Code')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_KIMI_CODE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * Pick the most meaningful number for the badge.
 *
 * The shortest window is the one a user spends down first and the one that
 * blocks work soonest, so it wins over the longer pools; the 7-day allowance
 * shows only when no 5-hour window is reported.
 */
export function selectBadgeFacts(status: KimiCodeWebStatus | null): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: '[Kimi Code] quota unavailable — click to refresh', level: 'normal' }
  }

  const window = [...(quota.windows ?? [])]
    .filter((candidate) => candidate.windowDurationMins !== null)
    .sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))[0]
    ?? quota.windows[0]

  if (window !== undefined) {
    // The remainder of a two-decimal share is usually a binary tail
    // (`100 - 8.04` is `91.96000000000001`), so the number is formatted once,
    // here, and the same text is used by the badge and by its tooltip.
    const remaining = Math.max(0, 100 - window.usedPercent)
    const remainingText = formatPercent(remaining)
    return {
      text: `${remainingText}%`,
      tooltip: `[Kimi Code] ${window.label}: ${remainingText}% left`,
      level: quotaLevel(remaining),
    }
  }

  const wallet = quota.extraUsage
  if (wallet !== null && wallet !== undefined && wallet.balanceCents !== null) {
    const amount = (wallet.balanceCents / 100).toFixed(2)
    return {
      text: amount,
      tooltip: `[Kimi Code] booster wallet: ${amount} ${wallet.currency ?? ''}`.trim(),
      level: 'normal',
    }
  }

  return { text: '—', tooltip: '[Kimi Code] quota unavailable — click to refresh', level: 'normal' }
}

export function KimiCodeComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="kimi-code"
    readStatus={(refresh) => (refresh
      ? api.post<KimiCodeWebStatus>('/quota')
      : api.get<KimiCodeWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
