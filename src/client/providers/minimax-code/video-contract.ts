/**
 * MiniMax 视频能力在浏览器半边的共享契约与纯函数。
 *
 * ## 为什么形状要在这里再写一遍
 *
 * host 那一份（`MinimaxVideoPresentationMeta`）住在 `src/host/minimax-code/` 下。
 * 客户端 tsconfig 的 `include` 只覆盖 `src/client/**` 与 `src/shared/**`——
 * 从浏览器半边 import 宿主模块既越界，也会把宿主的 node 依赖拖进浏览器闭包。
 * 两份形状必须逐字一致（字段名、可选性），由
 * `test/minimax-code-video-toolview.test.tsx` 的赋值断言钉住。
 *
 * ## 视频怎么从工作区走到 `<video>`
 *
 * meta 里的 `videoPath` 是**工作区相对路径**，而浏览器只有一个取字节通道：
 * `ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal)`
 * （宿主侧边栏图像预览走的是同一条，见
 * `ui-sidebar-documentpreview/src/client/rpc.ts` 的 `ReadDocumentBytes`）。
 * 拿到的 `Uint8Array` 包成 Blob，再 `URL.createObjectURL` 交给 `<video>`：
 * 视频不能像图片那样走 `loadImage`（那是附件专用的），也不能直接写文件路径
 * ——浏览器的 `<video src>` 读不到工作区。
 *
 * 对象 URL 是**手动生命周期**：拿到就建、卸载就 `revokeObjectURL`，见两个组件里的
 * `useObjectUrl`。漏掉那一步等于把整段视频留在内存里。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-contract
 */

import type { RemoteBytes, RemoteResult } from './video-slots.ts'

/**
 * `minimax_generate_video` 的线上工具名。
 *
 * `tool.call.toolview` 是按这个字符串 keyed 分发的，拼错一个字视图就永远不渲染
 * （槽位不会报错，它只是永远命不中），所以两边共用这一个常量。
 */
export const MINIMAX_VIDEO_TOOL_NAME = 'minimax_generate_video'

/**
 * 工具结果里的结构化事实，由宿主写进 `output.presentationMeta`。
 *
 * `presentationMeta` 会随会话日志持久化（`packages/core/tools/src/presentation.ts`），
 * 落到客户端的 `ToolResultNode.meta`。工具的结构化 `value` **不会**被持久化，
 * 所以客户端只能用这份 meta，不要指望能读到 `value`。
 */
export interface MinimaxVideoPresentationMeta {
  /** 工作区相对路径（客户端用会话 cwd 解析成绝对路径）。 */
  readonly videoPath: string
  /** 视频的 MIME 类型，如 `video/mp4`；用于 Blob 的 `type`。 */
  readonly mediaType: string
  /** 文件字节数；卡片右下角显示的就是它。 */
  readonly bytes: number
  /** 生成用的模型 id，如 `MiniMax-H3`。 */
  readonly model: string
  /** 上游报告的时长；缺失时卡片不显示时长，也不显示占位符。 */
  readonly durationSeconds?: number
  /** 上游任务 id，便于排查与续查。 */
  readonly taskId: string
}

/**
 * 从工具结果的 `meta` 里读出视频事实，读不到就是 `undefined`。
 *
 * `meta` 在类型上是 `unknown`，且它由**另一个运行时**写入——会话日志可能是
 * 旧版本插件写的、可能缺字段、也可能根本不是这个工具的对象。所以这里逐字段
 * 校验，任何一项不合格就整体当作「没有 meta」，由卡片改画占位块，
 * 而不是让一次审计过的 JSON 把整个对话流带崩。
 *
 * @param meta - `ToolResultNode.meta`（通常是 `output.presentationMeta`）。
 * @returns 通过校验的视频事实；不是本工具的 meta 时 undefined。
 */
export function readVideoMeta(meta: unknown): MinimaxVideoPresentationMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const candidate = meta as Record<string, unknown>
  const videoPath = candidate.videoPath
  const mediaType = candidate.mediaType
  const bytes = candidate.bytes
  const model = candidate.model
  const taskId = candidate.taskId
  const durationSeconds = candidate.durationSeconds
  if (typeof videoPath !== 'string' || videoPath === '') return undefined
  if (typeof mediaType !== 'string' || !mediaType.startsWith('video/')) return undefined
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (typeof model !== 'string') return undefined
  if (typeof taskId !== 'string') return undefined
  if (durationSeconds !== undefined && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    return undefined
  }
  return {
    videoPath, mediaType, bytes, model, taskId,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  }
}

