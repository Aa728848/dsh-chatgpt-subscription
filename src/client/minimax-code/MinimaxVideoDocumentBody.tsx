/**
 * 右侧栏里的视频渲染器：把工作区里的一个 mp4/webm/mov/m4v 播成一段视频。
 *
 * ## 它是怎么被选中的
 *
 * 两个注册各管一半，缺一不可（形状照抄宿主
 * `ui-sidebar-documentpreview/src/client/image/index.ts`）：
 *
 * 1. `ctx.documentPreviews.register(…)` 声明「mp4 等后缀归我」；
 *    `priority: 'extension'` 让外部实现排在内置实现之前
 *    （`document/registry.ts` 的排序规则：档位 → 后缀长度 → 注册先后）。
 * 2. `sidebar.right.tab.document` 的 keyed 槽用**同一个 id** 注册正文。
 *    侧边栏按地址选渲染器，选中谁就渲染谁的 keyed 槽。
 *
 * `binaryExtensions` 必须与 `extensions` 是同一组后缀：`register` 会拒绝
 * `binaryExtensions` 里出现在 `extensions` 之外的项。
 *
 * ## 字节从哪来
 *
 * 宿主的内置图像渲染器不自己取字节——文档预览插件读好了通过 `content` 发下来。
 * 我们的定义是**后注册的外部实现**，拿不到那条 `bytes-complete` 通路，
 * 所以按任务要求自己取：`ctx.remote.workspaceFiles.readBytes`，与宿主
 * `ReadDocumentBytes` 调的是同一个远端。会话 id 取自页签的
 * `resourceAddress`（`dsh-resource://file/session/<id>/<path>`），路径就是地址里
 * 那一段——它已经按该会话的工作区根解析过。
 *
 * ## 为什么和对话流卡片长得一样
 *
 * 两处共用 `.dshm-video-stage` 与 `useObjectUrl`：视频台是**同一个东西的两个尺寸**，
 * 差别只有容器宽度。侧边栏多一行安静的元数据（文件名 + 体积），因为这里的视频台
 * 是全尺寸的，下面空着反而显眼。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/MinimaxVideoDocumentBody
 */

import { useEffect, useState, type ReactNode } from 'react'
import { zh, type MinimaxCodeLocaleKey } from './locales.ts'
import {
  formatBytes, videoReadFailureOf, videoReadLimitOf, videoTooLargeText,
  type ReadVideoBytes, type VideoReadFailure,
} from './video-contract.ts'
import { useObjectUrl, VideoStage, type VideoStagePlaceholder } from './video-media.tsx'

/** 本渲染器真正读到的 props（只声明用到的字段，理由同对话流卡片）。 */
export interface MinimaxVideoDocumentBodyProps {
  /** 页签的内容地址：`dsh-resource://file/session/<sessionId>/<path>`。 */
  readonly resourceAddress?: string | undefined
  /** 会话 id；缺省时从 `resourceAddress` 里解析。 */
  readonly sessionId?: string | undefined
  /** 取字节的通道；缺席时视频台退回占位块。 */
  readonly readVideo?: ReadVideoBytes | undefined
  /** 命名空间化的翻译；缺席时用本文件的中文字典兜底。 */
  readonly t?: ((key: MinimaxCodeLocaleKey) => string) | undefined
  /** 兼容槽位交来的其余座位，本视图不读。 */
  readonly [key: string]: unknown
}

/** 兜底翻译：只在没有 locale 座位时用到。 */
function translate(key: MinimaxCodeLocaleKey): string {
  return (zh as Record<string, string>)[key] ?? key
}

/**
 * 一个文件地址里的会话与路径。
 *
 * 只认 `session` 作用域：`absolute` 地址没有会话，取字节通道需要会话身份，
 * 所以那种地址这里当作「没有可读的文件」，由视频台画占位块。
 * @param address - `dsh-resource://file/…` 地址。
 * @returns 会话 id 与路径；不是会话地址时 undefined。
 */
