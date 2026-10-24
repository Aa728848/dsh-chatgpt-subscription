/**
 * 设置页里的「进展更新」分区：一句说明 + 四行卡片（开关 / 催促阈值 / 输出语言 / 进展面板）。
 *
 * ## 视觉来源
 *
 * 结构与排版照订阅服务那套 hub 设置页（`../hub/hub-styles.ts` 的 `dsh-hub-card*`
 * 与 `../hub/HubOverview.tsx` 的三行布局）：左侧一个方块标记，中间名称 + 一行
 * 说明，右侧控件。CSS 逐条抄进 `./styles.ts`（方案 B：不做跨包同步）。
 *
 * ## 单级，没有二级页面
 *
 * 四行都停在当前页：开关、数字输入和语言下拉直接写设置，最后一行是「打开」按钮 + chevron，
 * 点它按 kind 打开右侧栏的进展面板，然后把设置弹层收起来——面板在设置弹层底下，
 * 不关掉的话用户还是看不见它。
 *
 * ## 数据
 *
 * 开关、阈值与输出语言经 {@link ProgressSettingsForm} 读写（见 `./settings-binding.ts`）：写入
 * 走宿主共享设置表单，三条字段在宿主 `Config` schema 里都是 `volatile()`，保存即
 * 生效，不需要重启插件行。表单通道缺席（没有设置服务的部署）时控件渲染成禁用态，
 * 并在说明行写明原因——宁可不给点，也不做一个存不住的假开关。
 *
 * 文案全部走 locale（本插件 `dsh-progress-updates` 命名空间），组件本身不出现
 * 硬编码文案。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/settings-section
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { fallbackTranslate, type CopySeat } from './updates-panel.tsx'
import type {
  ConfigFormSnapshot,
  ProgressSettingsForm,
  ProgressUpdatesField,
  ProgressUpdatesLanguage,
  ProgressUpdatesSettingsValues,
} from './settings-binding.ts'

/** 入口注入给设置页的座位：按 kind 打开侧栏面板。 */
export interface ProgressUpdatesSettingsInjected {
  /** 打开右侧栏的进展面板（阶段一注册的那个 kind）。 */
  openPanel: () => void
  /** 设置表单通道；缺席表示这个部署没有可用的设置服务。 */
  settings?: ProgressSettingsForm
}

/** 设置壳交来的 owner 面：关掉设置面板。 */
export interface SettingsShellProps {
  /** 关掉设置面板（开关状态由壳持有）。 */
  close: () => void
}

/** 组件 props：壳的关闭回调 + 注入的打开动作与表单 + 可选文案座位。 */
export type ProgressUpdatesSettingsProps = ProgressUpdatesSettingsInjected & SettingsShellProps & CopySeat

/** 阈值的允许范围，与宿主 schema（`min(1).max(50)`）一致。 */
export const NUDGE_THRESHOLD_MIN = 1
/** 阈值上限。 */
export const NUDGE_THRESHOLD_MAX = 50
/** 宿主 schema 里的默认阈值（`NUDGE_THRESHOLD`，两处同一个数）。 */
export const NUDGE_THRESHOLD_DEFAULT = 8

/**
 * 没有表单通道时的空快照。写成模块级常量，是因为
 * `useSyncExternalStore` 要求 `getSnapshot` 返回稳定引用。
 */
const NO_SETTINGS_SNAPSHOT: ConfigFormSnapshot<ProgressUpdatesSettingsValues> = Object.freeze({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
}) as ConfigFormSnapshot<ProgressUpdatesSettingsValues>

/** 没有表单通道时的订阅（永不回调）。 */
const NO_SETTINGS_SUBSCRIBE = (): (() => void) => () => {}

/** 没有表单通道时的快照读取。 */
const NO_SETTINGS_READ = (): ConfigFormSnapshot<ProgressUpdatesSettingsValues> => NO_SETTINGS_SNAPSHOT

/** 行尾 chevron，与 hub 卡片同一个形状（14px、1.5 描边）。 */
function Chevron(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

/** 第一行的标记：一条带箭头的进展线。 */
function ProgressMark(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 14.5 8.5 10l3 3L16 8" />
      <path d="M12.4 8H16v3.6" />
    </svg>
  )
}

/** 第二行的标记：三条阈值刻度。 */
function ThresholdMark(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h12M4 10h8M4 14h5" />
    </svg>
  )
}

/** 第三行的标记：一个地球，对应「输出语言」。 */
function LanguageMark(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14" />
      <ellipse cx="10" cy="10" rx="3.2" ry="7" />
    </svg>
  )
}

