/**
 * 右侧栏里的视频渲染器：把工作区里的一个 mp4/webm/mov/m4v 播成一段视频。
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/MinimaxVideoDocumentBody
 */

import { type ReactNode } from 'react'
import { zh, type MinimaxCodeLocaleKey } from './locales.ts'
import { formatBytes } from './video-contract.ts'
import { useObjectUrl, VideoStage, type VideoStagePlaceholder } from './video-media.tsx'

/**
 * 宿主下发的那份内容，这里只认 `bytes` 一支。
 *
 * 宿主的内容是一个三分支的并集（文本 / 字节 / 渲染器自管），但视频只可能落在
 * `bytes` 一支上；其余分支对这个渲染器没有意义，所以这里只声明用到的那一支。
 */
export interface DocumentContentLike {
  /** 内容形态；视频只认 `bytes`。 */
  readonly kind?: string
  /** `bytes` 一支的整段字节。 */
  readonly data?: Uint8Array
}

/** 本渲染器真正读到的 props（只声明用到的字段，理由同对话流卡片）。 */
export interface MinimaxVideoDocumentBodyProps {
  /** 页签的内容地址：`dsh-resource://file/session/<sessionId>/<path>`。 */
  readonly resourceAddress?: string | undefined
  /** 宿主读好的内容；`bytes` 一支带整段字节。 */
  readonly content?: DocumentContentLike | undefined
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
 * 只认 `session` 作用域：`absolute` 地址没有会话，宿主读那一段时需要会话身份，
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
 * @param props - 地址、宿主下发的内容与文案。
 * @returns 16:9 视频台与下方一行元数据。
 */
export function MinimaxVideoDocumentBody(props: MinimaxVideoDocumentBodyProps): ReactNode {
  const t = props.t ?? translate
  const file = sessionFileOf(props.resourceAddress)
  const path = file?.path
  // 宿主交下来的字节：`bytes` 一支才有，其余分支（文本、渲染器自管）与视频无关。
  const data = props.content?.kind === 'bytes' ? props.content.data : undefined
  const mediaType = mediaTypeOf(path)
  const source = useObjectUrl(data, mediaType)
  const placeholder = placeholderFor(data, source.failed, t)
  const bytes = data?.byteLength
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

/**
 * 视频台此刻该说什么。
 *
 * 只有两句话：对象 URL 还没建出来（安静地说在读），或者建不出来（这个容器浏览器
 * 不认）。**中文最多两句、结尾不加句号**（DSH 文案规则），英文同理用句点收尾。
 *
 * 读不到文件这一支**不归这里说**：宿主读失败时根本不渲染正文，它自己那行失败
 * 文案带着原因码（文件太大 / 不在工作区 / 不是普通文件）。
 *
 * @param data - 宿主下发的字节；`undefined` 表示还在路上。
 * @param failed - 对象 URL 是否建不出来。
 * @param t - 命名空间化的翻译。
 * @returns 占位文案与色调。
 */
function placeholderFor(
  data: Uint8Array | undefined,
  failed: boolean,
  t: (key: MinimaxCodeLocaleKey) => string,
): VideoStagePlaceholder {
  if (failed) return { text: t('videoUnplayable'), tone: 'danger' }
  // 字节到了但对象 URL 还在建（建 URL 是一次 effect）：那不是失败，是在读。
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
 * @param path - 绝对或相对路径。
 * @returns 最后一个分隔符之后的部分。
 */
function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name === '' ? normalized : name
}
