import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../../common/ComposerQuotaBadge.tsx'
import { formatPercent } from '../../common/format.ts'
import { createLineApi } from '../../common/line-api.ts'
import type { SnapshotStore } from '../codex-chatgpt/store.ts'
import type { OpenCodeGoWebStatus } from '../../../shared/opencode-go-contracts.ts'
import { NS_OPENCODE_GO } from './locales.ts'

const api = createLineApi('/opencode-go/api', 'OpenCode Go')
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_OPENCODE_GO> & { directory: SnapshotStore<ModelDirectoryState>; loadModelDirectory: () => void }

export function selectOpenCodeGoBadgeFacts(status: OpenCodeGoWebStatus | null): ComposerQuotaFacts | null {
  const account = status?.accounts.find(entry => entry.id === status.activeAccountId) ?? status?.accounts.find(entry => entry.isPrimary) ?? status?.accounts[0]
  const quota = account?.quota
  if (quota === undefined) return { text: '—', tooltip: '[OpenCode Go] quota unavailable — click to refresh', level: 'normal' }
  const window = [...quota.windows].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))[0]
  if (window === undefined) return { text: '—', tooltip: '[OpenCode Go] quota unavailable — click to refresh', level: 'normal' }
  const remaining = Math.max(0, 100 - window.usedPercent)
  const remainingText = formatPercent(remaining)
  const windowLabel = window.label || (window.windowDurationMins === 300 ? '5-hour' : window.windowDurationMins === 10_080 ? 'weekly' : 'monthly')
  return { text: remainingText + '%', tooltip: '[OpenCode Go] ' + windowLabel + ': ' + remainingText + '% left', level: quotaLevel(remaining) }
}

export function OpenCodeGoComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge directory={directory} loadModelDirectory={loadModelDirectory} providerId="opencode-go"
    readStatus={(refresh) => refresh ? api.post<OpenCodeGoWebStatus>('/quota/refresh') : api.get<OpenCodeGoWebStatus>('/status')}
    selectFacts={selectOpenCodeGoBadgeFacts} label={t('composerLabel')} />
}