export function sessionFileOf(address: string | undefined): { readonly sessionId: string, readonly path: string } | undefined {
  if (address === undefined || !address.startsWith('dsh-resource://file/')) return undefined
  const end = address.search(/[?#]/)
  const [scope, id, ...rest] = address.slice('dsh-resource://file/'.length, end === -1 ? undefined : end).split('/')
  if (scope !== 'session' || id === undefined || id === '' || rest.length === 0) return undefined
  try {
    return { sessionId: decodeURIComponent(id), path: rest.map(decodeURIComponent).join('/') }
  } catch {
    return undefined
  }
}

/**
 * 侧边栏视频正文。
 * @param props - 地址、会话、取字节通道与文案。
 * @returns 16:9 视频台与下方一行元数据。
 */
export function MinimaxVideoDocumentBody(props: MinimaxVideoDocumentBodyProps): ReactNode {
  const t = props.t ?? translate
  const file = sessionFileOf(props.resourceAddress)
  const sessionId = props.sessionId ?? file?.sessionId
  const path = file?.path
  const data = useDocumentBytes({ readVideo: props.readVideo, sessionId, path })
  const mediaType = mediaTypeOf(path)
  const source = useObjectUrl(data.kind === 'ready' ? data.data : undefined, mediaType)
  const placeholder = placeholderFor(data, t)
  const bytes = data.kind === 'ready' ? data.data.byteLength : undefined
  const name = path === undefined ? undefined : fileName(path)
  return (
    <div className="dshm-video-document">
      <VideoStage url={source.failed ? null : source.url} placeholder={placeholder} label={name ?? t('videoTitle')} />
      {name === undefined || bytes === undefined
        ? null
        : (
          <div className="dshm-video-doc-meta">
            <span className="dshm-video-doc-name" title={name}>{name}</span>
            <span className="dshm-video-doc-size">{t('videoSize').replace('{size}', formatBytes(bytes))}</span>
          </div>
        )}
    </div>
  )
}

/** 字节通道的三种结果；失败带着原因，好让视频台把「太大」和「读不到」分开说。 */
type DocumentBytes =
  | { readonly kind: 'idle' }
  | { readonly kind: 'ready', readonly data: Uint8Array }
  | { readonly kind: 'failed', readonly reason: VideoReadFailure, readonly limit: number | undefined }

/**
 * 取一次整段视频字节。
 *
 * 没有「加载中」这一态：视频台在拿到字节前本来就是虚线占位，多一个中间态只是
 * 多一次重渲染。卸载或换文件时 abort。
 * @param input - 通道、会话与路径。
 * @returns 当前字节状态。
 */
function useDocumentBytes(input: {
  readonly readVideo: ReadVideoBytes | undefined
  readonly sessionId: string | undefined
  readonly path: string | undefined
}): DocumentBytes {
  const { readVideo, sessionId, path } = input
  const [state, setState] = useState<DocumentBytes>({ kind: 'idle' })
  useEffect(() => {
    if (readVideo === undefined || sessionId === undefined || path === undefined) {
      setState({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    let live = true
    readVideo(sessionId, path, controller.signal).then((data) => {
      if (live) setState({ kind: 'ready', data })
    }, (error: unknown) => {
      // 与对话流卡片同一套判定：只读错误上的 `code`，不猜 `message`。
      if (live) setState({ kind: 'failed', reason: videoReadFailureOf(error), limit: videoReadLimitOf(error) })
    })
    return () => {
      live = false
      controller.abort()
    }
  }, [readVideo, sessionId, path])
  return state
}

/**
 * 视频台此刻该说什么。
 *
 * 与对话流卡片的同名字面同一套措辞，但这里只有字节这一条信息：侧边栏的地址就是
 * 用户点开的那个文件，没有「还在生成」这个阶段。**中文最多两句、结尾不加句号**
 * （DSH 文案规则）。
 *
 * `too-large` 是唯一一个「文件没坏、只是不交给浏览器」的失败：那时说成「可能被
 * 移动或删除」是错的，所以单独一句，并带上宿主报的上限。
 *
 * @param data - 当前字节状态。
 * @param t - 命名空间化的翻译。
 * @returns 占位文案与色调。
 */
function placeholderFor(
  data: DocumentBytes,
  t: (key: MinimaxCodeLocaleKey) => string,
): VideoStagePlaceholder {
  if (data.kind === 'failed') {
    if (data.reason === 'too-large') return { text: videoTooLargeText((key) => t(key), data.limit), tone: 'danger' }
    return { text: t('videoUnreadable'), tone: 'danger' }
  }
  if (data.kind === 'ready') return { text: t('videoUnplayable'), tone: 'danger' }
  return { text: t('videoReading'), tone: 'quiet' }
}

/**
 * 后缀 → MIME。
 *
 * 只覆盖本实现认领的四个后缀，所以查表就是穷举：不认识的进来是编程错误，
 * 退回 `video/mp4` 而不是抛——一个后缀不该让侧边栏白屏。
 * @param path - 文件路径。
 * @returns 该后缀的 MIME 类型。
 */
function mediaTypeOf(path: string | undefined): string {
  const extension = path === undefined ? '' : path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'm4v') return 'video/x-m4v'
  return 'video/mp4'
}

/**
 * 路径里的文件名。
 * @param path - 文件路径。
 * @returns 最后一个分隔符之后的部分。
 */
function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name === '' ? normalized : name
}
