/**
 * 「缓存预热」宿主集成的挂载点。
 *
 * 这个文件把核心（结果投影、预算、引用存储、指标）接到宿主上，挂四样东西：
 *
 * 1. `tools/post-execute` 上的**新结果投影**：Kimi 线路的 `run_code` 结果交给
 *    `projectToolResult`，能可靠结构化提取的大结果被换成带 `ref://` 引用的预览；
 * 2. `cache_warmup_result` 工具（`result-tool.ts`），预览的唯一精确补读入口；
 * 3. 一段**静态**系统提示词引导（见 `CACHE_WARMUP_GUIDANCE`）；
 * 4. 结构化指标日志（`logging.ts`）。
 *
 * ## 只处理新结果
 *
 * post-execute 是每条工具结果各触发一次的**当下**事件：这里改的只是这次调用即将
 * 写进历史的 content。历史里已经落下的结果不会被回改，`promptCacheKey`、replay、
 * mapper、动态工具 in-history 机制一概不碰——它们读的是同一个 content，改历史
 * 等于让同一个会话两次重放得到两段不同的字节。
 *
 * 因此开关的语义是**只影响之后的新结果**：关掉之后，已有的 preview/refId 继续
 * 存在、继续可读（引用过期与否归存储管），只是不再产生新的。
 *
 * ## 可选服务一律走 `ctx.get()`
 *
 * `tools` 与 `systemPrompt` 都不在本插件的 `inject` 里（前者由宿主另装，后者
 * 出现与否随 harness 代次）。Cordis 对没写进 `inject` 的服务直接读属性会抛
 * `cannot get property "..." without inject`，一次就够把整个插件打成 degraded。
 * 所以这里全部是**调用时**的 `get()`，缺席就安静降级：没有 tools 就不注册工具，
 * 没有 systemPrompt 就不挂引导，插件照样挂得上。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/install
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  CACHE_WARMUP_DEFAULTS,
  FileResultReferenceStore,
  cacheWarmupBudget,
  cacheWarmupSnapshot,
  projectToolResult,
  type CacheWarmupDurableHint,
  type PreviewBudget,
  type ProjectionResult,
  type ResultReferenceStore,
} from './index.ts'
import {
  cacheWarmupErrorLabel,
  logCacheWarmup,
  type CacheWarmupExitReason,
  type CacheWarmupLogEvent,
  type CacheWarmupLogger,
} from './logging.ts'
import { createCacheWarmupResultTool } from './result-tool.ts'
import type { CacheWarmupSettings } from './settings.ts'

/**
 * 本模块服务的线路。
 *
 * 结果投影的正确性依赖这条线路的缓存语义（内容前缀命中），别的线路上把结果换成
 * 预览只有坏处没有好处，所以这里写死一个 provider 名而不是做成开关。
 */
export const CACHE_WARMUP_PROVIDER = 'kimi-code'

/**
 * 默认被投影的主工具名（保留导出供向后兼容）。
 */
export const CACHE_WARMUP_SOURCE_TOOL = 'run_code'

/**
 * 允许进入结果投影的工具集合。
 *
 * 除了 PTC 的 `run_code`，宿主的独立 Shell 与后台任务输出工具（`win_bash`、
 * `bash`、`pwsh`、`job_output`）同样经常吐出整屏测试/构建日志。源码读取/编辑类
 * 工具（`read`、`edit`、`grep`、`glob`、CodeGraph 等）不在此列，保持 100% 原样。
 */
export const CACHE_WARMUP_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'run_code',
  'win_bash',
  'bash',
  'pwsh',
  'job_output',
])

/** 提示词分节名，全局唯一（重复注册会抛错）。 */
export const CACHE_WARMUP_SECTION_NAME = 'plugin:cache-warmup'

/**
 * 引导词在提示词里的排序位。
 *
 * 插件族占用的区间在部署人设之后、SDK 的 `PLAN_POLICY`(500) 之前；进展更新占了
 * 220，这里取 225，紧挨着它但不并列。
 */
