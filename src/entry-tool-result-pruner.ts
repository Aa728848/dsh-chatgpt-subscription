/**
 * 「工具结果修剪器」的宿主入口 —— 本包自己的 loader 行（fork 版）。
 *
 * DSH 官方的 `@deepseek-ai/dsh-compaction-tool-result-pruner` 只按**字符预算**
 * 修剪历史工具结果：超过 `thresholdChars` 的文本按码点保留头部与尾部、中间换成
 * 固定标记，再以 `surfaceOp: replace` 追加一条新的 `tool/result`，并紧挨着写一条
 * `compaction/prune` 计价事件。这套语义本身与 provider 无关，本文件逐字照搬，
 * 因此行为可以与官方实现一一对照。
 *
 * 与官方实现的两点差别，也正是 "fork" 的全部理由：
 *
 * 1. **provider 感知的跳过**。缓存前缀型 provider（`kimi-code`）上，改写历史工具
 *    结果会把 provider 侧的 content-prefix 缓存从被改写点一直作废到对话末尾：
 *    实测 838k token 的会话里，一次修剪省下约 418k token 的上下文，却要按全价
 *    重建约 414k token 的前缀，比摘要式压缩贵得多。所以对这类 provider 直接跳过，
 *    一次都不改历史。
 * 2. **不 import 任何 harness 的 compaction/session/token-meter 包**。本包的
 *    `peerDependencies` 里没有它们（也不该有：装不装它们不该由本包决定），
 *    所以全部按**结构契约**描述：`SessionLike` / `SessionEventLike` /
 *    `ToolResultMessageLike` 都是本文件里的局部接口，`deepFreeze` 也是本地实现。
 *    这样从 0.1.2-alpha.5 到 0.2.1-rc.3 的每一代 harness 都能解析这个模块。
 *
 * 与官方实现的一致性以测试锁定：`test/tool-result-pruner.test.ts` 覆盖配置校验、
 * 代理对不劈开、非文本块不计价、以及 `compaction/prune` 与替换事件的先后顺序。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/tool-result-pruner
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

// ── 冻结契约 ───────────────────────────────────────────────────────────────

/** 替换被删除中间段的固定标记。与官方实现逐字一致。 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** 编码代理工具输出的低摩擦默认值。与官方实现逐字一致。 */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

/**
 * 默认跳过的 provider。
 *
 * `kimi-code` 是缓存前缀型 provider：改写历史工具结果会让 provider 侧的前缀
 * 缓存从改写点失效到对话末尾，重建成本高于修剪省下的输入。这个名单可以通过
 * 配置 `skipProviders` 整体替换（传空数组即恢复"对所有 provider 都修剪"）。
 */
export const DEFAULT_SKIP_PROVIDERS: readonly string[] = deepFreeze(['kimi-code'])

// ── 配置 ───────────────────────────────────────────────────────────────────

/** 字符预算策略；额外带一个 provider 跳过名单。 */
export interface ToolResultPruneConfig {
  /** 合并文本超过这么多 Unicode 码点时修剪。默认 8192。 */
  thresholdChars?: number
  /** 保留的最大头部码点数。默认 4096。 */
  headChars?: number
  /** 保留的最大尾部码点数。默认 1024。 */
  tailChars?: number
  /**
   * 命中即整场跳过修剪的 provider id 名单。默认 `['kimi-code']`。
   *
   * 与官方实现的三个数值配置项并列接受，因此把官方配置原样搬过来不会因为
   * "未知键" 报错。
   */
  skipProviders?: readonly string[]
}

/** 校验后、已脱离原对象且深冻结的修剪配置。 */
export interface ResolvedConfig {
  /** 修剪阈值（Unicode 码点数）。 */
  readonly thresholdChars: number
  /** 头部保留码点数。 */
  readonly headChars: number
  /** 尾部保留码点数。 */
  readonly tailChars: number
}

/** 一条已落地的替换：被遮蔽的原事件与它的大小账。 */
export interface PrunedEntry {
  /** 被替换事件遮蔽的完整保真工具结果事件。 */
  readonly originalSeq: number
  /** 新追加的已修剪工具结果事件。 */
  readonly replacementSeq: number
  /** 原事件与替换事件共享的工具调用 id（运行期是字符串）。 */
  readonly callId: string
  /** 原文本大小（Unicode 码点数）。 */
  readonly charsBefore: number
  /** 替换文本大小（Unicode 码点数）。 */
  readonly charsAfter: number
}

