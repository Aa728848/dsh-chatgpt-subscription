import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeWebStatus } from '../../shared/claude-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_CLAUDE } from './locales.ts'

const api = createLineApi('/claude/api', 'Claude')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_CLAUDE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * Pick the most meaningful number for the badge.
 *
 * A subscription is bounded by several windows at once — a 5-hour one and a
 * weekly one, and sometimes a per-model weekly one as well. They are not
 * interchangeable: the short window can be spent while the long one has room and
 * the reverse, so the TIGHTEST *remaining* percentage is what the badge shows
 * and its own label names the tooltip. Choosing "the shortest window" instead
 * would be a guess about which one runs out first, and the payload already
 * answers that.
 *
 * NOTE ON DIRECTION: the wire reports `usedPercent`, which is PERCENT USED, so
 * remaining is 100 - used. A window at 0% used is the normal empty state and
 * grades as 'normal', not as an error.
 */
export function selectBadgeFacts(status: ClaudeWebStatus | null): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: '[Claude] quota unavailable — click to refresh', level: 'normal' }
  }

  let tightest: { label: string; remaining: number } | null = null
  for (const window of quota.windows) {
    // A null is "the source stated nothing" — skipped rather than read as a
    // fully-spent window, which would be a fabricated alarm.
    const remaining = window.remainingPercent
      ?? (window.usedPercent === null ? null : 100 - window.usedPercent)
    if (remaining === null) continue
    if (tightest === null || remaining < tightest.remaining) {
      tightest = { label: window.label, remaining }
    }
  }
  if (tightest === null) {
    return { text: '—', tooltip: '[Claude] quota unavailable — click to refresh', level: 'normal' }
  }

  const remaining = Math.round(tightest.remaining)
  return {
    text: `${remaining}%`,
    tooltip: `[Claude] ${tightest.label}: ${remaining}% left`,
    level: quotaLevel(remaining),
  }
}

export function ClaudeComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="claude-subscription"
    readStatus={(refresh) => (refresh
      ? api.post<ClaudeWebStatus>('/quota')
      : api.get<ClaudeWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
