/**
 * 参考媒体的**入口归一化**：把「拖进来的文件」「粘贴板里的文字」「浏览选中的文件」
 * 变成一张路径列表。
 *
 * ## 为什么需要一个纯函数模块
 *
 * 这三种入口最终都要回答同一个问题：**这一条是不是服务端认识的本机路径**。宿主
 * 的 `minimax_generate_video` 只接受本机文件（`video-tool.ts` 里逐条校验），
 * 网页链接和 `data:` 内联串在服务端一律被拒。如果这里放行，用户会看到「填好了」
 * 然后被计费前的校验打回来——那正是这个入口要避免的体验。
 *
 * 所以判定写在纯函数里，事件绑定留在组件里：判定能被测试钉死，DOM 细节不必。
 *
 * ## 「真实路径」是怎么来的
 *
 * 浏览器的 `File` 对象**没有**路径字段（安全模型如此）。DSH 桌面端额外暴露出
 * `window.__DSH_HOST_PATHS__.pathFor(file)`（Electron `webUtils.getPathForFile`），
 * 本插件按鸭子类型取用：拿得到就是绝对路径，拿不到就如实返回空串，由界面提示
 * 用户改用粘贴——**绝不编一条看起来像路径的字符串**。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-media-input
 */

/** 一次归一化的结果。 */
export interface MediaIntake {
  /** 可以直接写进表单的路径，按输入顺序、已去重。 */
  readonly paths: readonly string[]
  /** 被拒绝的网页链接（不是本机路径）。 */
  readonly rejectedUrls: readonly string[]
  /** 拿不到本机路径的文件个数（浏览器里拖进来的网页图片、内联字节等）。 */
  readonly withoutPath: number
}

/** 空结果，供调用方省一次判断。 */
export const EMPTY_INTAKE: MediaIntake = { paths: [], rejectedUrls: [], withoutPath: 0 }

/** 桌面端宿主路径桥的形状（`apps/desktop/src/preload-app.ts` 暴露的那一个）。 */
interface HostPathBridge {
  readonly pathFor?: (file: File) => string
}

/**
 * 取一个 `File` 的本机绝对路径。
 *
 * 桌面端由宿主桥给出；网页端、或宿主那一版没有这个桥时返回空串。**任何异常都
 * 吞掉**：拖进一个文件不该把面板带崩。
 *
 * @param file - 拖入或浏览选中的文件。
 * @param bridge - 取值来源；缺省读 `globalThis`，测试注入一个假的。
 * @returns 绝对路径，或空串。
 */
export function hostPathForFile(file: File, bridge?: HostPathBridge | undefined): string {
  const source = bridge ?? (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
  try {
    const path = source?.pathFor?.(file)
    return typeof path === 'string' ? path.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 服务端唯一会被读的 URL 主机（宿主 `MINIMAX_CDN_HOST`，实测结论）。
 *
 * 其他公网地址在服务端会被拒——`video-tool.ts` 的 `prepareMediaInput` 里
 * `assertMinimaxCdnUrl` 先拦一道，第三方链接根本到不了模型。所以这一条不是
 * 保守，而是把事实写进入口。
 */
export const MINIMAX_CDN_HOST = 'cdn.hailuoai.com'

/**
 * 这条 URL 是不是 MiniMax 自己的 CDN 地址。
 *
 * @param text - 一条 URL。
 * @returns 主机名匹配时为 true。
 */
export function isMinimaxCdnUrl(text: string): boolean {
  try {
    const parsed = new URL(text)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname === MINIMAX_CDN_HOST
  } catch {
    return false
  }
}

/**
 * 一条文本是不是「有协议头的 URL」。
 *
 * 只看形如 `scheme://…` 与 `scheme:…` 的写法；Windows 盘符（`C:\…`）只有一个
 * 字母，会被这条规则误伤，所以单字母 scheme 除外。
 *
 * @param text - 一行文本。
 * @returns 命中的协议名（小写），没有则 undefined。
 */
export function urlSchemeOf(text: string): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(text.trim())
  return match?.[1].toLowerCase()
}

/**
 * 把 `file://` 地址还原成本机路径。
 *
 * 只处理最常见的两种写法：`file:///C:/x/y.png`（Windows）与
 * `file:///home/u/a.png`（POSIX）。解不出来就原样返回，让调用方按 URL 拒绝。
 *
 * @param url - 一条 `file:` 地址。
 * @returns 本机路径，或空串。
 */
export function pathFromFileUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return ''
    const pathname = decodeURIComponent(parsed.pathname)
    // Windows：pathname 形如 /C:/dir/a.png，去掉前导斜杠。
    return /^\/[a-zA-Z]:[\\/]/.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return ''
  }
}

/**
 * 把一行文本归一化成一条本机路径。
 *
 * 空行、`file:` 地址、普通路径都接受；其余带协议的（`http:`、`data:`、
 * `blob:`…）一律判为「网页链接」，由调用方提示用户先下载。
 *
 * @param line - 一行原始文本。
 * @returns 判定结果。
 */
