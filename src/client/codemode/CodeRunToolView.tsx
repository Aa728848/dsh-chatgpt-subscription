/**
 * `code_run` 在对话流中的语法高亮工具行组件 —— 对齐宿主内置 PTC `run_code` 的呈现体验。
 *
 * ## 与宿主 `run_code` 一致的四点设计
 *
 * 1. **标题行**：代码图标 `</>` + 本地化标题「代码 / Code」+ `description` 摘要（不再出现
 *    `工具 · code_run · ...`），直接接入框架传入的 `useDisclosure` 控制展开/收起；
 * 2. **源码区**：提取 `args.code` 纯源码文本（剥离外层 JSON 参数包装），提供语言标识
 *    （`typescript` / `python`）、自动换行切换与一键复制源码按钮，并使用宿主 `--shiki-*`
 *    主题色进行语法高亮；
 * 3. **输出区**：已结算结果独立展示在下方 `输出` 卡片中（无结果文本时不画空卡片），子调用由外层
 *    `ToolCallTree` 通过 `tool/ptc-dispatch` 自动挂载在本行下方；
 * 4. **三阶段支持**：覆盖 `preparing`（流式生成参数）、`start`（执行中）与 `result`（成功/失败/停止）。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/codemode/CodeRunToolView
 */

import { Fragment, useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { zh, type LocaleKey } from '../locales.ts'
import { SHIKI_TOKEN_COLORS, tokenizeCodeLines, type CodeLanguage } from './highlight.ts'

export interface CodeRunBlockContent {
  readonly type?: string
  readonly text?: string
  readonly [key: string]: unknown
}

export interface CodeRunBlock {
  readonly callId?: string
  readonly phase?: 'preparing' | 'start' | string
  readonly kind?: string
  readonly isError?: boolean
  readonly error?: {
    readonly name?: string
    readonly code?: string
    readonly reason?: unknown
  }
  readonly content?: readonly CodeRunBlockContent[]
  readonly argsRaw?: string
  readonly call?: {
    readonly name?: string
    readonly argsRaw?: string
  }
  readonly args?: {
    readonly text?: (key: string) => unknown
    readonly complete?: (key: string) => boolean
  }
  readonly meta?: unknown
}

export interface CodeRunDisclosure {
  readonly expanded: boolean
  readonly toggle: () => void
}

export interface CodeRunToolViewProps {
  readonly callId?: string
  readonly toolName?: string
  readonly phase?: 'preparing' | 'start' | 'result' | string
  readonly block: CodeRunBlock
  readonly useDisclosure?: (() => CodeRunDisclosure) | undefined
  readonly inspect?: (() => void) | undefined
  readonly t?: ((key: LocaleKey) => string) | undefined
  readonly [key: string]: unknown
}

type RowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

function fallbackTranslate(key: LocaleKey): string {
  return (zh as Record<string, string>)[key] ?? key
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function rawArgsOf(block: CodeRunBlock): string | undefined {
  if (typeof block.argsRaw === 'string' && block.argsRaw !== '') return block.argsRaw
  if (typeof block.call?.argsRaw === 'string' && block.call.argsRaw !== '') return block.call.argsRaw
  return undefined
}

function parseArgsObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 从流式参数视图或完整 JSON 中读取字段（与 `ProgressRow` / `MinimaxVideoToolView` 一致）。 */
export function extractCodeRunArgs(block: CodeRunBlock): {
  code: string | null
  description: string
  rawFallback: string | null
} {
  let streamCode: string | undefined
  let streamDesc: string | undefined
  const readText = block.args?.text
  if (typeof readText === 'function') {
    try {
      const c = readText.call(block.args, 'code')
      if (typeof c === 'string' && c !== '') streamCode = c
    } catch {
      // ignore incomplete stream escape
    }
    try {
      const d = readText.call(block.args, 'description')
      if (typeof d === 'string' && d !== '') streamDesc = d
    } catch {
      // ignore incomplete stream escape
    }
  }

  const raw = rawArgsOf(block)
  const parsed = parseArgsObject(raw)
  const jsonCode = typeof parsed?.['code'] === 'string' && parsed['code'] !== '' ? parsed['code'] : undefined
  const jsonDesc = typeof parsed?.['description'] === 'string' && parsed['description'] !== '' ? parsed['description'] : undefined

  const code = jsonCode ?? streamCode ?? null
  const description = firstLine(jsonDesc ?? streamDesc ?? '')
  const rawFallback = code === null && raw !== undefined ? raw : null
  return { code, description, rawFallback }
}

/** 展平已结算结果的内容块（对齐宿主 `resultText`）。 */
export function flattenCodeRunOutput(block: CodeRunBlock): string | null {
  if (block.kind === undefined) return null
  const parts: string[] = []
  for (const item of block.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else {
      try {
        parts.push(JSON.stringify(item, null, 2))
      } catch {
        parts.push(String(item))
      }
    }
  }
  if (parts.length === 0 && block.error !== undefined) {
    const errName = block.error.name ?? 'Error'
    const errCode = block.error.code ?? 'UNKNOWN'
    parts.push(`${errName}: ${errCode}`)
  }
  const joined = parts.join('\n')
  return joined === '' ? null : joined
}

function resolveLanguage(meta: unknown): CodeLanguage {
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    const lang = (meta as Record<string, unknown>)['language']
    if (lang === 'python') return 'python'
  }
  return 'typescript'
}

function resolveState(phase: string | undefined, block: CodeRunBlock): RowState {
  const done = block.kind !== undefined || phase === 'result'
  if (!done) {
    return block.phase === 'preparing' || phase === 'preparing' ? 'preparing' : 'running'
  }
  if (block.error?.code === 'interrupted') return 'stopped'
  const stopped = typeof block.meta === 'object' && block.meta !== null && !Array.isArray(block.meta)
    && (block.meta as Record<string, unknown>)['stopped'] === true
  if (block.isError === true || stopped) return 'error'
  return 'ok'
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back to execCommand below.
  }
  if (typeof document === 'undefined') return false
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

function useFallbackDisclosure(): CodeRunDisclosure {
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => { setExpanded((prev) => !prev) }, [])
  return { expanded, toggle }
}