/** 一次稳定表层修剪的汇总结果。 */
export interface PruneResult {
  /** 按表层快照顺序排列的替换。 */
  readonly pruned: readonly PrunedEntry[]
  /** 所有替换合计省下的 Unicode 码点数。 */
  readonly charsRemoved: number
}

/**
 * 服务名契约。
 *
 * 宿主级守卫要按名字在 `ctx.reflect.store` 与 `agent.ctx.get()` 里找实例，
 * 所以这个名字必须导出一份，不能在两处各写一个字符串字面量。
 */
export const PRUNER_SERVICE_NAME = 'toolResultPruner'

/** 允许出现在配置里的键。 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
  'skipProviders',
])

// ── 结构契约（不 import 任何 harness 运行时包） ────────────────────────────

/** 与 `@deepseek-ai/dsh-llm` 的 `ToolResultMessage` 结构对齐的局部形状。 */
export interface ToolResultMessageLike {
  /** 工具结果内容块。 */
  readonly content?: readonly ContentBlock[]
  /** 消息来源；工具结果带 `callId`。 */
  readonly source?: { readonly callId?: unknown }
  /** 其余字段原样保留（meta、isError、未来新增字段等）。 */
  readonly [key: string]: unknown
}

/** 一条会话事件的结构形状（只用到 `type` / `data`）。 */
export interface SessionEventLike {
  /** 事件类型标签。 */
  readonly type?: string
  /** 事件在日志里的序号。 */
  readonly seq?: number
  /** 事件负载；`tool/result` 带 `message`。 */
  readonly data?: unknown
}

/** 会话表层：被当前请求实际引用的节点序号。 */
export interface SessionSurfaceLike {
  /** 当前表层节点序号（有序）。 */
  readonly nodes?: readonly number[]
}

/**
 * 会话的最小结构契约。
 *
 * 刻意保留 `eventAt` / `deriveEventMessage` / `append` 的**宽松签名**：
 * 各代 harness 的 `Session` 实现签名不同（品牌化的 `SessionSeq`、不同的负载
 * 联合类型），把它们写成硬约束会让真会话反而"不满足"这个接口。
 */
export interface SessionLike {
  /** 当前表层。 */
  readonly surface?: SessionSurfaceLike
  /** 按序号取事件。 */
  eventAt(seq: number): SessionEventLike | undefined
  /** 把事件还原成一条消息。 */
  deriveEventMessage(event: SessionEventLike): unknown
  /** 追加一条事件并返回它的落点。 */
  append(type: string, data: unknown, options?: unknown): { readonly seq: number }
}

/** 会话读取 provider 的两种形状（跨代差异）。 */
interface ProviderReadableSession {
  /** 请求头快照：provider 记录在 `config.provider`。 */
  requestHeader?: () => { config?: { provider?: unknown } } | undefined
  /** 部分代可能直接暴露的扁平字段。 */
  provider?: unknown
}

// ── 工具函数 ───────────────────────────────────────────────────────────────

/**
 * 本地深冻结。
 *
 * 不 import `deepFreeze` 的 harness 实现（`@deepseek-ai/dsh-util-values` 不在
 * 本包依赖里），但语义保持一致：冻结自身与所有对象型子值，返回同一个引用。
 *
 * @param value - 待冻结的值。
 * @returns 同一个引用，已就地冻结。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== null && typeof child === 'object') deepFreeze(child)
  }
  return value
}

/**
 * 按 Unicode 码点计数，不劈开代理对。
 *
 * @param text - 待测量的文本。
 * @returns 码点数。
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * 校验并解析字符预算。
 *
 * 校验规则与官方实现逐字对齐：未知键报错、`thresholdChars` 必须为正整数、
 * 头尾必须为非负整数、且 `headChars + marker + tailChars` 不得超过阈值。
 *
 * @param config - 原始配置。
 * @returns 已脱离原对象且深冻结的配置。
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars, skipProviders)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

/**
 * 把跳过名单解析成一个只读集合。
 *
 * @param skipProviders - 配置里的名单；省略时用 {@link DEFAULT_SKIP_PROVIDERS}。
 * @returns 只读集合（每次调用都是新的实例）。
 */
