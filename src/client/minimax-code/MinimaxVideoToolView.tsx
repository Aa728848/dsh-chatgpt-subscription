/**
 * `minimax_generate_video` 在对话流里的工具卡片。
 *
 * ## 解剖结构照抄同一仓库的生图卡片
 *
 * 状态点 + 标题 + 摘要 + 媒体区，与 `src/client/CodexImageToolView.tsx` 一字不差的
 * 骨架（`.dsh-codex-image-tool` 那一族）。同一个对话里两张卡片是**同一种东西**：
 * 一条发丝线、8px 圆角、13px 标题、8px 状态点。差别只在媒体区——那边是图片格，
 * 这边是 16:9 的视频台。
 *
 * ## 三个阶段都要画
 *
 * `tool.call.toolview` 交来的 `block` 是阶段相关的：
 * - `phase: 'preparing'` —— 参数还在流式生成，结果无从谈起；
 * - `phase: 'start'` —— 参数完整，上游还在生成（**进行中**，视频台空着）；
 * - `'kind' in block` —— 已结算，`isError` 决定成功还是失败。
 *
 * 判断写法与生图卡片同款（`'kind' in block`），因为要面对的正是同一批阶段形状。
 *
 * ## 数据只来自 meta
 *
 * 视频路径在 `ToolResultNode.meta`（宿主写的 `output.presentationMeta`）里。工具的
 * 结构化 `value` 不随会话日志持久化，所以这里**不读 `value`**，也不读结果正文
 * 里的自然语言——读不到 meta 就画占位块，卡片照常显示标题与状态。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/MinimaxVideoToolView
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { ContentBlock } from '@deepseek-ai/dsh-client-connection/client'
import { zh, type MinimaxCodeLocaleKey } from './locales.ts'
import {
  absoluteVideoPath, formatBytes, formatDuration, fileNameOf, readVideoMeta, videoReadFailureOf, videoReadLimitOf,
  videoTooLargeText, type ReadVideoBytes, type VideoReadFailure,
} from './video-contract.ts'
import { useObjectUrl, VideoStage, type VideoStagePlaceholder } from './video-media.tsx'

/**
 * 本卡片真正读到的 props。
 *
 * 不写 `PropsRuntime<'tool.call.toolview'>`：那个 owner 面由 ui-tool 合并，写宽一点
 * 就把本插件的一个编辑器面变成对另一个包的编译期依赖。这里只声明真正用到的字段，
 * 同时让这份视图在任何场合（jsdom 测试、故事预览）都能直接渲染。
 */
export interface MinimaxVideoToolViewProps {
  /** 当前阶段的操作块。 */
  readonly block: MinimaxVideoBlock
  /** 会话工作区根；宿主不认识这个会话时缺省。 */
  readonly cwd?: string | undefined
  /** 打开一个文件（会进右侧栏预览）。 */
  readonly openFile?: ((path: string, options?: { line?: number }) => void) | undefined
  /** 取视频字节的通道；缺席时视频台退回占位块。 */
  readonly readVideo?: ReadVideoBytes | undefined
  /** 会话 id，与 `readVideo` 一起用；缺席时同样退回占位块。 */
  readonly sessionId?: string | undefined
  /** 命名空间化的翻译；缺席时用本文件的中文字典兜底（jsdom 里没有 locale 服务）。 */
  readonly t?: ((key: MinimaxCodeLocaleKey) => string) | undefined
  /** 兼容槽位交来的其余座位（`loadImage`、`useDisclosure` …），本视图不读。 */
  readonly [key: string]: unknown
}

/** 三个阶段的最小公共形状。 */
export interface MinimaxVideoBlock {
  /** 已结算的判别值；没有它就是在准备/进行中。 */
  readonly kind?: string
  /** 已结算时：这次调用是否失败。 */
  readonly isError?: boolean
  /** 结算结果的内容块；本视图只从中取一行文字摘要。 */
  readonly content?: readonly ContentBlock[]
  /** 参数已完整时的 JSON 文本。 */
  readonly argsRaw?: string
  /** 参数视图：流式阶段给到目前已到的前缀。 */
  readonly args?: {
    /** 读一个字符串参数。 @param key - 参数名。 @returns 当前文本。 */
    readonly text?: (key: string) => unknown
  }
  /** 已结算时的结构化事实。 */
  readonly meta?: unknown
}

