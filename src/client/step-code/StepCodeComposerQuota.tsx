/**
 * Step Code（Step Plan 订阅）在输入框右侧的额度胶囊。
 *
 * 与 GLM 那颗同款：胶囊是唯一一眼能看到数字的地方，所以点一下要走强制刷新；
 * 而「显示哪一个数字」是每条线路唯一值得自己写的部分，因此单独导出一个纯函数
 * selectBadgeFacts 供测试直接调用。
 *
 * 挑选口径与卡片一致：**只按已测量的窗口选最紧的那一个**，不碰 Credit 桶。
 *
 *   - 老式窗口（5 小时 / 周）有百分比，所以能选；
 *   - Credit 桶是绝对量（总额 / 剩余），把它折成一个「剩余百分比」需要自行决定
 *     分母，而新式套餐里不同桶的地位并不等价（订阅额度与充值额度不是一回事），
 *     折出来的是编的；
 *   - `kind: 'unknown'` 更是连形状都认不出。
 *
 * 所以这三种情况一律返回 null，即**不渲染胶囊**：装一个占位数字比不显示更像坏了。
 */
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  STEP_CODE_PROVIDER_ID,
  type StepCodeStatusDto,
} from '../../shared/step-code-contracts.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import { accountPoolZh } from '../common/account-pool-labels.ts'
import { quotaWindowLabel } from '../common/account-quota.tsx'
import type { SnapshotStore } from '../store.ts'
import { get, post } from './api.ts'
import { NS_STEP_CODE, QUOTA_WINDOW_MINUTES, zh, type StepCodeLocaleKey } from './locales.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_STEP_CODE> & {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

/** 字典的最小形状：窗口名兜底只需要 `quotaWindow` 一个键。 */
type WindowLabels = Pick<typeof accountPoolZh, 'quotaWindow'>

/**
 * 胶囊显示「最紧的那个老式窗口」的剩余百分比。
 *
 * 两个窗口（5 小时 / 周）互相独立地重置，用户当下真正被卡住的是**已用比例最高**的
 * 那一个：另外那个可能还剩一大半。所以这里不平均、不取最小剩余，而是取最大已用；
 * 已用相等时取更短的窗口——重置更早的那个才是当下的瓶颈。
 *
 * 窗口名不硬编码：键映射成窗口长度后交给共享的 quotaWindowLabel 本地化
 * （5 小时 / 1 周 / 5 hours / 1 week）。
 *
 * 没有快照、没有窗口、或全部窗口都没有百分比时返回 null（见文件头）。
 */
export function selectBadgeFacts(
  status: StepCodeStatusDto | null,
  lookup: (key: StepCodeLocaleKey) => string = (key) => zh[key],
): ComposerQuotaFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) return null
  if (quota.kind !== 'windowed') return null
  const measured = quota.windows.filter((window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent))
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

/**
 * 输入框右侧的额度胶囊本体。
 *
 * **槽位号由波次 4 注册，本文件不注册任何槽位**：conversation.input.right 现有
 * 35–42（codex → antigravity → command-code → kimi-code → minimax-code → claude →
 * glm-coding-plan，39 号空出），本线路取下一个号 43，id 沿用命名习惯
 * 'step-code-quota'，locale 为 NS_STEP_CODE。顺延而不是插号：给新线路重排既有号会让
 * 已上线线路的槽位位置无谓地变一次。
 */
export function StepCodeComposerQuota({ directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  return <ComposerQuotaBadge
    directory={directory}
    loadModelDirectory={loadModelDirectory}
    providerId={STEP_CODE_PROVIDER_ID}
    // 点一下要走强制刷新：胶囊是唯一一眼能看到数字的地方，它得是最新的那一份。
    readStatus={(refresh) => (refresh
      ? post<StepCodeStatusDto>('/quota', {})
      : get<StepCodeStatusDto>('/status'))}
    selectFacts={(status) => selectBadgeFacts(status, t)}
    label={t('composerLabel')}
  />
}