export function resolveSkipProviders(skipProviders?: readonly string[]): ReadonlySet<string> {
  const source = skipProviders ?? DEFAULT_SKIP_PROVIDERS
  return new Set(source)
}

/** 单例化的默认跳过集合，省掉热路径上的重复分配。 */
let defaultSkipProviderSet: ReadonlySet<string> | undefined

/**
 * 默认跳过集合（惰性单例）。
 *
 * @returns `['kimi-code']` 对应的只读集合。
 */
function defaultSkipProviders(): ReadonlySet<string> {
  defaultSkipProviderSet ??= new Set(DEFAULT_SKIP_PROVIDERS)
  return defaultSkipProviderSet
}

/**
 * 读会话的 provider id。
 *
 * 先读 `requestHeader().config.provider`（新代的权威来源），读不到再退回扁平
 * 的 `session.provider`（跨代兼容形状）。任何一步抛错都只是"读不到"，不影响
 * 修剪本身。
 *
 * @param session - 任意会话对象。
 * @returns provider id，读不到时为 `undefined`。
 */
export function readSessionProvider(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const candidate = session as ProviderReadableSession
  if (typeof candidate.requestHeader === 'function') {
    try {
      const provider = candidate.requestHeader()?.config?.provider
      if (typeof provider === 'string' && provider.length > 0) return provider
    } catch {
      // 老代没有请求头快照，或快照在会话结束前不可读：退回扁平字段。
    }
  }
  const flat = candidate.provider
  if (typeof flat === 'string' && flat.length > 0) return flat
  return undefined
}

/**
 * 判断这一场会话是否应当整场跳过修剪。
 *
 * 判定只依赖会话本身，不读事件、不写日志：命中时 {@link ToolResultPruner.pruneSession}
 * 会在任何读写之前直接返回空结果。
 *
 * @param session - 任意会话对象。
 * @param skipProviders - 跳过名单；省略时用默认的 `['kimi-code']`。
 * @returns 命中名单时为 `true`。
 */
export function shouldSkipPruningForSession(
  session: unknown,
  skipProviders: ReadonlySet<string> = defaultSkipProviders(),
): boolean {
  const provider = readSessionProvider(session)
  if (provider === undefined) return false
  return skipProviders.has(provider)
}

/**
 * 断言一个正整数配置项。
 *
 * @param name - 配置项名，用于报错文案。
 * @param value - 配置值。
 */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

/**
 * 断言一个非负整数配置项。
 *
 * @param name - 配置项名，用于报错文案。
 * @param value - 配置值。
 */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}

/**
 * 判断一个值是否是普通对象。
 *
 * @param value - 任意值。
 * @returns 是非 null 的对象时为 `true`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从事件负载里取工具结果消息。
 *
 * @param event - 一条 `tool/result` 事件。
 * @returns 消息形状；取不到时为 `undefined`。
 */
function readEventMessage(event: SessionEventLike): ToolResultMessageLike | undefined {
  const data = event.data
  if (!isRecord(data)) return undefined
  const message = data['message']
  if (!isRecord(message)) return undefined
  return message as ToolResultMessageLike
}

/**
 * 读一条工具结果的工具调用 id。
 *
 * 优先读事件负载（`event.data.message.source.callId`，与官方实现一致），读不到
 * 再退回已派生消息上的同名字段。
 *
 * @param event - 一条 `tool/result` 事件。
 * @param message - 由该事件派生出的消息。
 * @returns 字符串形式的 callId；读不到时为空字符串。
 */
function readCallId(event: SessionEventLike, message: ToolResultMessageLike | undefined): string {
  const fromEvent = readEventMessage(event)?.source?.callId
  const fromMessage = message?.source?.callId
  const raw = fromEvent ?? fromMessage
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return ''
  return String(raw)
}

// ── 服务 ───────────────────────────────────────────────────────────────────

/**
 * 确定性的、免模型的工具结果修剪服务（provider 感知版）。
 *
 * 与官方实现的差别只在两处：`pruneSession` 先按 provider 判定是否整场跳过，
 * 且 token 计价走结构探测（`ctx.tokenMeter` 缺失时按 0 计），因此这一行在没有
 * token-meter 的宿主上也能工作。
 */