/**
 * 把工作区相对路径拼成绝对路径。
 *
 * 分隔符**按 posix 拼**，不按宿主平台拼：这段代码跑在浏览器里，而工作区路径
 * 的规范形是 `/` 分隔（宿主的 `parseFileAddress` 也按这个认）。反斜杠进来的
 * 相对路径先归一化，避免拼出 `C:\\ws\\clips\\a.mp4` 这种混合形态。
 *
 * `cwd` 缺省时（宿主从不认识这个会话的工作区）**原样返回相对路径**：它仍然是
 * 这个会话地址空间里的合法路径，`openFile` 与 `readBytes` 都能用；只是别再声称
 * 它是绝对的——调用方要的是「能打开的路径」，不是「看起来像绝对路径的字符串」。
 *
 * @param cwd - 会话工作区根；未提供时按相对路径处理。
 * @param videoPath - meta 里的工作区相对路径。
 * @returns 绝对路径，或 `cwd` 缺省时的相对路径。
 */
export function absoluteVideoPath(cwd: string | undefined, videoPath: string): string {
  const relative = videoPath.replaceAll('\\', '/')
  if (cwd === undefined || cwd === '') return relative
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  if (root === '') return relative
  // 已经是绝对的（宿主换了写法，或 meta 写的是绝对路径）：不要再拼一次。
  if (/^(?:[A-Za-z]:\/|\/)/.test(relative)) return relative
  return `${root}/${relative}`
}

/**
 * 取视频字节的通道。
 *
 * 与宿主 `ctx.remote.workspaceFiles.readBytes` 的**远端签名同形**：会话 id 决定
 * 相对路径解析到哪个工作区根。返回裸字节（`WorkspaceFileBytes.data`），
 * 生命周期归调用方。
 *
 * @param sessionId - 会话 id，决定工作区根。
 * @param path - 绝对路径，或相对该会话工作区根的路径。
 * @param signal - 取消信号；组件卸载时触发。
 * @returns 整段文件字节。
 */
export type ReadVideoBytes = (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>

/**
 * 一次远端取字节的结果 → 字节。
 *
 * 远端调用**不抛异常**：它把结果装成 `{ ok: true, value }` 或
 * `{ ok: false, error }`（见 `@deepseek-ai/dsh-typert-protocol` 的
 * `RemoteResult`）。所以字节在 `value.data`，而不是结果对象的 `data`——
 * 直接读 `(await call()).data` 拿到的是 `undefined`，界面会把它显示成
 * 「一直在读」。
 *
 * 失败那一支**抛出去**：卡片按 `code` 与 `details.limit` 区分「文件太大」和
 * 「读不到」，那需要一条真正的异常（`RemoteError` 本身就是带这两个字段的
 * `Error`）。
 *
 * **载荷有两代形状**：≤0.1.6 的宿主给 base64 字符串，≥0.1.7 的宿主给
 * `Uint8Array`。两种都认，否则旧世代会拿到一串 base64 而不是字节。
 *
 * @param result - 远端返回的结果。
 * @returns 整段文件字节。
 * @throws 远端声明的失败，或一份「成功却没有字节」的结果。
 */
export function unwrapVideoBytes(result: RemoteResult<{ readonly data: RemoteBytes }>): Uint8Array {
  if (!result.ok) throw result.error
  return decodeVideoBytes(result.value.data)
}

/**
 * 宿主的字节载荷 → 浏览器要用的字节。
 *
 * ≥0.1.7 的宿主直接给 `Uint8Array`；≤0.1.6 的宿主给 base64 字符串，
 * 宿主自己的预览也是用 `atob` 解的（`ui-sidebar-documentpreview/src/client/rpc.ts`
 * 的 `documentFileBytes`）。这里照抄同一套判定。
 *
 * @param data - 远端交回的载荷。
 * @returns 整段文件字节。
 * @throws 载荷既不是字节也不是可解的 base64。
 */
export function decodeVideoBytes(data: RemoteBytes): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (typeof data === 'string') {
    try {
      return Uint8Array.from(atob(data), character => character.charCodeAt(0))
    } catch {
      throw new Error('workspaceFiles returned bytes that are not decodable')
    }
  }
  // 「成功但没有字节」与失败同义：不能让它悄悄变成空画面或永远在读。
  throw new Error('workspaceFiles returned no bytes')
}

