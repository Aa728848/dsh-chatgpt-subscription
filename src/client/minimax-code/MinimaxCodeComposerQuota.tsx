import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MinimaxCodeWebStatus } from '../../shared/minimax-code-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_MINIMAX_CODE } from './locales.ts'

const api = createLineApi('/minimax-code/api', 'MiniMax Code')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_MINIMAX_CODE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * Pick the badge facts for one status answer, or nothing at all.
 *
 * Quota is optional in the contract, and the usage read is allowed to fail (the
 * endpoint is undocumented and which host serves this subscription is
 * unmeasured), so a status without quota means the badge has nothing to say: it
 * is not rendered, rather than showing a placeholder that would read as a broken
 * meter. Callers must treat null as "hide the badge".
 */
export function selectBadgeFacts(status: MinimaxCodeWebStatus | null): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === undefined) return null

  if (quota.usedPercent !== undefined && Number.isFinite(quota.usedPercent)) {
    const remaining = Math.max(0, Math.round(100 - quota.usedPercent))
    return {
      text: `${remaining}%`,
      tooltip: `[MiniMax Code] ${quota.label}: ${remaining}% left`,
      level: quotaLevel(remaining),
    }
  }

  // A quota without a percentage still names something (a plan, a window), so
  // it is shown as text instead of a number.
  return { text: quota.label, tooltip: `[MiniMax Code] ${quota.label}`, level: 'normal' }
}

export function MinimaxCodeComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="minimax-code"
    // `/quota` rather than `/status`: it answers with the same payload, but it
    // also refreshes the snapshot (subject to the host-side TTL), whereas
    // `/status` only ever reports the cached one. The badge is the one place a
    // stale number is visible at a glance, so it asks for the fresher read —
    // which is also why a click asks for nothing more than a re-read.
    readStatus={() => api.get<MinimaxCodeWebStatus>('/quota')}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