/** 第四行的标记：一块右侧栏面板。 */
function PanelMark(): ReactNode {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="11" rx="2" />
      <path d="M12 4.5v11" />
    </svg>
  )
}

/**
 * 一行卡片的外壳：左侧方块、中间名称与说明、右侧控件。
 * @param props - 行内各部件与是否关闭态。
 * @returns 一行设置。
 */
function CardRow(props: {
  /** 行标识，落到 data-dsh-part 上供测试与皮肤锚定。 */
  part: string
  /** 左侧标记的品牌色（方块底色按它淡染）。 */
  brand: string
  /** 左侧标记。 */
  mark: ReactNode
  /** 名称。 */
  name: string
  /** 名称下方那一行说明。 */
  note: string
  /** 说明是否按错误色渲染（写入被拒时用）。 */
  danger?: boolean
  /** 行是否显示为关闭态（名称与说明变淡）。 */
  enabled?: boolean
  /** 右侧控件。 */
  children: ReactNode
}): ReactNode {
  const { part, brand, mark, name, note, danger, enabled, children } = props
  return (
    <div
      className="dsh-progress-card"
      data-dsh-part={part}
      data-enabled={enabled === false ? 'false' : 'true'}
    >
      <span
        className="dsh-progress-brand-tile"
        aria-hidden="true"
        style={{ width: 40, height: 40, ['--dsh-progress-brand' as string]: brand }}
      >
        {mark}
      </span>
      <span className="dsh-progress-card-copy">
        <span className="dsh-progress-card-name">{name}</span>
        <span className={danger === true ? 'dsh-progress-card-note dsh-progress-note-danger' : 'dsh-progress-card-note'}>
          {note}
        </span>
      </span>
      <span className="dsh-progress-card-side">{children}</span>
    </div>
  )
}

/**
 * 进展更新的设置分区：四行卡片。
 * @param props - 壳的关闭回调、注入的打开动作与表单、文案座位。
 * @returns 设置页里的这一页。
 */