export class ToolResultPruner extends Service {
  /**
   * 每个被遮蔽节点都要计价，所以修剪确实需要计价能力。
   *
   * 声明成注入依赖是为了拿到 harness 提供的 meter；实现里仍按结构探测读取，
   * 这样直接 `new` 出来的实例（测试、宿主自建）不会因为缺服务而炸掉。
   */
  static inject = ['tokenMeter']

  /** loader 侧的配置 schema：与官方实现同样的三个数值项。 */
  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** 解析后不可变的字符预算。 */
  readonly config: ResolvedConfig

  /** 命中即整场跳过的 provider 集合。 */
  readonly skipProviders: ReadonlySet<string>

  /**
   * @param ctx - 宿主上下文（服务自注册为 `toolResultPruner`）。
   * @param config - 原始配置。
   */
  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, PRUNER_SERVICE_NAME)
    this.config = resolveConfig(config)
    this.skipProviders = resolveSkipProviders(config.skipProviders)
  }

  /**
   * 只统计文本块的码点数；非文本块不计价。
   *
   * @param blocks - 待测量的工具结果内容。
   * @returns 所有 text 块的码点数合计。
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * 把超预算的文本中间段换成标记，同时保留富内容块的顺序。
   *
   * 切片按 Unicode 码点而不是 UTF-16 码元，因此保留边界不会劈开代理对；
   * 字素簇仍可能被切开（与官方实现一致）。
   *
   * @param blocks - 原始工具结果内容。
   * @returns 已修剪的内容；文本在预算内时为 `null`。
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * 从当前稳定表层快照修剪所有超预算的工具结果。
   *
   * **provider 判定在最前面**：命中跳过名单时直接返回空结果，既不读事件也不
   * 追加事件，所以缓存前缀型 provider 的会话日志一次都不会被动过。
   *
   * 每条替换原样保留除 `content` 之外的全部事件数据，引用被遮蔽的节点让回放
   * 能还原替换输入，并在它之前紧挨着写一条 `compaction/prune` 计价事件，让纯
   * 消费者不需要按节点保存状态就能减掉被遮蔽节点的启发式价格。
   *
   * @param session - 表层会被改写的会话。
   * @returns 已落地的替换与合计省下的码点数。
   */
  pruneSession(session: SessionLike): PruneResult {
    if (shouldSkipPruningForSession(session, this.skipProviders)) {
      return { pruned: [], charsRemoved: 0 }
    }

    const candidates: Array<{ seq: number; event: SessionEventLike }> = []
    for (const seq of [...(session.surface?.nodes ?? [])]) {
      const event = session.eventAt(seq)
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const original = session.deriveEventMessage(event) as ToolResultMessageLike
      const content = this.pruneContent(original.content ?? [])
      if (content === null) continue
      const charsBefore = this.measureContent(original.content ?? [])
      const charsAfter = this.measureContent(content)
      const message: ToolResultMessageLike = Object.freeze({
        ...original,
        content: Object.freeze([...content]),
      })
      const data = isRecord(event.data) ? event.data : {}
      // 计价事件与替换事件同步紧挨着追加：纯消费者因此可以只按日志顺序相减。
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.estimateMessageTokens(original),
      })
      const replacement = session.append('tool/result', {
        ...data,
        message,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: readCallId(event, original),
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }

  /**
   * 用宿主注入的 token meter 估计一条消息的价格。
   *
   * 按结构探测而不是按注入硬取：token-meter 在部分宿主上不存在，而修剪必须在
   * 那种宿主上照常工作；读不到就按 0 计。
   *
   * @param message - 被遮蔽的消息。
   * @returns 估计的 token 数；不可用时为 0。
   */
  private estimateMessageTokens(message: unknown): number {
    try {
      const meter = (this.ctx as unknown as {
        tokenMeter?: { estimateMessage?: (subject: unknown) => number }
      }).tokenMeter
      const estimate = meter?.estimateMessage?.(message)
      if (typeof estimate === 'number' && Number.isFinite(estimate)) return estimate
    } catch {
      // 没有 meter，或这一代的 meter 形状不同：按 0 计。
    }
    return 0
  }
}

export default ToolResultPruner