export const CACHE_WARMUP_SECTION_ORDER = 225

/**
 * 一段**恒定**的引导词：告诉模型预览是什么、怎么补读。
 *
 * 文本与开关无关，这是刻意的——系统提示是缓存前缀的第一段，会话中途改一个字就
 * 让整段前缀失效、整段重新计费。开关的语义只交给 post-execute 与工具。
 */
export const CACHE_WARMUP_GUIDANCE = [
  '## Result previews',
  '',
  'On large `run_code` results this line may replace the output with a preview: a short description plus one or more `ref://<session>/<sha256>` handles.',
  '',
  '- A preview is **not** the full result. It states `complete`, `omitted` and `nextOffset` explicitly; treat an incomplete preview as incomplete data, not as the whole output.',
  '- To read the original, call `cache_warmup_result` with `action: "page"` and that `refId`, then follow `nextOffset` until `complete` is true.',
  '- `action: "release"` drops the stored copy. The preview already in the conversation stays identical; it simply can no longer be read back.',
  '- Source code, type and contract definitions, mixed evidence and anything that could not be parsed reliably are never replaced: they arrive in full.',
].join('\n')

/**
 * 静态引导词的文本提供者。
 * @returns 一个永远返回同一段文本的函数（系统提示的稳定前缀）。
 */
export function cacheWarmupSectionText(): () => string {
  return () => CACHE_WARMUP_GUIDANCE
}

/** 一次工具调用所属的线路。 */
export interface CacheWarmupRoute {
  /** 当前会话被路由到的 provider id。 */
  readonly provider?: string
  /** 当前会话标识；引用归属、预算与命中率都按它记账。 */
  readonly sessionId?: string
}

/** 事件里 agent 上本模块会读的部分（结构化类型，不绑定 SDK 版本）。 */
interface CacheWarmupAgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly header?: { readonly id?: unknown }
    /** 会话当前被路由到的模型线路。老宿主上可能没有这个方法。 */
    requestHeader?(): { readonly config?: { readonly provider?: unknown } } | undefined
  }
  readonly options?: { readonly provider?: unknown }
}

/**
 * 读一次工具调用所属的线路。
 *
 * provider 先问会话的 request header（那是本轮请求真正走的那条线），再退回
 * agent 自己的 options。两处都没有就返回空对象——调用方据此放手，而不是猜一个。
 * @param agent - 事件里的调用方 agent。
 * @returns 线路信息；读不到的字段省略。
 */
