import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { QIANWEN_TOKEN_PLAN_PROVIDER_ID, type QianwenStatusDto } from '../../../shared/qianwen-token-plan-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../../common/ComposerQuotaBadge.tsx'
import type { SnapshotStore } from '../codex-chatgpt/store.ts'
import { get } from './api.ts'
import { NS_QIANWEN, zh } from './locales.ts'
import { qianwenCacheHitRatio } from './useQianwenSection.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_QIANWEN> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}
export function selectQianwenBadgeFacts(status: QianwenStatusDto | null, lookup: (key: keyof typeof zh) => string = key => zh[key]): ComposerQuotaFacts | null {
  const cache = status?.cacheStats
  if (cache === undefined || cache === null) return null
  const ratio = qianwenCacheHitRatio(cache)
  if (ratio === null) return null
  const percent = Math.round(ratio * 100)
  return { text: percent + '%', tooltip: '[' + lookup('title') + '] ' + lookup('cacheHitRatio') + ': ' + percent + '% · ' + cache.cacheReadTokens + ' tokens', level: quotaLevel(percent) }
}
export function QianwenComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge directory={directory} loadModelDirectory={loadModelDirectory} providerId={QIANWEN_TOKEN_PLAN_PROVIDER_ID} readStatus={() => get<QianwenStatusDto>('/status')} selectFacts={status => selectQianwenBadgeFacts(status, t)} label={t('composerLabel')} />
}