export function CodeRunToolView(props: CodeRunToolViewProps): React.JSX.Element {
  const { block, phase, inspect, useDisclosure } = props
  const t = props.t ?? fallbackTranslate
  // Hook 调用顺序保持稳定：槽位环境恒传 useDisclosure，单测无槽位时恒走本地 state。
  const disclosureHook = useDisclosure ?? useFallbackDisclosure
  const { expanded, toggle } = disclosureHook()
  const [wrapped, setWrapped] = useState(true)
  const [copied, setCopied] = useState(false)

  const state = resolveState(phase, block)
  const { code, description, rawFallback } = useMemo(() => extractCodeRunArgs(block), [block])
  const outputText = useMemo(() => flattenCodeRunOutput(block), [block])
  const language = useMemo(() => resolveLanguage(block.meta), [block.meta])

  const sourceText = code ?? rawFallback
  const expandable = state !== 'preparing' && (sourceText !== null || outputText !== null)
  const open = expanded && expandable
  const running = state === 'preparing' || state === 'running'

  const errorLine = state === 'error' && outputText !== null ? firstLine(outputText) : null
  const summaryText = errorLine ?? (description !== '' ? description : (block.callId ?? ''))

  const highlightedLines = useMemo(
    () => (open && sourceText !== null ? tokenizeCodeLines(sourceText, language) : null),
    [open, sourceText, language],
  )

  const onCopy = useCallback(() => {
    if (copied || sourceText === null) return
    const trimmed = sourceText.endsWith('\n') ? sourceText.slice(0, -1) : sourceText
    void copyTextToClipboard(trimmed).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, sourceText])

  const onRowKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }, [expandable, toggle])

  const a11yStatus = state === 'preparing'
    ? t('codeRunPreparing')
    : state === 'running'
      ? t('codeRunRunning')
      : state === 'error'
        ? t('codeRunFailed')
        : state === 'stopped'
          ? t('codeRunStopped')
          : null

  const wrapLabel = wrapped ? t('codeRunUnwrap') : t('codeRunWrap')
  const copyLabel = copied ? t('codeRunCopied') : t('codeRunCopy')

  return (
    <div
      className="dshc-code-root"
      data-variant="code"
      data-tool={props.toolName ?? 'code_run'}
      data-state={state}
    >
      {a11yStatus !== null && <span className="dshc-code-visually-hidden">{a11yStatus}</span>}
      <div className="dshc-code-header" data-disclosure-header>
        <div
          className="dshc-code-row"
          data-disclosure-row
          data-expandable={expandable ? 'true' : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? toggle : undefined}
          onKeyDown={expandable ? onRowKeyDown : undefined}
        >
          <span className="dshc-code-leading" aria-hidden="true">
            {open ? (
              <ChevronUpIcon />
            ) : (
              <>
                <span className="dshc-code-icon-idle"><CodeGlyphIcon /></span>
                {expandable && <span className="dshc-code-chevron-hover"><ChevronDownIcon /></span>}
              </>
            )}
          </span>
          <span className="dshc-code-text-flow" data-running={running ? 'true' : undefined}>
            <span className="dshc-code-title">{t('codeRunTitle')}</span>
            {summaryText !== '' && (
              <>
                <span className="dshc-code-sep" aria-hidden="true" />
                <span
                  className="dshc-code-summary"
                  data-state={state === 'error' || state === 'stopped' ? state : undefined}
                >
                  {summaryText}
                </span>
              </>
            )}
          </span>
        </div>
      </div>

      {open && (
        <div className="dshc-code-body-wrap">
          {sourceText !== null && highlightedLines !== null && (
            <div className="dshc-code-body-scroll">
              <div
                className="dshc-code-card md-code-block"
                data-code-wrap={wrapped ? 'true' : 'false'}
              >
                <div className="dshc-code-toolbar" data-code-block-banner>
                  <span className="dshc-code-lang">{language}</span>
                  <div className="dshc-code-actions">
                    <button
                      type="button"
                      className="dshc-code-action"
                      title={wrapLabel}
                      aria-label={t('codeRunWrap')}
                      aria-pressed={wrapped}
                      onClick={() => { setWrapped((prev) => !prev) }}
                    >
                      {wrapped ? <NowrapIcon /> : <WrapIcon />}
                    </button>
                    <button
                      type="button"
                      className="dshc-code-action"
                      title={copyLabel}
                      aria-label={copyLabel}
                      onClick={onCopy}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                  </div>
                </div>
                <pre className="shiki css-variables dshc-code-pre" tabIndex={0}>
                  <code>
                    {highlightedLines.map((line, lineIndex) => (
                      <Fragment key={lineIndex}>
                        {lineIndex > 0 && '\n'}
                        <span className="line">
                          {line.map((span, spanIndex) => {
                            const color = SHIKI_TOKEN_COLORS[span.kind]
                            return color === undefined
                              ? <Fragment key={spanIndex}>{span.text}</Fragment>
                              : <span key={spanIndex} style={{ color }}>{span.text}</span>
                          })}
                        </span>
                      </Fragment>
                    ))}
                  </code>
                </pre>
              </div>
            </div>
          )}

          {outputText !== null && (
            <div className="dshc-code-io-card">
              <div className="dshc-code-io-section">
                <span className="dshc-code-io-label">{t('codeRunOutput')}</span>
                <span
                  className="dshc-code-io-text"
                  data-error={state === 'error' ? 'true' : undefined}
                >
                  {outputText}
                </span>
              </div>
            </div>
          )}

          {inspect !== undefined && (
            <button
              type="button"
              className="dshc-code-inspect-btn"
              onClick={inspect}
            >
              <InspectIcon />
              {t('codeRunInspect')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CodeGlyphIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.2 4.5L1.8 8l3.4 3.5" />
      <path d="M10.8 4.5L14.2 8l-3.4 3.5" />
      <path d="M9.2 3L6.8 13" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

function ChevronUpIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10l4-4 4 4" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 8.4l3.1 3.1 6.5-6.5" />
    </svg>
  )
}

function WrapIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11" />
      <path d="M2.5 8h8.5a2.2 2.2 0 1 1 0 4.4H8.2" />
      <path d="M9.8 10.8L8 12.4l1.8 1.6" />
      <path d="M2.5 12.4h3" />
    </svg>
  )
}

function NowrapIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11" />
      <path d="M2.5 8h11" />
      <path d="M11.5 6.2L13.5 8l-2 1.8" />
      <path d="M2.5 12h7" />
    </svg>
  )
}

function InspectIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.2" cy="7.2" r="4.5" />
      <path d="M10.6 10.6L13.8 13.8" />
    </svg>
  )
}