/** 兜底翻译：只在没有 locale 座位时用到，走同一份 zh 字典。 */
function translate(key: MinimaxCodeLocaleKey): string {
  return (zh as Record<string, string>)[key] ?? key
}

/**
 * 一张视频工具卡片。
 * @param props - 阶段块、工作区根、打开/取字节通道与文案。
 * @returns 卡片。
 */
export function MinimaxVideoToolView(props: MinimaxVideoToolViewProps): React.JSX.Element {
  const { block, cwd, openFile, readVideo, sessionId } = props
  const t = props.t ?? translate
  const settled = block.kind !== undefined
  const isError = settled && block.isError === true
  const meta = settled && !isError ? readVideoMeta(block.meta) : undefined
  const prompt = promptFromBlock(block)
  const summary = prompt ?? textSummary(block.content)
  const label = isError ? t('videoToolFailed') : settled ? t('videoToolDone') : t('videoToolRunning')
  const absolute = meta === undefined ? undefined : absoluteVideoPath(cwd, meta.videoPath)
  const data = useVideoBytes({
    readVideo, sessionId, path: absolute, enabled: meta !== undefined,
  })
  const source = useObjectUrl(data.kind === 'ready' ? data.data : undefined, meta?.mediaType ?? 'video/mp4')
  const placeholder = placeholderFor({ settled, isError, meta, data, source, t })
  return (
    <div className="dshm-video-tool" data-state={isError ? 'error' : settled ? 'done' : 'running'}>
      <div className="dshm-video-head">
        <span className="dshm-video-dot" aria-hidden="true" />
        <span className="dshm-video-title">{label}</span>
        {summary === null ? null : <span className="dshm-video-summary">{summary}</span>}
      </div>
      <VideoStage url={source.failed ? null : source.url} placeholder={placeholder} label={meta === undefined ? t('videoToolTitle') : fileNameOf(meta.videoPath)} />
      {meta === undefined || absolute === undefined
        ? null
        : (
          <div className="dshm-video-foot">
            <button
              type="button"
              className="dshm-video-path"
              onClick={() => { openFile?.(absolute, { line: 1 }) }}
              title={absolute}
            >
              {meta.videoPath}
            </button>
            <span className="dshm-video-meta">
              {meta.durationSeconds === undefined ? null : <span>{formatDuration(meta.durationSeconds)}</span>}
              <span>{t('videoSize').replace('{size}', formatBytes(meta.bytes))}</span>
            </span>
          </div>
        )}
    </div>
  )
}

/** 字节通道的三种结果：还没要、正在要、拿到了/失败了。 */
type VideoBytesState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly data: Uint8Array }
  | { readonly kind: 'failed', readonly reason: VideoReadFailure, readonly limit: number | undefined }

/**
 * 取一次视频字节。
 *
 * `enabled` 为假、或通道缺席时什么都不做——一张没有 meta 的卡片不该发出请求。
 * 卸载或换文件时 abort：面板关掉之后不该还有字节在路上。
 *
 * @param input - 通道、会话、路径与开关。
 * @returns 当前字节状态。
 */
