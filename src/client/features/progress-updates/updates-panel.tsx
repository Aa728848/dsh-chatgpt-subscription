/**
 * 进展更新面板：把 `progress_update` 工具产生的进展按时间顺序列出来。
 *
 * 交互照 Kimi Code：**最新一条默认展开，更早的自动收起，点标题可切换**。
 * 每条只显示一行标题；展开时才渲染详情正文（保留换行，不做完整 Markdown
 * 渲染 —— 契约里限定的就是「一段正文 + 少量 bullet」）。
 *
 * 数据源：纯展示组件只认一个 `updates` 数组 prop（见 {@link UpdatesPanelProps}）。
 * 真实的取数通道是宿主路由 `GET /api/dsh-progress-updates/updates?session=<id>`，
 * 浏览器半边的轮询客户端在 `./host-source.ts`（`createHostProgressSource`），它
 * 把结果包成 {@link ProgressSnapshotSource} 交给入口。{@link EMPTY_SOURCE} 只剩
 * 两个用途：没有会话身份时的兜底，以及测试里的空快照参照。
 *
 * 文案全部走 locale（本插件 `dsh-progress-updates` 命名空间），文件里不出现
 * 硬编码中文。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/updates-panel
 */

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { MarkdownLite } from './markdown-lite.tsx'
import type { ProgressUpdate } from './contracts.ts'
import { NS_PROGRESS_UPDATES, zh, type ProgressUpdatesLocaleKey } from './locales.ts'

/**
 * 注入的文案座位。
 *
 * 框架在声明了 `locale` 的注册里总会给 `t`；这里标成可选是为了让同一份组件
 * 也能在没有 locale 座位的场合（jsdom 测试、故事预览）直接渲染，缺省时走
 * {@link fallbackTranslate}。参数收得更宽不影响槽位注册处的类型检查。
 */
export type CopySeat = {
  /** 命名空间化的翻译函数；缺席时走本文件的中文兜底。 */
  t?: (key: ProgressUpdatesLocaleKey) => string
}

/**
 * 兜底翻译：只在本组件被渲染在 slot 框架之外时用到（jsdom 测试、故事预览）。
 * 走同一份 zh 字典，因此不存在第二套文案。框架内渲染时用注入的 `t` 座位，
 * 这样第三方语言包也能生效。
 * @param key - `dsh-progress-updates` 命名空间的键。
 * @param params - `{name}` 模板参数。
 * @returns 该键的文案；缺键时回退为键本身。
 */
export function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  return interpolate((zh as Record<string, string>)[key] ?? key, params)
}

/**
 * 把 `{name}` 占位符换成实参。
 *
 * 单独成一个函数，是因为**两条取值路径都要用它**：没有 locale 服务的兜底字典，
 * 和有服务时的当前语言字典。早先只有兜底那条做了替换，于是真实部署里
 * 「共 {n} 条」原样上屏。
 * @param template - 含占位符的模板。
 * @param params - 各占位符的实参。
 * @returns 替换后的文本；没有 params 时原样返回。
 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  let text = template
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}



/** 面板的数据源面：一份只读快照 + 变更订阅。 */
export interface ProgressSnapshotSource {
  /**
   * 读取当前快照；必须返回稳定引用（同一次变更内多次读取返回同一对象），
   * 否则 `useSyncExternalStore` 会判为无限更新。
   */
  getSnapshot(): readonly ProgressUpdate[]
  /** 订阅变更，返回退订函数。 */
  subscribe(listener: () => void): () => void
}

/** 一份空进展快照。 */
export const EMPTY_UPDATES: readonly ProgressUpdate[] = Object.freeze([])

/**
 * 空数据源：恒为空数组，永不通知变更。
 *
 * 它是一份**真正的空态**（不是伪造出来的假数据流）：真实的取数通道是
 * `./host-source.ts` 的轮询客户端，只有拿不到任何来源时才回退到这里。
 */
export const EMPTY_SOURCE: ProgressSnapshotSource = Object.freeze({
  getSnapshot: () => EMPTY_UPDATES,
  subscribe: () => () => {},
})

/**
 * 把一份可观察的裸快照（宿主路由的轮询结果，或任何别的读取通道）包成面板要的
 * 数据源。
 * @param read - 读取当前进展列表（必须返回稳定引用）。
 * @param listen - 订阅变更，返回退订函数。
 * @returns 面板可消费的数据源。
 */