export function normalizeMediaLine(line: string): { path: string } | { rejectedUrl: string } | undefined {
  const text = stripReferencePrefix(line.trim().replace(/^["']|["']$/g, '').trim())
  if (text === '') return undefined
  const scheme = urlSchemeOf(text)
  if (scheme === undefined) return { path: text }
  if (scheme === 'file') {
    const path = pathFromFileUrl(text)
    return path === '' ? { rejectedUrl: text } : { path }
  }
  // MiniMax 自己的 CDN 是服务端唯一会去读的 URL；其余公网地址先下载到本机。
  if (isMinimaxCdnUrl(text)) return { path: text }
  // 单字母 scheme 已被 urlSchemeOf 排除，所以这里一定是真 URL。
  return { rejectedUrl: text }
}

/**
 * 去掉输入框里引用工作区文件的那一个 `@`。
 *
 * `@docs/a.png` 是**对话框**里引用文件的写法，而工具参数收的是普通路径。用户
 * 从对话里原样复制一行过来时，这个前缀跟着一起来，所以在这里去掉——只去一个，
 * 且只在它后面还有内容时去（`@` 本身不是路径）。
 *
 * @param text - 一行原始文本。
 * @returns 去掉前导 `@` 的文本。
 */
export function stripReferencePrefix(text: string): string {
  return text.startsWith('@') && text.length > 1 ? text.slice(1) : text
}

/**
 * 把粘贴板里的一段文字归一化成路径。
 *
 * 支持多行、去重；`text/uri-list` 的注释行（以 `#` 开头）按规范忽略。
 *
 * @param text - 粘贴板文字。
 * @returns 归一化结果。
 */
export function intakeFromText(text: string): MediaIntake {
  const paths: string[] = []
  const rejectedUrls: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const normalized = normalizeMediaLine(line)
    if (normalized === undefined) continue
    if ('rejectedUrl' in normalized) {
      if (!rejectedUrls.includes(normalized.rejectedUrl)) rejectedUrls.push(normalized.rejectedUrl)
      continue
    }
    if (!paths.includes(normalized.path)) paths.push(normalized.path)
  }
  return { paths, rejectedUrls, withoutPath: 0 }
}

/**
 * 把一批 `File` 归一化成路径。
 *
 * 拿不到路径的文件计入 `withoutPath`，**不进** `paths`：界面据此说一句实话，而
 * 不是塞一条空路径进表单。
 *
 * @param files - 拖入或选中的文件。
 * @param bridge - 路径来源，缺省读宿主桥。
 * @returns 归一化结果。
 */
export function intakeFromFiles(files: readonly File[], bridge?: HostPathBridge | undefined): MediaIntake {
  const paths: string[] = []
  let withoutPath = 0
  for (const file of files) {
    const path = hostPathForFile(file, bridge)
    if (path === '') { withoutPath += 1; continue }
    if (!paths.includes(path)) paths.push(path)
  }
  return { paths, rejectedUrls: [], withoutPath }
}

/**
 * 合并两份归一化结果。
 *
 * @param left - 先到的。
 * @param right - 后到的。
 * @returns 合并结果（去重顺序保持）。
 */
export function mergeIntake(left: MediaIntake, right: MediaIntake): MediaIntake {
  const paths = [...left.paths]
  for (const path of right.paths) if (!paths.includes(path)) paths.push(path)
  const rejectedUrls = [...left.rejectedUrls]
  for (const url of right.rejectedUrls) if (!rejectedUrls.includes(url)) rejectedUrls.push(url)
  return { paths, rejectedUrls, withoutPath: left.withoutPath + right.withoutPath }
}

/** 媒体类别：决定一条路径进哪一栏。 */
export type MediaKind = 'image' | 'video' | 'audio' | 'unknown'

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'avif']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg', 'mpg']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']

/**
 * 按后缀判断一条路径属于哪一栏。
 *
 * 只看后缀名：浏览器里没有文件系统，问不了 MIME；而服务端本来就按路径读盘，
 * 后缀是它唯一能用的线索。
 *
 * @param path - 一条路径。
 * @returns 类别；认不出时是 `unknown`。
 */
export function mediaKindOf(path: string): MediaKind {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path.trim())
  const extension = match?.[1].toLowerCase()
  if (extension === undefined) return 'unknown'
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video'
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio'
  return 'unknown'
}

/** 一条已经收下的参考媒体：路径 + 它在界面上显示的名字。 */
export interface MediaEntry {
  readonly path: string
  readonly name: string
}

/**
 * 从一条路径取出显示名（最后一段，兼容两种分隔符）。
 *
 * @param path - 一条路径。
 * @returns 用于界面上的名字。
 */
/**
 * 一条路径是不是「需要单独给时长」的远端视频。
 *
 * 本机文件由宿主从容器里读时长；CDN 上的链接读不到（宿主不下拉去量），所以
 * 那一条必须在旁边写一个秒数，否则提交会被 `MINIMAX_VIDEO_REFERENCE_DURATION_REQUIRED`
 * 拒掉。
 *
 * @param path - 一条路径或 URL。
 * @returns 需要用户手填时长时为 true。
 */
export function needsDuration(path: string): boolean {
  return isMinimaxCdnUrl(path)
}

export function mediaNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')
  return parts[parts.length - 1] ?? path
}
