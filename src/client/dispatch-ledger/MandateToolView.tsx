/**
 * `subagent` / `subagent_fork` 在对话流里的**派发卡片**。
 *
 * ## 为什么要有这张卡
 *
 * DSH 的通用工具行把调用参数当纯文本铺开，而派发的参数是一段 `dsh-mandate-v2`
 * 围栏 + JSON 头 + 任务正文：几十行挤在窄栏里，brief / run / 路由 / 边界谁也扫不出来，
 * 而一旦被守卫拒，拒绝码又埋在那团文本里。这张卡把头部拆成结构，把结果与
 * `MANDATE_*` 拒绝码单独留在醒目位置。
 *
 * ## 一旦占用 key，整行就是我们渲染
 *
 * `tool.call.toolview` 是按工具名键控的槽，「占用即替换」。所以**结果文本必须自己画**
 * （被拒的调用只有那段错误是唯一有用信息），并且保留一个「原始参数」开关：
 * 出问题时能拿到完整证据，不因为换了呈现而丢信息。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/dispatch-ledger/MandateToolView
 */

import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { zh, type DispatchLedgerLocaleKey } from './locales.ts'

/** 结果内容块（只用到文本）。 */
export interface MandateContentBlock {
  readonly type?: string
  readonly text?: string
}

/** 槽传给视图的那份 phase 数据。 */
export interface MandateBlock {
  readonly callId?: string
  readonly phase?: 'preparing' | 'start' | 'result' | string
  readonly kind?: string
  readonly isError?: boolean
  readonly content?: readonly MandateContentBlock[]
  readonly argsRaw?: string
  readonly call?: { readonly name?: string; readonly argsRaw?: string }
  readonly args?: {
    readonly text?: (key: string) => unknown
    readonly complete?: (key: string) => boolean
  }
}

/** 展开状态（复用宿主传下来的 `useDisclosure`）。 */
export interface MandateDisclosure {
  readonly expanded: boolean
  readonly toggle: () => void
}

/** 卡片收到的 props（槽位环境另带若干字段）。 */
export interface MandateToolViewProps {
  readonly callId?: string
  readonly toolName?: string
  readonly phase?: string
  readonly block?: MandateBlock
  readonly useDisclosure?: (() => MandateDisclosure) | undefined
  readonly t?: ((key: DispatchLedgerLocaleKey) => string) | undefined
  readonly [key: string]: unknown
}

/** 头部围栏的开场标记。 */
const MANDATE_FENCE = '```dsh-mandate-v2'

/** 头部围栏的收尾标记。 */
const FENCE_CLOSE = '```'

function fallbackTranslate(key: DispatchLedgerLocaleKey): string {
  return zh[key]
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  const head = nl === -1 ? text : text.slice(0, nl)
  return head.trim()
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** 从原始参数 JSON 或流式参数视图里读出参数对象。 */
export function mandateArgsOf(block: MandateBlock): Record<string, unknown> {
  for (const raw of [block.argsRaw, block.call?.argsRaw]) {
    if (typeof raw !== 'string' || raw === '') continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 参数还在流式生成，退回逐字段读取。
    }
  }
  const out: Record<string, unknown> = {}
  const readText = block.args?.text
  if (typeof readText === 'function') {
    const keys = ['prompt', 'description', 'provider', 'model', 'reasoning_effort'] as const
    for (const key of keys) {
      try {
        const value = readText.call(block.args, key)
        if (typeof value === 'string' && value !== '') out[key] = value
      } catch {
        // 未完成的转义序列：忽略这个字段即可。
      }
    }
  }
  return out
}

/** 一份拆开的派发：头部（解析失败时为 null）、正文、以及原始提示词。 */
export interface ParsedDispatch {
  readonly header: Record<string, unknown> | null
  readonly body: string
  readonly rawPrompt: string
}

/**
 * 拆开 `subagent.prompt`：围栏在最前面时解析头部，其后是任务正文。
 * @param prompt - 提示词原文。
 * @returns 头部、正文与原文。
 */
export function parseDispatchPrompt(prompt: string): ParsedDispatch {
  const trimmed = prompt.trimStart()
  if (!trimmed.startsWith(MANDATE_FENCE) || !trimmed.slice(MANDATE_FENCE.length).startsWith('\n')) {
    return { header: null, body: trimmed, rawPrompt: prompt }
  }
  const after = trimmed.slice(MANDATE_FENCE.length + 1)
  const close = after.indexOf('\n' + FENCE_CLOSE)
  if (close < 0) return { header: null, body: trimmed, rawPrompt: prompt }
  try {
    const header: unknown = JSON.parse(after.slice(0, close))
    if (typeof header !== 'object' || header === null || Array.isArray(header)) {
      return { header: null, body: trimmed, rawPrompt: prompt }
    }
    const body = after.slice(close + 1 + 3).replace(/^\n/, '')
    return { header: header as Record<string, unknown>, body, rawPrompt: prompt }
  } catch {
    return { header: null, body: trimmed, rawPrompt: prompt }
  }
}

/** 结果区文本：成功是「started subagent …」，被拒是整段拒绝说明。 */
export function mandateResultText(block: MandateBlock): string {
  return (block.content ?? []).map(entry => asText(entry.text)).join('\n').trim()
}

type MandateState = 'preparing' | 'running' | 'ok' | 'error'

function resolveState(phase: string | undefined, block: MandateBlock): MandateState {
  if (phase === 'preparing' || block.phase === 'preparing') return 'preparing'
  if (block.kind !== undefined || block.isError !== undefined || phase === 'result') {
    return block.isError === true ? 'error' : 'ok'
  }
  return 'running'
}

function useFallbackDisclosure(): MandateDisclosure {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => { setExpanded(prev => !prev) }, [])
  return { expanded, toggle }
}