export function createSnapshotSource(
  read: () => readonly ProgressUpdate[],
  listen: (listener: () => void) => () => void,
): ProgressSnapshotSource {
  return { getSnapshot: read, subscribe: listen }
}

/** 组件 props：只有一份进展数组，外加可选的注入文案座位。 */
export type UpdatesPanelProps = {
  /** 已展示的进展，按产生顺序排列（最后一条是最新）。 */
  updates: readonly ProgressUpdate[]
} & CopySeat

/** 面板容器样式。 */
const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px 16px',
  minHeight: '0',
  overflowY: 'auto',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
}

/** 一条进展的外框样式。 */
const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  border: '1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%))',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-1, rgb(255 255 255 / 60%))',
  padding: '8px 10px',
}

/** 行标题按钮样式（整行可点，去掉原生按钮外观）。 */
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  width: '100%',
  padding: '0',
  border: '0',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

/** 标题文本样式。 */
const titleStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: '0',
  fontSize: '12px',
  fontWeight: 500,
  lineHeight: '1.5',
  overflowWrap: 'anywhere',
}

/** 时间戳/徽标的小字样式。 */
const metaStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '11px',
  lineHeight: '1.5',
  color: 'var(--dsw-alias-label-tertiary, #8a9099)',
}

/**
 * 展开行正文的容器样式。
 *
 * 正文本身交给平台的 `MarkdownText` 渲染（GFM、列表、行内代码、表格、KaTeX 全都在
 * 那一套里），这里只负责外边距、字号与颜色：`pre-wrap` 与手写解析都撤掉了，
 * 因为 Markdown 的块级结构必须由渲染器产出的元素决定，纯文本的换行保留只会把
 * 列表符号与星号原样显示出来。
 */
const messageStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: '13px',
  lineHeight: '1.6',
  color: 'var(--dsw-alias-label-secondary, #5b6270)',
}

/** 空态容器样式。 */
const emptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '16px 4px',
  color: 'var(--dsw-alias-label-tertiary, #8a9099)',
}

/**
 * 一天的短格式时间（HH:MM）。只输出数字与分隔符，与语言无关。
 * @param at - Unix 毫秒时间戳。
 * @returns 本地时区的 HH:MM；非法时间戳返回空串。
 */
