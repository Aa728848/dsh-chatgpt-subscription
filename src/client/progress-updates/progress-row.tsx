/**
 * 对话流里的「进展行」——本插件的主形态。
 *
 * agent 每发一条进展，对话里就多一行：标题行（状态点 + 标题 + 状态词）常显，
 * 正文默认收起，点标题展开。侧栏面板是它的**汇总视图**，这个视图才是用户真正
 * 会一直盯着看的东西。
 *
 * ## 三个阶段的读法
 *
 * `tool.call.toolview` 的 `block` 是阶段相关的（平台在 harness 0.1.7-rc.1 之后
 * 交来 preparing / start / result 三态）：
 * - `phase: 'preparing'` —— 参数还在流式生成，只有前缀视图，没有 `argsRaw`；
 * - `phase: 'start'` —— 参数完整（`argsRaw`），结果还没回来；
 * - `'kind' in block`（`tool-result`）—— 已结算，`isError` 决定是成功还是失败。
 *
 * 参数三个阶段的读法不同，所以 {@link argOf} 先试前缀视图（`args.text`），再退回
 * `argsRaw` 的 JSON 解析——与同目录的 `CodexImageToolView.promptFromBlock` 同款，
 * 因为它要面对的正是同一批阶段形状。
 *
 * 组件只读它真正用到的几个字段，不写 `PropsRuntime<'tool.call.toolview'>`：那个
 * 类型的 owner 面由 ui-tool 合并，本插件不依赖它；反过来，写窄一点也让这份视图
 * 能在没有槽位框架的场合（jsdom 测试）直接渲染。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/progress-row
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import type { ProgressUpdate } from './contracts.ts'
import { MarkdownLite } from './markdown-lite.tsx'
import { fallbackTranslate, type CopySeat } from './updates-panel.tsx'

/**
 * 一次工具调用在当前阶段交来的内容块。
 *
 * 只声明本视图真正读的字段：三个阶段共有 `callId` / `name` / `args`，另外
 * start 阶段有 `argsRaw`，结算后有 `kind` / `isError`。
 */
export interface ProgressRowBlock {
  /** 调用 id，三个阶段不变。 */
  callId?: string
  /** 线上工具名。 */
  name?: string
  /** 参数视图：流式阶段给到目前已到的前缀。 */
  args?: {
    /**
     * 读一个字符串参数。
     * @param key - 参数名。
     * @returns 该参数当前的文本；缺失或类型不是字符串时 undefined。
     */
    text?: (key: string) => string | undefined
  }
  /** 参数已完整时的完整 JSON 文本。 */
  argsRaw?: string
  /** 已结算时的块判别值。 */
  kind?: string
  /** 已结算时：这次调用是否失败。 */
  isError?: boolean
}

/** 状态点的颜色：运行中品牌色、成功绿、失败红。 */
const DOT_COLORS = {
  running: 'var(--dsw-alias-brand-primary, #4d6bfe)',
  done: 'var(--dsw-alias-state-success-primary, #2ba471)',
  error: 'var(--dsw-alias-state-error-primary, #d54941)',
} as const

/** 一行的状态：三选一。 */
export type ProgressRowState = keyof typeof DOT_COLORS

/** 状态对应的文案键。 */
const STATE_KEYS: Record<ProgressRowState, string> = {
  running: 'rowRunning',
  done: 'rowDone',
  error: 'rowError',
}

/** 行的外框样式。 */
const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  width: '100%',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
}

/** 标题行按钮样式（整行可点，去掉原生按钮外观）。 */
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
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

/** 状态词的小字样式。 */
const stateStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '11px',
  lineHeight: '1.5',
  color: 'var(--dsw-alias-label-tertiary, #8a9099)',
}

/**
 * 正文样式：只管外边距、字号与颜色。
 *
 * **不再**在这里写 `whiteSpace: 'pre-wrap'`：正文交给 {@link MarkdownLite} 渲染，
 * 换行该不该保留由它产出的块级元素决定。早先这里是纯文本 `<p>{message}</p>`，
 * 于是列表符号、`**粗体**` 和管道符表格全部原样上屏 —— 同一份进展在侧栏面板里
 * 是渲染过的、在对话流里是原文，两处观感对不上。
 */
const messageStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  margin: '0',
  fontSize: '12px',
  lineHeight: '1.55',
  color: 'var(--dsw-alias-label-secondary, #5b6270)',
}

/**
 * 阶段判定：`'kind' in block` 即已结算（与官方视图同一条判据）。
 * @param block - 当前阶段的内容块。
 * @returns 是否已结算。
 */
function isSettled(block: ProgressRowBlock): boolean {
  return block.kind !== undefined
}

/**
 * 读一个字符串参数：先试前缀视图，再退回完整参数 JSON。
 * @param block - 当前阶段的内容块。
 * @param key - 参数名。
 * @returns 读到就返回文本；都没有时 undefined。
 */
function argOf(block: ProgressRowBlock, key: string): string | undefined {
  const read = block.args?.text
  if (typeof read === 'function') {
    try {
      const value = read.call(block.args, key)
      if (typeof value === 'string') return value
    } catch {
      // 参数视图在流式中途读失败：退回 argsRaw，不把界面带下水。
    }
  }
  if (typeof block.argsRaw !== 'string' || block.argsRaw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(block.argsRaw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const value = (parsed as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一次工具调用折成一行进展。
 * @param block - 当前阶段的内容块。
 * @returns 进展形状（id/时间戳不在参数里，故只取标题与正文）。
 */
export function progressOfBlock(block: ProgressRowBlock): Pick<ProgressUpdate, 'title' | 'message'> {
  const message = argOf(block, 'message') ?? ''
  const title = argOf(block, 'title')
  return {
    message,
    ...(title === undefined || title.trim() === '' ? {} : { title: title.trim() }),
  }
}

/**
 * 本视图的 props：内容块 + 文案座位。
 *
 * 框架会另外注入 `callId` / `useDisclosure` / `openFile` 等标准座位；本视图一个
 * 都不用，所以这里只声明它读的那两项，多余字段在结构类型下自动兼容。
 */
export type ProgressRowProps = {
  /** 本次调用在当前阶段的内容块。 */
  block: ProgressRowBlock
} & CopySeat

/**
 * 对话流里的一行进展。
 * @param props - 内容块与文案座位。
 * @returns 一行进展；标题行常显，正文按交互展开。
 */
export function ProgressRow({ block, t }: ProgressRowProps): ReactNode {
  const translate = (key: string): string =>
    t === undefined ? fallbackTranslate(key) : t(key as Parameters<NonNullable<ProgressRowProps['t']>>[0])
  const settled = isSettled(block)
  const state: ProgressRowState = settled ? (block.isError === true ? 'error' : 'done') : 'running'
  const { title, message } = progressOfBlock(block)
  const heading = title ?? message.split('\n').find((line) => line.trim() !== '') ?? translate('rowPending')
  const [expanded, setExpanded] = useState(false)
  const label = translate(expanded ? 'rowCollapse' : 'rowExpand')

  return (
    <div data-dsh-plugin="progress-updates" data-dsh-part="progress-row" data-state={state} style={rowStyle}>
      <button
        type="button"
        data-dsh-part="progress-row-header"
        aria-expanded={expanded}
        aria-label={label}
        title={label}
        style={headerStyle}
        onClick={() => { setExpanded((open) => !open) }}
      >
        <span
          aria-hidden="true"
          data-dsh-part="progress-row-dot"
          style={{ flex: '0 0 auto', width: '6px', height: '6px', borderRadius: '50%', background: DOT_COLORS[state] }}
        />
        <span data-dsh-part="progress-row-title" style={titleStyle}>{heading}</span>
        <span data-dsh-part="progress-row-state" style={stateStyle}>{translate(STATE_KEYS[state])}</span>
      </button>
      {expanded && message !== '' && (
        <div data-dsh-part="progress-row-message" style={messageStyle}>
          <MarkdownLite text={message} />
        </div>
      )}
    </div>
  )
}