/**
 * 一次取字节失败的原因。
 *
 * 只有两种：宿主明确说「文件超过整文件上限」，以及**其它一切**。别的原因不值得
 * 在视频台上细分——观众能做的事完全一样（这个文件读不出来），而细分会让每个新的
 * 远端码都得回来改一次文案。
 */
export type VideoReadFailure = 'too-large' | 'unreadable'

/** 宿主整文件读取上限的失败码（`workspace-files` 的 `readBytes`）。 */
export const WORKSPACE_FILE_TOO_LARGE = 'workspace-file/too-large'

/**
 * 把一次取字节的异常读成「太大」还是「读不到」。
 *
 * 判定**只看错误上的 `code`**，与宿主自己的文档预览同款做法
 * （`ui-sidebar-documentpreview/src/client/failure-line.ts`）：远端失败的形状是
 * `{ code, message, details }`，`code` 就是那条稳定的判别字段，不要去解析
 * `message` 里的英文，也不要靠 `instanceof`——跨包、跨 realm 都不成立。
 *
 * 任何拿不到 `code` 的东西（通道根本没装上、浏览器抛的 TypeError、undefined）
 * 一律归入「读不到」：那是默认的那句话，不能因为一个畸形异常就把文案换成
 * 「文件太大」。
 *
 * @param error - `catch` 到的任意值。
 * @returns `'too-large'` 仅当宿主明确报了这个码，否则 `'unreadable'`。
 */
export function videoReadFailureOf(error: unknown): VideoReadFailure {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === WORKSPACE_FILE_TOO_LARGE
    ? 'too-large'
    : 'unreadable'
}

/**
 * 从一次 too-large 失败里读出那个上限。
 *
 * 宿主把它放在 `details.limit`（`packages/api/workspace-files/src/index.ts` 的
 * `RemoteError('workspace-file/too-large', …, { path, limit })`）。读不到就不显示
 * 上限——文案里留一个「—」比编一个数字出来好。
 *
 * @param error - `catch` 到的任意值。
 * @returns 上限字节数，或 undefined。
 */
export function videoReadLimitOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const details = (error as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const limit = (details as { limit?: unknown }).limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/**
 * 字节数转人读的体积。
 *
 * 只有 11px 的位置放它，所以最多三位有效数字：`986 KB`、`12.4 MB`、`1.02 GB`。
 * 单位之间是普通空格，不引小数点前的零。
 * @param bytes - 文件字节数。
 * @returns 形如 `12.4 MB` 的短标签。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  // 小数位只在确实存在时裁零：`2.40 → 2.4`、`1.00 → 1`；已经取整的 `100` 原样不动。
  const trimmed = rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded
  return `${trimmed} ${units[unit]}`
}

/**
 * 「文件太大，读不出来」那一句，带上宿主报的上限。
 *
 * 宿主把 `details.limit` 交给文案（`failureLine` 的
 * `t('error.tooLarge', { limit: humanBytes(failure.details.limit) })`），这里照做，
 * 只是换成本插件自己的 {@link formatBytes}——两边对同一个数字的写法必须与本卡片
 * 右下角那行体积一致。
 *
 * 上限缺失时退回「—」（`formatBytes` 对非数字的既有行为）：一句话里少一个数字，
 * 好过为了凑数字去猜一个上限。
 *
 * @param t - 命名空间化的翻译。
 * @param limit - 宿主报的上限字节数；undefined 时按未知处理。
 * @returns 一句占位文案（中文一句、结尾不加句号）。
 */
export function videoTooLargeText(
  t: (key: 'videoTooLarge') => string,
  limit: number | undefined,
): string {
  return t('videoTooLarge').replace('{limit}', formatBytes(limit ?? Number.NaN))
}

/**
 * 秒数转 `m:ss` / `h:mm:ss`。
 *
 * 视频时长是元数据，不是大数字：只补零到分钟位，超过一小时才出现小时段。
 * @param seconds - 时长秒数。
 * @returns 形如 `0:07` 或 `1:02:03` 的短标签。
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const tail = `${minutes}:${String(rest).padStart(2, '0')}`
  return hours === 0 ? tail : `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/**
 * 从路径里取文件名，用于侧边栏那一行元数据。
 * @param path - 绝对或相对路径，`/` 与 `\` 都认。
 * @returns 最后一个分隔符之后的部分；没有分隔符时返回原串。
 */
export function fileNameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name === '' ? normalized : name
}