export function cacheWarmupRouteOf(agent: unknown): CacheWarmupRoute {
  const record = (typeof agent === 'object' && agent !== null ? agent : undefined) as CacheWarmupAgentLike | undefined
  const session = record?.session
  let provider: string | undefined
  try {
    provider = stringOf(session?.requestHeader?.()?.config?.provider)
  } catch {
    // 会话正在拆除、或这一代宿主没有 requestHeader：退回 agent options。
    provider = undefined
  }
  if (provider === undefined) provider = stringOf(record?.options?.provider)
  // 会话 id 只认会话头，退一步才用 agent 自己的 id：前者是日志与引用归属的真名。
  const sessionId = stringOf(session?.header?.id) ?? stringOf(record?.id)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** 挂载选项。 */
export interface CacheWarmupOptions {
  /**
   * 读取当前设置。
   *
   * 必须是**函数**：loader 把 volatile 字段换成活引用，设置保存时就地写新值而不
   * 重挂插件行；apply 时求值一次存下来的写法会让开关在会话中途失效。
   */
  settings: () => CacheWarmupSettings
  /**
   * 结果引用存储。
   *
   * 缺省时按需构造一个 `FileResultReferenceStore()`（核心的 `CACHE_WARMUP_DEFAULTS`
   * 提供其余默认值）；注入一个工厂是为了让测试与别的部署换掉存储，而不必改这里。
   */
  store?: () => ResultReferenceStore | undefined
  /**
   * 进程重启后尚无内存报告时的持久化预热状态回退读取器（可选）。
   */
  durableHint?: (sessionId: string) => CacheWarmupDurableHint | undefined
}

/** 本模块读得到的宿主上下文（Cordis Context 结构上满足；测试可用假对象）。 */
export interface CacheWarmupContext {
  /** Cordis 的副作用登记：回调返回的 disposer 会随插件卸载执行。 */
  effect?<T>(execute: () => T, label?: string): unknown
  /** Cordis 的事件总线。 */
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  /** 服务查找：**调用时**读可选服务，不触发 inject 断言。 */
  get?(name: string): unknown
  /** 宿主 logger（可选）。 */
  logger?: CacheWarmupLogger
}

/** 工具服务注册面。 */
interface ToolsService {
  register(tool: ToolDefinition): () => void
}

/** 提示词分节注册面。 */
interface SystemPromptService {
  section(section: { name: string, order: number, text: () => string }): () => void
}

/** {@link cacheWarmupSnapshot} 读出来、本模块会用的那几个字段。 */
interface CacheWarmupSnapshotLike {
  readonly warmup?: unknown
  readonly consecutiveHits?: unknown
  readonly hitRatio?: unknown
}

/** 一次投影读到的会话级指标（与 {@link CacheWarmupSnapshotLike} 同形，但已收窄）。 */
interface CacheWarmupMetrics {
  readonly warmup?: boolean
  readonly consecutiveHits?: number
  readonly hitRatio?: number
}

/**
 * 预热窗口结束时，本次算「稳住了」还是「掉了」。
 *
 * 阈值取核心契约里的 `consecutiveHitsRequired`（连续高命中率报告条数），而不是在
 * 这里另编一个命中率——判定标准只有核心一份，日志只如实记录它当时的结论。
 * @param consecutiveHits - 退出时的连续命中条数；读不到时 undefined。
 * @returns 稳定的退出原因。
 */
function exitReasonOf(consecutiveHits: number | undefined): CacheWarmupExitReason {
  return consecutiveHits !== undefined && consecutiveHits >= CACHE_WARMUP_DEFAULTS.consecutiveHitsRequired
    ? 'settled'
    : 'dropped'
}

/** 单实例登记表，走一个 global symbol（与进展更新模块共用一个表）。 */
const MOUNTED = Symbol.for('dsh-chatgpt-subscription.mounted-modules')

/** 本模块在登记表里的名字。 */
const MODULE_ID = 'cache-warmup'

/**
 * 读一个未知值为非空字符串。
 * @param value - 候选值。
 * @returns 非空字符串，其它类型的 undefined。
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读一个未知值为有限数字。
 * @param value - 候选值。
 * @returns 有限数字，其它类型的 undefined。
 */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 读一个未知值为布尔。
 * @param value - 候选值。
 * @returns 布尔，其它类型的 undefined。
 */
function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 单实例守卫：本模块已挂载时放弃本次安装。
 * @param ctx - 宿主上下文。
 * @returns 释放函数（交出挂载权）；已经挂载过时返回 undefined。
 */
function claimMount(ctx: CacheWarmupContext): (() => void) | undefined {
  const registry = globalThis as { [MOUNTED]?: unknown }
  const existing = registry[MOUNTED]
  const mounted = existing instanceof Set ? existing as Set<string> : new Set<string>()
  if (existing !== mounted) registry[MOUNTED] = mounted
  if (mounted.has(MODULE_ID)) return undefined
  mounted.add(MODULE_ID)
  const release = (): void => { mounted.delete(MODULE_ID) }
  // 两条释放路径：调用方自己卸（返回值），以及整个上下文被拆掉时兜底。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => release, 'dsh-chatgpt-subscription: cache warmup mount')
  }
  return release
}

/**
 * 读一次会话级指标快照。
 *
 * 形状按共享约定**结构化**推断，任何字段缺失都不影响日志；读不出来就返回
 * undefined，让调用方退回预算对象上的那一份。
 * @param sessionId - 会话标识。
 * @returns 快照，或读不到时的 undefined。
 */
