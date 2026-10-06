import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AntigravityModelBucket, AntigravityQuotaGroup, AntigravityWebStatus } from '../../shared/antigravity-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { createLineApi } from '../common/line-api.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_ANTIGRAVITY } from './locales.ts'

const api = createLineApi('/antigravity/api', 'Antigravity')

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_ANTIGRAVITY> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * The bucket this badge should speak for, or null when it cannot speak for one.
 *
 * The service reports the same allowances under separate model groups, and a
 * bucket the service never measured must not be published as "0% left". So the
 * badge skips it and takes the next measured one in the group, and shows nothing
 * at all when the group has none. Falling back to another group's numbers would
 * label one allowance with another's reading.
 *
 * Exported for its own regression test; the badge is its only caller.
 */
export function selectQuotaBucketForModel(groups: AntigravityQuotaGroup[], modelId?: string) {
  if (!groups || groups.length === 0) return null
  const isClaudeOrGpt = modelId ? /claude|gpt/i.test(modelId) : false
  const targetGroup =
    groups.find((g) => {
      const match = /claude|gpt|3p/i.test(g.displayName)
      return isClaudeOrGpt ? match : !match
    }) || groups[0]

  if (!targetGroup || !targetGroup.buckets || targetGroup.buckets.length === 0) return null
  // A missing field and a null are the same statement ("never measured"), and a
  // non-finite number is no more publishable than either: all three are skipped
  // rather than multiplied into a "0% left" the service never said.
  const measured = (bucket: AntigravityModelBucket): boolean =>
    typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
  const shortBucket: AntigravityModelBucket | undefined =
    targetGroup.buckets.find((b: AntigravityModelBucket) => /5\s*小时|hour|5h/i.test(b.displayName) && measured(b))
    ?? targetGroup.buckets.find(measured)
  if (shortBucket === undefined) return null
  const remaining = shortBucket.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null

  return {
    groupName: targetGroup.displayName,
    bucketName: shortBucket.displayName,
    remainingPercent: Math.round(remaining * 100),
    resetTime: shortBucket.resetTime,
  }
}

function formatResetCountdown(resetTime?: string): string {
  if (!resetTime) return ''
  try {
    const diff = new Date(resetTime).getTime() - Date.now()
    if (diff <= 0) return '即将重置'
    const h = Math.floor(diff / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    if (h > 0) return `${h}小时${m}分后重置`
    return `${m}分钟后重置`
  } catch {
    return ''
  }
}

/** The allowance the selected model actually draws on, as the badge's facts. */
export function selectBadgeFacts(status: AntigravityWebStatus | null, modelId?: string): ComposerQuotaFacts {
  const info = selectQuotaBucketForModel(status?.quota?.groups ?? [], modelId)
  if (info === null) return { text: '—', tooltip: '点击刷新 Antigravity 配额', level: 'normal' }
  const countdown = info.resetTime ? formatResetCountdown(info.resetTime) : ''
  return {
    text: `${info.remainingPercent}%`,
    tooltip: `[Antigravity] ${info.groupName} - ${info.bucketName}: 剩余 ${info.remainingPercent}%${countdown ? ` (${countdown})` : ''}，点击刷新`,
    level: quotaLevel(info.remainingPercent),
  }
}

export function AntigravityComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId="antigravity"
    readStatus={(refresh) => (refresh
      ? api.post<AntigravityWebStatus>('/quota')
      : api.get<AntigravityWebStatus>('/status'))}
    selectFacts={selectBadgeFacts}
    label={t('composerLabel')}
  />
}
