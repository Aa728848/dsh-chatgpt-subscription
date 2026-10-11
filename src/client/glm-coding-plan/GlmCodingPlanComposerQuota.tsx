import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  GLM_CODING_PLAN_PROVIDER_ID,
  type GlmStatusDto,
} from '../../shared/glm-coding-plan-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { accountPoolZh } from '../common/account-pool-labels.ts'
import { quotaWindowLabel } from '../common/account-quota.tsx'
import type { SnapshotStore } from '../store.ts'
import { get, post } from './api.ts'
import { NS_GLM_CODING_PLAN, QUOTA_WINDOW_MINUTES, zh, type GlmCodingPlanLocaleKey } from './locales.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_GLM_CODING_PLAN> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/** 字典的最小形状：窗口名兜底只需要 `quotaWindow` 一个键。 */
type WindowLabels = Pick<typeof accountPoolZh, 'quotaWindow'>

/**
 * 胶囊显示「最紧的那个窗口」的剩余百分比。
 *
 * 三个窗口（5 小时 / 1 周 / 1 月）互相独立地重置，用户当下真正被卡住的是**已用比例
 * 最高**的那一个：另外两个可能还剩一大半。所以这里不平均、不取最小剩余，而是取最大
 * 已用；已用相等时取更短的窗口——重置更早的那个才是当下的瓶颈。
 *
 * 窗口名不硬编码：键映射成窗口长度后交给共享的 quotaWindowLabel 本地化
 * （5 小时 / 1 周 / 1 月 / 5 hours / 1 week / 1 month）。
 *
 * 没有快照、没有窗口、或全部窗口都没有百分比时返回 null，即**不渲染胶囊**：
 * 契约允许 quota 为 null，装一个占位数字比不显示更像坏了。
 */
export function selectBadgeFacts(
  status: GlmStatusDto | null,
  lookup: (key: GlmCodingPlanLocaleKey) => string = (key) => zh[key],
): ComposerQuotaFacts | null {
  const windows = status?.quota?.windows ?? []
  const measured = windows.filter((window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent))
  if (measured.length === 0) return null

  const tightest = measured.reduce((best, window) => {
    const bestMinutes = QUOTA_WINDOW_MINUTES[best.key]
    const minutes = QUOTA_WINDOW_MINUTES[window.key]
    if ((window.usedPercent ?? 0) > (best.usedPercent ?? 0)) return window
    if ((window.usedPercent ?? 0) < (best.usedPercent ?? 0)) return best
    return minutes < bestMinutes ? window : best
  })

  const used = Math.max(0, Math.min(100, tightest.usedPercent ?? 0))
  const remaining = Math.round(100 - used)
  const label = quotaWindowLabel(
    { label: '', usedPercent: used, windowDurationMins: QUOTA_WINDOW_MINUTES[tightest.key] },
    { ...accountPoolZh, quotaWindow: lookup('quotaWindow') } satisfies WindowLabels,
  )
  return {
    text: `${remaining}%`,
    tooltip: `[${lookup('title')}] ${label}: ${remaining}% ${lookup('composerLabel')}`,
    level: quotaLevel(remaining),
  }
}

export function GlmCodingPlanComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId={GLM_CODING_PLAN_PROVIDER_ID}
    // 点一下要走强制刷新：胶囊是唯一一眼能看到数字的地方，它得是最新的那一份。
    readStatus={(refresh) => (refresh
      ? post<GlmStatusDto>('/quota', {})
      : get<GlmStatusDto>('/status'))}
    selectFacts={(status) => selectBadgeFacts(status, t)}
    label={t('composerLabel')}
  />
}