function readCacheWarmupSnapshot(sessionId: string): CacheWarmupSnapshotLike | undefined {
  try {
    const read = cacheWarmupSnapshot as unknown as (session?: string) => unknown
    const raw = read(sessionId)
    return typeof raw === 'object' && raw !== null ? raw as CacheWarmupSnapshotLike : undefined
  } catch {
    return undefined
  }
}

/**
 * 挂载「缓存预热」的宿主半边。
 * @param ctx - 宿主插件上下文。
 * @param options - 挂载选项（设置读取器、可选的存储工厂）。
 * @returns 卸载函数；重复挂载时返回一个空操作。
 */
export function installCacheWarmup(ctx: CacheWarmupContext, options: CacheWarmupOptions): () => void {
  const release = claimMount(ctx)
  if (release === undefined) return () => undefined

  /** 每次调用重新读服务：宿主树可能在本模块挂载之后才 settle，读一次存下来会漏。 */
  const serviceOf = <T>(name: string): T | undefined => {
    const read = ctx.get
    if (typeof read !== 'function') return undefined
    try {
      return read.call(ctx, name) as T | undefined
    } catch {
      // 这一代宿主没有这个服务：按缺席处理，而不是让整个 apply 抛出去。
      return undefined
    }
  }

  /** 登记一个副作用；上下文没有 effect 时立即执行（测试用假上下文）。 */
  const track = (execute: () => unknown, label: string): void => {
    if (typeof ctx.effect === 'function') ctx.effect(execute, label)
    else execute()
  }

  /** 日志出口（每次现读，logger 可能晚于本模块挂载）。 */
  const loggerOf = (): CacheWarmupLogger | undefined => ctx.logger ?? serviceOf<CacheWarmupLogger>('logger')

  /** 发一条指标日志。 */
  const log = (event: CacheWarmupLogEvent): void => {
    logCacheWarmup(loggerOf(), event)
  }

  /** 惰性构造出来的存储（注入优先）。 */
  let ownedStore: ResultReferenceStore | undefined

  /**
   * 取结果引用存储。
   *
   * 构造失败只意味着「这台主机上没有引用存储」：此时投影不生效（原样返回），
   * `cache_warmup_result` 返回结构化错误。都不是一次安装失败。
   * @returns 存储，或拿不到时的 undefined。
   */
  const storeOf = (): ResultReferenceStore | undefined => {
    if (options.store !== undefined) {
      try {
        return options.store()
      } catch (error) {
        // 只记稳定身份（name/code）：异常消息可能带着路径、命令片段或原文。
        loggerOf()?.warn?.('[dsh-chatgpt-subscription] cache warmup store injection failed: ' + cacheWarmupErrorLabel(error))
        return undefined
      }
    }
    if (ownedStore !== undefined) return ownedStore
    try {
      // 构造参数由核心的 CACHE_WARMUP_DEFAULTS 补齐；这里不替它编造路径或上限。
      const construct = FileResultReferenceStore as unknown as new () => ResultReferenceStore
      ownedStore = new construct()
    } catch (error) {
      loggerOf()?.warn?.('[dsh-chatgpt-subscription] cache warmup store unavailable: ' + cacheWarmupErrorLabel(error))
      return undefined
    }
    return ownedStore
  }

  // 工具：始终注册。存储缺席或开关关闭时返回结构化错误/原样结果，而不是让工具
  // 清单在会话中途变化（那会让整段工具前缀失效）。
  track(() => {
    const tools = serviceOf<ToolsService>('tools')
    if (tools === undefined) {
      // 老宿主、或工具服务比本模块晚 settle：安静降级。
      return () => undefined
    }
    return tools.register(createCacheWarmupResultTool({
      provider: CACHE_WARMUP_PROVIDER,
      routeOf: exec => cacheWarmupRouteOf((exec as { agent?: unknown } | undefined)?.agent),
      store: storeOf,
      log,
    }))
  }, 'dsh-chatgpt-subscription: cache warmup result tool')

  // 引导词：文本恒定，不随开关变化（见 CACHE_WARMUP_GUIDANCE）。systemPrompt 是
  // 可选服务：没装它的宿主上这条引导不存在，插件照样工作。
  track(() => {
    const systemPrompt = serviceOf<SystemPromptService>('systemPrompt')
    if (systemPrompt === undefined) return () => undefined
    return systemPrompt.section({
      name: CACHE_WARMUP_SECTION_NAME,
      order: CACHE_WARMUP_SECTION_ORDER,
      text: cacheWarmupSectionText(),
    })
  }, 'dsh-chatgpt-subscription: cache warmup prompt section')

  /** 上一轮看到的预热状态，用来在窗口结束时发一条 `warmup-exit`。 */
  const warmupState = new Map<string, boolean>()

  /**
   * 记账并（必要时）发一条 `warmup-exit`。
   * @param sessionId - 会话标识。
   * @param budget - 本轮读到的预算对象。
   */
  const trackWarmup = (sessionId: string, budget: PreviewBudget): CacheWarmupMetrics => {
    const snapshot = readCacheWarmupSnapshot(sessionId)
    const warmup = booleanOf(snapshot?.warmup) ?? booleanOf(budget.warmup)
    const consecutiveHits = numberOf(snapshot?.consecutiveHits) ?? numberOf(budget.consecutiveHits)
    const hitRatio = numberOf(snapshot?.hitRatio) ?? numberOf(budget.hitRatio)
    const previous = warmupState.get(sessionId)
    if (previous === true && warmup === false) {
      const reason = exitReasonOf(consecutiveHits)
      log({
        event: 'warmup-exit',
        session: sessionId,
        reason,
        ...(consecutiveHits === undefined ? {} : { consecutiveHits }),
        ...(hitRatio === undefined ? {} : { hitRatio }),
      })
    }
    if (warmup !== undefined) warmupState.set(sessionId, warmup)
    return {
      ...(warmup === undefined ? {} : { warmup }),
      ...(consecutiveHits === undefined ? {} : { consecutiveHits }),
      ...(hitRatio === undefined ? {} : { hitRatio }),
    }
  }

  /**
   * 一次工具结果的投影。
   *
   * 决策取舍写在代码里，因为它全是「什么时候**不动**」：
   * - 不是 `accept`（`block` 的 feedback 是别人的东西）；
   * - 已经带 `value`（执行本地的 canonical 值，replay 与结构化消费方读它，
   *   替换掉等于把一份 JSON 换成字符串）；
   * - 工具名不是 `run_code`、线路不是本线、会话拿不到；
   * - 没有存储、内容为空。
   * 上面任何一条成立就原样返回同一个决策对象。
   * @param exec - 工具执行上下文。
   * @param result - 归一化后的执行结果。
   * @param decision - `next()` 交回来的决策。
   * @returns 投影后的决策（形状不变），或原决策。
   */
  const projectDecision = async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    decision: PostToolDecision,
  ): Promise<PostToolDecision> => {
    if (decision.kind !== 'accept') return decision
    if (decision.value !== undefined) return decision
    if (!CACHE_WARMUP_SOURCE_TOOLS.has(exec.name)) return decision
    // 开关每次重读：关闭只影响之后的新结果，历史的 preview 不重新投影。
    if (!options.settings().enabled) return decision
    const route = cacheWarmupRouteOf(exec.agent)
    if (route.provider !== CACHE_WARMUP_PROVIDER) return decision
    const sessionId = route.sessionId
    // 会话拿不到就不投影：refId 的归属、预算与命中率都按会话记账，猜一个桶名
    // 会让两个会话互相看不见彼此的引用。
    if (sessionId === undefined) return decision
    const store = storeOf()
    if (store === undefined) return decision
    // 宿主的内容块与核心的结果内容就是同一批对象：核心只替换其中的文本块，非文本
    // 块逐字保留。这里只做一次形状桥接——核心的入参允许"纯文本"，宿主的决策只认
    // 块数组，两个形状之间不做任何内容改写。
    const blocks = decision.content ?? result.content
    if (blocks.length === 0) return decision
    const content = blocks as unknown as ProjectionResult['content']

    let durable: CacheWarmupDurableHint | undefined
    try {
      durable = options.durableHint?.(sessionId)
    } catch {
      durable = undefined
    }
    const budget: PreviewBudget = durable === undefined
      ? cacheWarmupBudget(sessionId)
      : cacheWarmupBudget(sessionId, Date.now(), durable)
    // 投影是锦上添花：它抛一次错，不能让一条本来成功的工具结果变成失败，所以
    // 用 `catch` 收成 undefined 而不是让异常冒到宿主的事件瀑布上。
    const projected = await projectToolResult({
      toolName: exec.name,
      provider: route.provider,
      sessionId,
      content,
      isError: result.isError === true,
      budget,
      store,
    }).catch((error: unknown): ProjectionResult | undefined => {
      // 同上：这条消息只说明"这次跳过了"，不说明"为什么"——原因交给 name/code。
      loggerOf()?.warn?.('[dsh-chatgpt-subscription] cache warmup projection skipped: ' + cacheWarmupErrorLabel(error))
      return undefined
    })
    if (projected === undefined) return decision

    const metrics = trackWarmup(sessionId, budget)
    log({
      event: 'projection',
      session: sessionId,
      strategy: String(projected.metrics.strategy),
      changed: projected.changed === true,
      inputChars: projected.metrics.inputChars,
      outputChars: projected.metrics.outputChars,
      omittedChars: projected.metrics.omittedChars,
      ...(metrics.warmup === undefined ? {} : { warmup: metrics.warmup }),
    })

    if (projected.changed !== true) return decision
    // 只替换 content。additionalContexts 必须原样带过去：那是别的监听器挂上来
    // 的上下文（催促、插件注入），丢掉它们等于让本模块吃掉别人的功能。
    return {
      kind: 'accept',
      content: blocksOf(projected.content),
      ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
    }
  }

  // 新结果投影。监听器**先** await next()：只对已经落定的决策动手，绝不抢先
  // 替换别的监听器还没说话的结果。
  const disposeListener = ctx.on?.('tools/post-execute', (async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    return projectDecision(exec, result, decision)
  }) as never)

  // 卸载时清掉会话状态并交出挂载权：同一进程里的下一份挂载不该读到上一份的
  // 预热状态——也不该被一个已经卸掉的实例挡在门外。
  return () => {
    disposeListener?.()
    warmupState.clear()
    release()
  }
}

/**
 * 把投影结果的内容转回宿主的内容块数组。
 *
 * 核心的 `ProjectionResult.content` 允许纯文本（预览就是一段文本），也允许块数组
 * （只替换了其中一个文本块，非文本块原样保留）。宿主的 `PostToolDecision.content`
 * 只认块数组，所以纯文本在这里包成一个 text 块——包一层，不改字。
 * @param content - 核心交回来的内容。
 * @returns 宿主的块数组。
 */
function blocksOf(content: ProjectionResult['content']): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  // 进去时就是宿主的内容块，出来时同一批对象原样交回（见 projectDecision 的桥接）。
  return content as unknown as ContentBlock[]
}

/**
 * 本文件刻意**不保留**任何"把异常压成一句话"的辅助函数。
 *
 * 这里曾经有一个 `describe(error)`，把 `error.message` 截断后拼进宿主日志。它看上去
 * 无害（只取第一行、还截了长度），实际上是一条原文出口：异常消息里常常带着绝对
 * 路径、命令行片段、凭据，或者被读取结果的一段正文。三处降级日志现在统一走
 * {@link cacheWarmupErrorLabel}——只输出稳定的 name/code。
 */