function clockOf(at: number): string {
  if (!Number.isFinite(at)) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * 标题行文本：没有 title 时用正文首行，保证每行都有一个可读标题。
 * @param update - 一条进展。
 * @returns 标题文本。
 */
function titleOf(update: ProgressUpdate): string {
  if (update.title !== undefined && update.title.trim() !== '') return update.title
  const firstLine = update.message.split('\n').find((line) => line.trim() !== '')
  return firstLine ?? ''
}

/**
 * 展开指示箭头，跟随展开状态旋转。
 * @param props - 是否展开。
 * @returns 装饰性箭头图标。
 */
function Chevron({ expanded }: { expanded: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flex: '0 0 auto', marginTop: '3px', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  )
}

/**
 * 侧栏进展面板（纯展示）。
 * @param props - 进展数组与可选的注入文案座位。
 * @returns 进展列表；没有进展时渲染占位空态。
 */
export function ProgressUpdatesPanel({ updates, t }: UpdatesPanelProps): ReactNode {
  /**
   * 翻译并**补齐占位符**。
   *
   * locale 服务交来的 `t` 只接受一个键、不做插值，所以参数必须在这一层补上：
   * 直接把 `t(key)` 当作结果会留下原样的 `{n}`（线上真出现过「共 {n} 条」）。
   * 先按当前语言的字典取值（没有 `t` 时才用兜底字典），再统一做一次替换。
   */
  const translate = (key: string, params?: Record<string, unknown>): string => {
    const template = t === undefined
      ? (zh as Record<string, string>)[key] ?? key
      : t(key as ProgressUpdatesLocaleKey)
    return interpolate(template, params)
  }
  const latestId = updates.length > 0 ? updates[updates.length - 1].id : undefined
  /**
   * 展开的进展集合 —— **不是**单个 id。
   *
   * 早先这里是单值 `expandedId`，于是展开下面那条会把上面那条关掉：用户想对照着
   * 看两条进展时永远只能看到一条。展开是逐条的独立选择，所以用集合。
   *
   * 只写「显式展开过/收起过」的状态，不在渲染期推导：一条新进展到达时，把最新的
   * 那条追加进集合（默认展开最新），但**不动**用户已经展开的其它条目。
   */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(latestId === undefined ? [] : [latestId]),
  )
  useEffect(() => {
    if (latestId === undefined) return
    setExpandedIds((current) => {
      if (current.has(latestId)) return current
      const next = new Set(current)
      next.add(latestId)
      return next
    })
  }, [latestId])

  const idPrefix = useId()

  if (updates.length === 0) {
    return (
      <div data-dsh-plugin="progress-updates" data-dsh-part="updates" style={panelStyle}>
        <div data-dsh-part="updates-empty" style={emptyStyle} role="status">
          <strong style={{ fontSize: '12px', fontWeight: 500 }}>{translate('progressEmptyTitle')}</strong>
          <span>{translate('progressEmptyHint')}</span>
        </div>
      </div>
    )
  }

  return (
    <div data-dsh-plugin="progress-updates" data-dsh-part="updates" style={panelStyle}>
      <div data-dsh-part="updates-count" style={metaStyle}>{translate('progressCount', { n: updates.length })}</div>
      <ol
        data-dsh-part="updates-list"
        style={{ listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '8px' }}
      >
        {updates.map((update, index) => {
          const expanded = expandedIds.has(update.id)
          const latest = update.id === latestId
          const title = titleOf(update)
          const bodyId = `${idPrefix}-${index}-body`
          const clock = clockOf(update.at)
          const toggleLabel = translate(expanded ? 'progressCollapse' : 'progressExpand')
          return (
            <li key={update.id} data-dsh-part="update" data-update-id={update.id} style={rowStyle}>
              <button
                type="button"
                data-dsh-part="update-header"
                aria-expanded={expanded}
                aria-controls={bodyId}
                aria-label={toggleLabel}
                title={toggleLabel}
                style={headerStyle}
                onClick={() => {
                  setExpandedIds((current) => {
                    const next = new Set(current)
                    if (next.has(update.id)) next.delete(update.id)
                    else next.add(update.id)
                    return next
                  })
                }}
              >
                <Chevron expanded={expanded} />
                <span data-dsh-part="update-title" style={titleStyle}>{title}</span>
                {latest && (
                  <span data-dsh-part="update-badge" style={{ ...metaStyle, color: 'var(--dsw-alias-brand-primary, #4d6bfe)' }}>
                    {translate('progressLatest')}
                  </span>
                )}
                {clock !== '' && <time dateTime={new Date(update.at).toISOString()} style={metaStyle}>{clock}</time>}
              </button>
              {expanded && (
                <div id={bodyId} data-dsh-part="update-message" style={messageStyle}>
                  <MarkdownLite text={update.message} />
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 面板正文收到的注入面：一个已绑定的数据源。 */
export interface ProgressPanelInjected {
  /** 侧栏面板的进展数据源。 */
  source: ProgressSnapshotSource
}

/**
 * 面板正文的槽位组件：把注入的数据源接到纯展示组件上。
 *
 * 用 `useSyncExternalStore` 订阅而不是直接读一次快照：轮询源每次拿到新进展都会
 * 通知，这里自动重渲染；展示组件本身不关心数据是怎么来的。
 * @param props - 框架注入的数据源与文案座位。
 * @returns 进展面板。
 */
export function ProgressUpdatesTab(props: ProgressPanelInjected & CopySeat): ReactNode {
  const { source, t } = props
  const updates = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  return <ProgressUpdatesPanel updates={updates} t={t} />
}

/**
 * 页签标题的槽位组件：标签条上显示的那几个字。
 * @param props - 框架注入的文案座位。
 * @returns 面板标题文本。
 */
export function ProgressUpdatesTabTitle({ t }: CopySeat): ReactNode {
  const label = t === undefined ? fallbackTranslate('progressTitle') : t('progressTitle')
  return <>{label}</>
}

/** 本模块的命名空间，供注册处引用。 */
export { NS_PROGRESS_UPDATES }
