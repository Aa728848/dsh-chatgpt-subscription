/**
 * MiniMax 视频渲染器的实现身份与 `documentPreviews` 定义。
 *
 * 定义形状照抄宿主 `ui-sidebar-documentpreview/src/client/image/index.ts` 的
 * `imageBodyDefinition`：id / extensions / binaryExtensions / priority / title /
 * loading / wrap。**id 同时是 keyed 槽的键**——定义与正文必须用同一个字符串，
 * 否则侧边栏选中了我们、却渲染不出正文。
 *
 * 这里是纯数据，不 import 任何槽位或 cordis 类型：定义要能在测试里直接断言形状，
 * 而 `priority` / `loading` 是字符串字面量联合，写宽了编译器就抓不住笔误。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/document-preview
 */

/** 本实现在文档预览系统里的身份，也是正文 keyed 槽的键。 */
export const MINIMAX_VIDEO_PREVIEW_ID = '@eddyskywalker/dsh-chatgpt-subscription/video'

/** 本实现认领的文件后缀。 */
export const MINIMAX_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const

/** 与 `DocumentPreviewDefinition` 同形的最小面（避免为一份数据依赖宿主包）。 */
export interface MinimaxVideoPreviewDefinition {
  /** 唯一实现名，同时是文档槽的键。 */
  readonly id: string
  /** 认领的文件后缀（不带点）。 */
  readonly extensions: readonly string[]
  /** 其中字节不可当文本读的后缀；**必须**是 `extensions` 的子集。 */
  readonly binaryExtensions: readonly string[]
  /** 外部实现优先于内置实现。 */
  readonly priority: 'extension'
  /** 页签上的实现名，渲染时求值。 @returns 可见名称。 */
  readonly title: () => string
  /** 内容下发方式；视频要整段字节才能播。 */
  readonly loading: 'bytes-complete'
  /** 是否消费文档的换行偏好；视频不消费。 */
  readonly wrap: false
}

/**
 * 构造视频渲染器的定义。
 *
 * `binaryExtensions` 与 `extensions` 用同一个数组：这四个后缀的字节都不能当文本
 * 读，`register` 也要求前者是后者的子集。
 *
 * @param title - 惰性求值的实现名（走本线路的 locale 命名空间）。
 * @returns 可交给 `ctx.documentPreviews.register` 的定义。
 */
export function minimaxVideoPreviewDefinition(title: () => string): MinimaxVideoPreviewDefinition {
  return {
    id: MINIMAX_VIDEO_PREVIEW_ID,
    extensions: MINIMAX_VIDEO_EXTENSIONS,
    binaryExtensions: MINIMAX_VIDEO_EXTENSIONS,
    priority: 'extension',
    title,
    loading: 'bytes-complete',
    wrap: false,
  }
}
