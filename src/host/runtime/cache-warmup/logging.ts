/**
 * 「缓存预热」的结构化指标日志。
 *
 * 这个文件只做一件事：把一个**指标**形状的事件序列化成一行 JSON。它不碰原文、
 * 不碰凭据、不碰路径——日志会被收进部署方的日志管道，一条原文进去就把整个工具
 * 结果的体积原样复制了一份，一条凭据进去就是一次泄露。
 *
 * 形状按 `event` 判别，每个分支只允许出现它自己那几个字段：
 *
 * - `projection`：一次 post-execute 投影的输入/输出字符数与所选策略；
 * - `ref-page`：一次 ref 分页读取（读了多少、是否读完、下一页从哪开始）；
 * - `ref-release`：一次引用释放；
 * - `warmup-exit`：本会话的预热窗口结束（连同结束时的命中率指标）。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/logging
 */

/** 预热窗口退出时的判定原因（取值有限，便于按值统计）。 */
export type CacheWarmupExitReason =
  /** 命中率已经稳定在阈值之上：预热算成功。 */
  | 'settled'
  /** 命中率没跟上来：预热失败，回到保守行为。 */
  | 'dropped'

/** 一次投影的日志记录。 */
export interface CacheWarmupProjectionLog {
  readonly event: 'projection'
  /** 会话标识（只用于把指标归到会话，不含任何正文）。 */
  readonly session: string
  /** 核心选中的策略名（`raw` / `preview` 之类）。 */
  readonly strategy: string
  /** 本次是否真的替换了内容。 */
  readonly changed: boolean
  /** 投影前内容的字符数。 */
  readonly inputChars: number
  /** 投影后内容的字符数。 */
  readonly outputChars: number
  /** 被省略（只剩 preview 指向）的字符数。 */
  readonly omittedChars: number
  /** 会话是否处在预热窗口内。 */
  readonly warmup?: boolean
}

/** 一次 ref 分页读取的日志记录。 */
export interface CacheWarmupPageLog {
  readonly event: 'ref-page'
  readonly session: string
  /** `ref://<session>/<sha256>` 形式的引用（本身不含原文）。 */
  readonly refId: string
  /** 本次读取的起始偏移。 */
  readonly offset: number
  /** 本次真正读到的字符数。 */
  readonly returnedChars: number
  /** 这一次读取是否已经读到结尾。 */
  readonly complete: boolean
  /** 下一次应从哪个偏移继续；`complete` 为真时没有这一项。 */
  readonly nextOffset?: number
}

/** 一次引用释放的日志记录。 */
export interface CacheWarmupReleaseLog {
  readonly event: 'ref-release'
  readonly session: string
  readonly refId: string
  /** 是否真的释放掉了（引用不存在时为 false，不算错误）。 */
  readonly released: boolean
}

/** 一次预热窗口退出的日志记录。 */
export interface CacheWarmupWarmupExitLog {
  readonly event: 'warmup-exit'
  readonly session: string
  readonly reason: CacheWarmupExitReason
  /** 退出时的连续命中次数（读不到就省略）。 */
  readonly consecutiveHits?: number
  /** 退出时的命中率（读不到就省略）。 */
  readonly hitRatio?: number
}

/** 本模块产出的全部日志事件。 */
export type CacheWarmupLogEvent =
  | CacheWarmupProjectionLog
  | CacheWarmupPageLog
  | CacheWarmupReleaseLog
  | CacheWarmupWarmupExitLog

/** 日志行前缀，便于在混合日志里一眼认出来源。 */
export const CACHE_WARMUP_LOG_PREFIX = '[cache-warmup]'

/** 日志面（可选：本插件的 logger 老宿主上可能只有一部分成员）。 */
export interface CacheWarmupLogger {
  /** 常规信息行。 */
  info?(message: string): void
  /** 警告行。 */
  warn?(message: string): void
}

/**
 * 把一条事件序列化成日志行。
 *
 * 形状写死在这里，而不是让调用方自己拼字符串：任何一次「顺手把 content 也带进
 * 去」的改动都只会发生在这个函数里，而它有测试盯着（断言日志里不含原文）。
 * 值为 `undefined` 的字段直接不出现在行里，保持每一行只描述它确实测到的指标。
 * @param event - 指标事件。
 * @returns 一行日志文本（带上本模块前缀）。
 */
export function formatCacheWarmupLog(event: CacheWarmupLogEvent): string {
  const record: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(event as unknown as Record<string, unknown>)) {
    // 只认三种标量：一次意外塞进来的对象/数组（原文、块数组）会被静默丢掉，
    // 而不是被 JSON.stringify 原样写进日志。
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      record[key] = value
    }
  }
  return CACHE_WARMUP_LOG_PREFIX + ' ' + JSON.stringify(record)
}

/**
 * 把一个异常压成**稳定的身份标签**，只用于宿主日志。
 *
 * 只取两样东西：`name`（构造器名；缺失或不是非空字符串时退成 `'Error'`）和
 * `code`（有就带上——`CacheWarmupStoreError` 与 Node 的系统错误都靠它区分）。
 *
 * **`message` 一律不进日志**，这是本函数存在的全部理由：异常消息里常常带着绝对
 * 路径、命令行片段、凭据，或者被读取结果的一段原文。一条日志就够把原文复制一份，
 * 或者把主机的目录结构写进部署方的日志管道。想知道"哪一类错误、来自哪一层"，
 * name/code 就够了；想知道"具体哪一条",该去会话本身看，不该从日志里捞。
 * @param error - 捕获到的任意值。
 * @returns 形如 `Error`、`RangeError`、`CacheWarmupStoreError/SESSION_MISMATCH`
 *   的标签（`code` 是非空字符串时以 `/` 连接）。
 */
export function cacheWarmupErrorLabel(error: unknown): string {
  // 非对象抛出物（`throw 'oops'`、`throw 42`）没有稳定身份：只报 `Error`，
  // 绝不复述那个值本身——它同样可能是一整段原文。
  if (typeof error !== 'object' || error === null) return 'Error'
  const record = error as { readonly name?: unknown, readonly code?: unknown }
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'Error'
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : undefined
  return code === undefined ? name : name + '/' + code
}

/**
 * 发一条指标日志。
 *
 * logger 缺席时**安静跳过**：日志不是功能，装不上日志服务的宿主不该因此装不上
 * 这个模块。写入失败同样吞掉——一条日志把工具调用搞挂是最不划算的失败。
 * @param logger - 宿主 logger（可选）。
 * @param event - 指标事件。
 * @returns 写出的那一行（调用方/测试可以拿去断言）；没写出去时 undefined。
 */
export function logCacheWarmup(logger: CacheWarmupLogger | undefined, event: CacheWarmupLogEvent): string | undefined {
  const line = formatCacheWarmupLog(event)
  const info = logger?.info
  if (typeof info !== 'function') return undefined
  try {
    info.call(logger, line)
  } catch {
    return undefined
  }
  return line
}
