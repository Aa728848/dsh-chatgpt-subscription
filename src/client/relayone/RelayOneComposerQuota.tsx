import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RELAYONE_PROVIDER_ID, type RelayOneStatusDto } from '../../shared/relayone-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { relayOneQuotaAmount, relayOneQuotaIsUnlimited, relayOneQuotaText } from './quota-format.ts'
import type { SnapshotStore } from '../store.ts'
import { get, post } from './api.ts'
import { NS_RELAYONE, zh } from './locales.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_RELAYONE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}
export function selectRelayOneBadgeFacts(status: RelayOneStatusDto | null, lookup: (key: keyof typeof zh) => string = key => zh[key]): ComposerQuotaFacts | null {
  if (status === null || !status.authenticated || status.quota === undefined) return null
  const quota = status.quota
  const text = relayOneQuotaText(quota)
  if (text === null) return null
  const available = relayOneQuotaAmount(quota.totalAvailable, quota.quotaPerUnit)
  const used = relayOneQuotaAmount(quota.totalUsed, quota.quotaPerUnit)
  const granted = relayOneQuotaAmount(quota.totalGranted, quota.quotaPerUnit)
  const detail = relayOneQuotaIsUnlimited(quota) ? lookup('quotaUnlimited')
    : [available === null ? null : lookup('quotaAvailable') + ' ' + available,
      used === null ? null : lookup('quotaUsed') + ' ' + used,
      granted === null ? null : lookup('quotaGranted') + ' ' + granted].filter(Boolean).join(' · ')
  return {
    text,
    tooltip: '[RelayOne] ' + detail + (quota.state === 'stale' ? ' · ' + lookup('quotaStale') : ''),
    level: quotaLevel(quota.remainingPercent ?? 100),
    ...(quota.remainingPercent === null ? {} : { percent: quota.remainingPercent }),
  }
}
export function RelayOneComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge directory={directory} loadModelDirectory={loadModelDirectory} providerId={RELAYONE_PROVIDER_ID}
    readStatus={refresh => refresh ? post<RelayOneStatusDto>('/catalog/refresh', {}) : get<RelayOneStatusDto>('/status')}
    selectFacts={status => selectRelayOneBadgeFacts(status, t)} label={t('composerLabel')} />
}
