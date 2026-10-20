/**
 * Qoder（订阅）在输入框右侧的额度胶囊。
 *
 * 与兄弟线路的胶囊同款：胶囊是唯一一眼能看到数字的地方，所以点一下要走强制刷新；
 * 而「显示哪一个数字」是每条线路唯一值得自己写的部分，因此单独导出一个纯函数
 * selectBadgeFacts 供测试直接调用。
 *
 * 挑选口径：**只按有总额的桶选已用比例最高的那只**（个人 / 加购 / 组织包），
 * 显示它的剩余百分比。桶是绝对量，而百分比需要 total 这个分母——没有 total 或
 * total 为 0 的桶不参与选择（「上游没报」与「一点都不剩」必须长得不一样）；
 * 一只可计量的桶都没有时返回 null，即**不渲染胶囊**：装一个占位数字比不显示更像坏了。
 */
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  QODER_PROVIDER_ID,
  type QoderStatusDto,
} from '../../shared/qoder-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import type { SnapshotStore } from '../store.ts'
import { get, post } from './api.ts'
import { NS_QODER, quotaBucketText, zh, type QoderLocaleKey } from './locales.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_QODER> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/**
 * 胶囊显示「最紧的那只桶」的剩余百分比。
 *
 * 多只桶互相独立地消耗，用户当下真正被卡住的是**已用比例最高**的那一只：
 * 另外那只可能还剩一大半。所以这里不平均、不取最小剩余，而是取最大已用比例。
 * 没有快照、没有桶、或全部桶都没有总额时返回 null（见文件头）。
 */
export function selectBadgeFacts(
  status: QoderStatusDto | null,
  lookup: (key: QoderLocaleKey) => string = (key) => zh[key],
): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) return null
  const measurable = quota.buckets.filter((bucket) =>
    bucket.total !== null && bucket.total > 0 && bucket.used !== null)
  if (measurable.length === 0) return null

  const tightest = measurable.reduce((best, bucket) =>
    (bucket.used! / bucket.total!) > (best.used! / best.total!) ? bucket : best)

  const used = Math.max(0, Math.min(1, tightest.used! / tightest.total!))
  const remaining = Math.round((1 - used) * 100)
  const unit = tightest.unit !== null && tightest.unit !== '' ? ' ' + tightest.unit : ''
  const bucketLabel = quotaBucketText(tightest.kind, { ...zh, quotaBucketPersonal: lookup('quotaBucketPersonal'), quotaBucketAddOn: lookup('quotaBucketAddOn'), quotaBucketOrg: lookup('quotaBucketOrg') } as Record<QoderLocaleKey, string>)
  // tooltip 两者都带：百分比是一眼的比例，绝对量是这只桶的真实余量。
  const absolute = tightest.remaining !== null ? ' · ' + tightest.remaining + unit : ''
  return {
    text: remaining + '%',
    tooltip: '[' + lookup('title') + '] ' + bucketLabel + ': ' + remaining + '%' + absolute + ' ' + lookup('composerLabel'),
    level: quotaLevel(remaining),
  }
}

/**
 * 输入框右侧的额度胶囊本体。
 *
 * **槽位号由波次 4 注册，本文件不注册任何槽位**：conversation.input.right 现有
 * 35–44（codex → … → step-code → cline-pass），本线路取下一个号 45，id 沿用命名习惯
 * 'qoder-quota'，locale 为 NS_QODER。顺延而不是插号：给新线路重排既有号会让
 * 已上线线路的槽位位置无谓地变一次。
 */
export function QoderComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId={QODER_PROVIDER_ID}
    // 点一下要走强制刷新：胶囊是唯一一眼能看到数字的地方，它得是最新的那一份。
    readStatus={(refresh) => (refresh
      ? post<QoderStatusDto>('/quota', {})
      : get<QoderStatusDto>('/status'))}
    selectFacts={(status) => selectBadgeFacts(status, t)}
    label={t('composerLabel')}
  />
}