function Chevron({ open }: { readonly open: boolean }): React.JSX.Element {
  return (
    <span className="dshc-mandate-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
  )
}

/** 派发卡片。 */
export function MandateToolView(props: MandateToolViewProps): React.JSX.Element {
  const block = props.block ?? {}
  const t = props.t ?? fallbackTranslate
  // Hook 顺序恒定：槽位环境恒传 useDisclosure，单测无槽位时走本地 state。
  const disclosureHook = props.useDisclosure ?? useFallbackDisclosure
  const { expanded, toggle } = disclosureHook()
  const [rawShown, setRawShown] = useState(false)

  const args = useMemo(() => mandateArgsOf(block), [block])
  const prompt = asText(args['prompt'])
  const parsed = useMemo(() => parseDispatchPrompt(prompt), [prompt])
  const result = useMemo(() => mandateResultText(block), [block])
  const state = resolveState(props.phase ?? block.phase, block)

  const header = parsed.header
  const brief = header === null ? '' : asText(header['brief_id'])
  const run = header === null ? '' : asText(header['run_id'])
  const idem = header === null ? '' : asText(header['idem'])
  const route = [asText(args['provider']), asText(args['model'])].filter(part => part !== '').join('/')
  const effort = asText(args['reasoning_effort'])
  const task = header === null ? [] : asLines(header['task'])
  const boundary = header === null ? [] : asLines(header['boundary'])
  const followup = header === null ? [] : asLines(header['followup'])
  const description = asText(args['description'])
  const body = parsed.body
  const isFork = (props.toolName ?? block.call?.name ?? '').includes('fork')

  const statusLabel = state === 'preparing'
    ? t('mandatePreparing')
    : state === 'running'
      ? t('mandateRunning')
      : state === 'error'
        ? t('mandateFailed')
        : t('mandateDone')
  const summary = state === 'error'
    ? firstLine(result)
    : (description !== '' ? description : firstLine(body))
  const expandable = state !== 'preparing' && (header !== null || body !== '' || result !== '')

  const onRowKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }, [expandable, toggle])

  return (
    <div
      className="dshc-mandate-root"
      data-tool={props.toolName ?? block.call?.name ?? 'subagent'}
      data-state={state}
    >
      <div className="dshc-mandate-header">
        <div
          className="dshc-mandate-row"
          data-disclosure-row
          data-expandable={expandable ? 'true' : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          aria-label={expandable ? (expanded ? t('mandateCollapse') : t('mandateExpand')) : undefined}
          onClick={expandable ? toggle : undefined}
          onKeyDown={expandable ? onRowKeyDown : undefined}
        >
          {expandable && <Chevron open={expanded} />}
          <span className="dshc-mandate-title">{isFork ? t('mandateTitleFork') : t('mandateTitle')}</span>
          {summary !== '' && <span className="dshc-mandate-summary">{summary}</span>}
          <span className="dshc-mandate-state" data-state={state}>{statusLabel}</span>
        </div>
      </div>

      {expandable && expanded && (
        <div className="dshc-mandate-body">
          {header === null ? (
            <p className="dshc-mandate-note">{t('mandateNoHeader')}</p>
          ) : (
            <>
              <div className="dshc-mandate-chips">
                {[[t('mandateBrief'), brief], [t('mandateRun'), run], [t('mandateIdem'), idem]]
                  .filter(([, value]) => value !== '')
                  .map(([label, value]) => (
                    <span className="dshc-mandate-chip" data-chip={label} key={label}>
                      <span className="dshc-mandate-label">{label}</span>{value}
                    </span>
                  ))}
                {route !== '' && (
                  <span className="dshc-mandate-chip" data-chip="route">
                    <span className="dshc-mandate-label">{t('mandateRoute')}</span>
                    {route}{effort === '' ? '' : ' · ' + effort}
                  </span>
                )}
              </div>
              {task.length > 0 && (
                <div className="dshc-mandate-field">
                  <span className="dshc-mandate-field-key">{t('mandateTask')}</span>
                  <ul className="dshc-mandate-list">
                    {task.map((entry, index) => <li key={'task-' + index}>{entry}</li>)}
                  </ul>
                </div>
              )}
              {boundary.length > 0 && (
                <div className="dshc-mandate-field">
                  <span className="dshc-mandate-field-key">{t('mandateBoundary')}</span>
                  <ul className="dshc-mandate-list">
                    {boundary.map((entry, index) => <li key={'boundary-' + index}>{entry}</li>)}
                  </ul>
                </div>
              )}
              {followup.length > 0 && (
                <div className="dshc-mandate-field">
                  <span className="dshc-mandate-field-key">{t('mandateFollowup')}</span>
                  <ul className="dshc-mandate-list">
                    {followup.map((entry, index) => <li key={'followup-' + index}>{entry}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
          {body !== '' && (
            <div className="dshc-mandate-field">
              <span className="dshc-mandate-field-key">{t('mandateBody')}</span>
              <p className="dshc-mandate-text">{body}</p>
            </div>
          )}
          {result !== '' && (
            <div className="dshc-mandate-field">
              <span className="dshc-mandate-field-key">{t('mandateResult')}</span>
              <p className="dshc-mandate-result" data-error={state === 'error' ? 'true' : undefined}>{result}</p>
            </div>
          )}
          {prompt !== '' && (
            <div>
              <button
                type="button"
                className="dshc-mandate-raw"
                data-role="raw-toggle"
                onClick={() => { setRawShown(prev => !prev) }}
              >
                {rawShown ? t('mandateRawHide') : t('mandateRawShow')}
              </button>
              {rawShown && <pre className="dshc-mandate-rawtext" data-role="raw-text">{prompt}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