export function ProgressUpdatesSettingsSection(props: ProgressUpdatesSettingsProps): ReactNode {
  const { openPanel, close, settings, t } = props
  const translate = (key: string): string => (t === undefined ? fallbackTranslate(key) : t(key as never))

  // 表单快照走 useSyncExternalStore：宿主接受写入后表单会重发快照，开关与输入框
  // 因此显示的是**宿主真正接受的值**，而不是本组件乐观猜的值。通道缺席时挂一组
  // 恒定的空座位——hook 不能有条件地少调。
  const snapshot = useSyncExternalStore(
    settings?.subscribe ?? NO_SETTINGS_SUBSCRIBE,
    settings?.getSnapshot ?? NO_SETTINGS_READ,
    settings?.getSnapshot ?? NO_SETTINGS_READ,
  )

  /** 写入被拒/失败时落在哪一行、说什么。 */
  const [failure, setFailure] = useState<{ row: 'enabled' | 'threshold' | 'language', text: string } | undefined>(undefined)

  const value = snapshot.value ?? {}
  // 没有表单通道，或宿主还没答上来/明确说这份文档不收写入：都只能只读。
  const writable = settings !== undefined && snapshot.status === 'ready' && snapshot.writable
  const enabled = value.progressUpdates !== false
  const threshold = typeof value.progressUpdatesNudgeThreshold === 'number'
    ? value.progressUpdatesNudgeThreshold
    : NUDGE_THRESHOLD_DEFAULT
  // 语言只有三个合法取值；读不到（老配置）就是 auto，与宿主 schema 的默认一致。
  const language: ProgressUpdatesLanguage = value.progressUpdatesLanguage === 'zh' || value.progressUpdatesLanguage === 'en'
    ? value.progressUpdatesLanguage
    : 'auto'

  // 输入框的草稿文本：宿主没有立刻接受时（例如打了个超出范围的半截数字），
  // 输入框仍要显示用户敲的东西，而不是弹回旧值。宿主值一变就重新同步。
  const [draft, setDraft] = useState(() => String(threshold))
  useEffect(() => { setDraft(String(threshold)) }, [threshold])

  /**
   * 写一个字段；宿主拒绝、传输失败、没有通道都落到该行的说明行上。
   * @param row - 出问题的是哪一行。
   * @param field - 字段名（本插件 Config 的根字段）。
   * @param next - 新值。
   */
  const write = (row: 'enabled' | 'threshold' | 'language', field: ProgressUpdatesField, next: boolean | number | string): void => {
    setFailure(undefined)
    if (settings === undefined) {
      setFailure({ row, text: translate('settingsUnavailable') })
      return
    }
    let answer: Promise<boolean>
    try {
      answer = settings.set(field, next)
    } catch (error) {
      setFailure({ row, text: error instanceof Error ? error.message : String(error) })
      return
    }
    // false 是契约里的拒绝/跳过答复（宿主不收这个值、条目不可写），必须让用户
    // 看见，否则没落地的值会读成已生效。
    void Promise.resolve(answer).then(
      (accepted) => {
        if (!accepted) setFailure({ row, text: translate('settingsSaveFailed') })
        return undefined
      },
      (error: unknown) => {
        setFailure({ row, text: error instanceof Error ? error.message : String(error) })
        return undefined
      },
    )
  }

  /**
   * 阈值输入：只有落进 1..50 的整数才提交，半截输入不打扰宿主。
   * @param raw - 输入框的原始文本。
   */
  const editThreshold = (raw: string): void => {
    setDraft(raw)
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed < NUDGE_THRESHOLD_MIN || parsed > NUDGE_THRESHOLD_MAX) return
    write('threshold', 'progressUpdatesNudgeThreshold', parsed)
  }

  /** 打开面板再收起设置。 */
  const open = (): void => {
    // 先开面板再关设置：顺序反过来的话，壳一收起来面板会跟着那一帧一起丢焦点。
    try {
      openPanel()
    } catch {
      // 没装右侧栏时打开必然抛错；设置页不该因此整页报错。
    }
    try {
      close()
    } catch {
      // 壳的关闭回调缺失或已失效：按钮本身仍然完成了一次打开。
    }
  }

  const unavailable = settings === undefined ? translate('settingsUnavailable') : undefined

  return (
    <div className="dsh-progress-overview" data-dsh-plugin="progress-updates" data-dsh-part="settings">
      <p className="dsh-progress-hint" data-dsh-part="settings-hint">{translate('settingsHint')}</p>
      <div className="dsh-progress-cards">
        <CardRow
          part="settings-row-enabled"
          brand="#4d6bfe"
          mark={<ProgressMark />}
          name={translate('settingsEnabledName')}
          note={unavailable
            ?? (failure?.row === 'enabled' ? failure.text : translate('settingsEnabledNote'))}
          danger={failure?.row === 'enabled' || unavailable !== undefined}
          enabled={enabled}
        >
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={translate('settingsEnabledName')}
            className="dsh-progress-switch"
            data-dsh-part="settings-switch"
            disabled={!writable}
            onClick={() => { write('enabled', 'progressUpdates', !enabled) }}
          />
        </CardRow>

        <CardRow
          part="settings-row-threshold"
          brand="#2f9e6e"
          mark={<ThresholdMark />}
          name={translate('settingsThresholdName')}
          note={failure?.row === 'threshold' ? failure.text : translate('settingsThresholdNote')}
          danger={failure?.row === 'threshold'}
        >
          <input
            type="number"
            inputMode="numeric"
            min={NUDGE_THRESHOLD_MIN}
            max={NUDGE_THRESHOLD_MAX}
            step={1}
            className="dsh-progress-number"
            data-dsh-part="settings-threshold"
            aria-label={translate('settingsThresholdName')}
            value={draft}
            disabled={!writable}
            onChange={(event) => { editThreshold(event.target.value) }}
            onBlur={() => { setDraft(String(threshold)) }}
          />
        </CardRow>

        <CardRow
          part="settings-row-language"
          brand="#c26d2f"
          mark={<LanguageMark />}
          name={translate('settingsLanguageName')}
          note={failure?.row === 'language' ? failure.text : translate('settingsLanguageNote')}
          danger={failure?.row === 'language'}
        >
          <select
            className="dsh-progress-select"
            data-dsh-part="settings-language"
            aria-label={translate('settingsLanguageName')}
            value={language}
            disabled={!writable}
            onChange={(event) => { write('language', 'progressUpdatesLanguage', event.target.value) }}
          >
            <option value="auto">{translate('settingsLanguageAuto')}</option>
            <option value="zh">{translate('settingsLanguageZh')}</option>
            <option value="en">{translate('settingsLanguageEn')}</option>
          </select>
        </CardRow>

        <CardRow
          part="settings-row-panel"
          brand="#7c6aef"
          mark={<PanelMark />}
          name={translate('settingsPanelName')}
          note={translate('settingsPanelNote')}
        >
          <button
            type="button"
            className="dsh-progress-open"
            data-dsh-part="settings-open"
            onClick={open}
          >
            {translate('settingsOpen')}
          </button>
          <span className="dsh-progress-chevron" aria-hidden="true"><Chevron /></span>
        </CardRow>
      </div>
    </div>
  )
}