function useVideoBytes(input: {
  readonly readVideo: ReadVideoBytes | undefined
  readonly sessionId: string | undefined
  readonly path: string | undefined
  readonly enabled: boolean
}): VideoBytesState {
  const { readVideo, sessionId, path, enabled } = input
  const [state, setState] = useState<VideoBytesState>({ kind: 'idle' })
  useEffect(() => {
    if (!enabled || path === undefined || readVideo === undefined || sessionId === undefined) {
      setState({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    let live = true
    setState({ kind: 'loading' })
    readVideo(sessionId, path, controller.signal).then((data) => {
      if (live) setState({ kind: 'ready', data })
    }, (error: unknown) => {
      // 失败要带着**原因**回到界面上：宿主说「太大」和「找不到」是两回事，
      // 前者文件好好的，只是不交给浏览器。
      if (live) setState({ kind: 'failed', reason: videoReadFailureOf(error), limit: videoReadLimitOf(error) })
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [readVideo, sessionId, path, enabled])
  return state
}

/**
 * 视频台此刻该说什么。
 *
 * 四句话按「谁的问题」排：读不出来是产物的问题，通道缺席是本插件没接上，
 * 还在生成是时间的问题。**中文最多两句、结尾不加句号**（DSH 文案规则），
 * 英文同理用句点收尾。
 *
 * `too-large` 单独一句：那时文件好好的，只是宿主的整文件上限没把它交出来，
 * 说成「可能被移动或删除」是在冤枉它。
 *
 * @param input - 阶段、meta、字节状态与对象 URL 状态。
 * @returns 占位文案与色调。
 */
function placeholderFor(input: {
  readonly settled: boolean
  readonly isError: boolean
  readonly meta: { readonly bytes: number } | undefined
  readonly data: VideoBytesState
  readonly source: { readonly url: string | null, readonly failed: boolean }
  readonly t: (key: MinimaxCodeLocaleKey) => string
}): VideoStagePlaceholder {
  const { settled, isError, meta, data, source, t } = input
  if (isError) return { text: t('videoFailed'), tone: 'danger' }
  if (!settled) return { text: t('videoGenerating'), tone: 'quiet' }
  if (meta === undefined) return { text: t('videoNoMeta'), tone: 'danger' }
  if (source.failed) return { text: t('videoUnplayable'), tone: 'danger' }
  if (data.kind === 'failed') {
    if (data.reason === 'too-large') return { text: videoTooLargeText((key) => t(key), data.limit), tone: 'danger' }
    return { text: t('videoUnreadable'), tone: 'danger' }
  }
  if (data.kind === 'idle') return { text: t('videoChannelOff'), tone: 'danger' }
  return { text: t('videoReading'), tone: 'quiet' }
}

/**
 * 从参数里读提示词。
 *
 * 三个阶段的读法不同：流式阶段只有前缀视图（`args.text`），完整阶段才有
 * `argsRaw`。与生图卡片的 `promptFromBlock` 同款。
 * @param block - 当前阶段块。
 * @returns 提示词，或 `null`。
 */
function promptFromBlock(block: MinimaxVideoBlock): string | null {
  const partial = partialPrompt(block)
  if (partial !== null) return partial
  const raw = block.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof (value as { prompt?: unknown }).prompt === 'string'
      ? (value as { prompt: string }).prompt
      : null
  } catch {
    return null
  }
}

/**
 * 流式阶段的提示词前缀。
 * @param block - 当前阶段块。
 * @returns 已到达的提示词前缀，或 `null`。
 */
function partialPrompt(block: MinimaxVideoBlock): string | null {
  const read = block.args?.text
  if (typeof read !== 'function') return null
  try {
    const prompt = read.call(block.args, 'prompt')
    return typeof prompt === 'string' && prompt !== '' ? prompt : null
  } catch {
    return null
  }
}

/**
 * 结果正文的第一行文字，当作摘要。
 * @param blocks - 结算结果的内容块。
 * @returns 一行摘要，或 `null`。
 */
function textSummary(blocks: readonly ContentBlock[] | undefined): string | null {
  if (blocks === undefined) return null
  const text = blocks
    .map((content) => content.type === 'text' ? content.text : '')
    .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    .join(' ')
    .replace(/s+/g, ' ')
    .trim()
  return text === '' ? null : text
}

/** 供槽位注册处收窄的组件类型别名。 */
export type MinimaxVideoToolViewComponent = (props: MinimaxVideoToolViewProps) => ReactNode
