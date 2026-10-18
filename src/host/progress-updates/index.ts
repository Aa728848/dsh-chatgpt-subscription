/**
 * 「进展更新」宿主半边在本插件里的挂载点。
 *
 * 复刻 Kimi Code 的「进展更新」特性：agent 在多步任务中通过一个**不结束回合**的
 * 工具主动向用户汇报进展。本文件挂四样东西：
 *
 * 1. `progress_update` 工具（tools 服务）；
 * 2. 系统提示词引导（systemPrompt 服务，文本用函数形式，开关关闭时返回空串，
 *    因此设置改动立刻生效、无需重启会话）；
 * 3. `tools/post-execute` 上的 8 轮催促：连续带工具调用却没有进展更新时，给模型
 *    追加一条提醒（additionalContexts）；
 * 4. `GET /api/dsh-progress-updates/updates` 只读路由 —— 浏览器半边唯一的取数通道。
 *
 * **可选服务一律走 `ctx.get()`**：Cordis 里没写进 `inject` 的服务名不能直接当
 * 属性读，否则 apply 当场抛 `cannot get property "..." without inject`，整个插件
 * 降级。`sessions`、`sessionProjections`、`systemPrompt`、`webServer` 在本插件
 * 的 inject 里都没有（前者随 harness 是否装 agent-loop 而定，后者的能力由本模块
 * 自己探测），所以它们必须是**调用时**的可选读取，缺了就退化成更弱的实现，而不是
 * 让插件挂不上。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  counterSessionIdOf,
  createNudgeContext,
  stepKeyOf,
  type NudgeAgent,
  type NudgeSessionLookup,
  type TurnBoundaryLookup,
} from './nudge.ts'
import { PROGRESS_SECTION_NAME, PROGRESS_SECTION_ORDER, progressSectionText } from './prompt.ts'
import { makeProgressUpdatesRoute, type ProgressUpdatesReader } from './routes.ts'
import {
  NUDGE_THRESHOLD,
  createProgressUpdateStore,
  shouldNudge,
  type ProgressUpdate,
  type ProgressUpdateStore,
} from './store.ts'
import { NOTIFY_USER_TOOL, createProgressUpdateTool } from './tool.ts'

/** 一次挂载读到的有效设置（由主入口每次重新解析活引用后交进来）。 */
export interface ProgressUpdatesSettings {
  /** 总开关。 */
  enabled: boolean
  /** 催促阈值：连续多少轮带工具调用却没有进展更新就提醒一次。 */
  nudgeThreshold: number
}

/**
 * 设置字段在运行时可能是活引用（volatile）或普通值（手工构造的上下文、测试）。
 *
 * loader 把声明为 `volatile()` 的字段解析成一个 `{ get() }` 活引用，设置保存时
 * 就地写新值并广播 `loader/volatile-update`，**不**重挂插件行；所以这里必须能
 * 跟着引用读到当前值，而不是拿到一份快照。
 */
interface ConfigRef<T> {
  /** 读取当前已提交的值。 */
  get(): T | undefined
}

/** 一个配置字段：活引用或普通值。 */
export type ProgressUpdatesConfigField<T> = ConfigRef<T> | T | undefined

/** 主入口交给本模块的配置形状（只取本模块认识的两个字段）。 */
export interface ProgressUpdatesConfigFields {
  /** 总开关字段。 */
  progressUpdates?: ProgressUpdatesConfigField<boolean>
  /** 催促阈值得字段。 */
  progressUpdatesNudgeThreshold?: ProgressUpdatesConfigField<number>
}

/**
 * 读取一个配置字段，沿着 volatile 活引用取当前值。
 * @param field - 字段本身。
 * @returns 当前值，或字段缺失时的 undefined。
 */
export function readProgressConfigField<T>(field: ProgressUpdatesConfigField<T>): T | undefined {
  if (field === undefined || field === null) return undefined
  if (typeof field === 'object' && typeof (field as ConfigRef<T>).get === 'function') {
    return (field as ConfigRef<T>).get()
  }
  return field as T
}

/**
 * 解析一次读取的有效设置：每次调用都重读活引用，因此设置保存后立刻生效。
 * @param config - 主入口收到的插件配置（活引用或普通值）。
 * @returns 生效的开关与催促阈值。
 */
export function resolveProgressUpdatesSettings(config?: ProgressUpdatesConfigFields): ProgressUpdatesSettings {
  const enabled = readProgressConfigField(config?.progressUpdates)
  const threshold = readProgressConfigField(config?.progressUpdatesNudgeThreshold)
  return {
    enabled: enabled === true,
    // 缺省就是 store 里那个冻结的 NUDGE_THRESHOLD（8），两处永远不会漂移。
    nudgeThreshold: typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0
      ? threshold
      : NUDGE_THRESHOLD,
  }
}

/** 挂载选项。 */
export interface ProgressUpdatesOptions {
  /**
   * 读取当前设置。
   *
   * 必须是**函数**：loader 会把 volatile 字段替换成活引用，设置保存时就地写新值
   * 而不重挂插件行，所以每次用到设置都要重读一次；apply 时求值一次就存下来的
   * 写法会让开关在会话中途失效。
   */
  settings: () => ProgressUpdatesSettings
}

/** 本模块读得到的宿主上下文（Cordis Context 结构上满足；测试可用假对象）。 */
export interface ProgressUpdatesContext {
  /** Cordis 的副作用登记：回调返回的 disposer 会随插件卸载执行。 */
  effect?<T>(execute: () => T, label?: string): unknown
  /** Cordis 的事件总线。 */
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  /** 服务查找：**调用时**读可选服务，不触发 inject 断言。 */
  get?(name: string): unknown
}

/** 工具注册面。 */
interface ToolsService {
  register(tool: ToolDefinition): () => void
}

/** 提示词分节注册面。 */
interface SystemPromptService {
  section(section: { name: string, order: number, text: () => string }): () => void
}

/** 只读路由注册面。 */
interface WebServerService {
  register(route: WebRoute): () => void
}

/** 日志面（可选）。 */
interface LoggerService {
  warn(message: string): void
}

/**
 * 已挂载的模块登记表，走一个 global symbol：同一个包的两份模块实例（npm 拷贝与
 * 仓库 link）仍然共享一次判定，而重复注册同名工具或同名提示词分节会让宿主启动
 * 失败。
 */
const MOUNTED = Symbol.for('dsh-chatgpt-subscription.mounted-modules')

/** 本模块在登记表里的名字。 */
const MODULE_ID = 'progress-updates'

/**
 * 把一条催促挂到一个 post-execute 决策上，同时保住该决策原有的附加上下文。
 * @param decision - `next()` 交回来的决策。
 * @param context - 要追加的催促上下文。
 * @returns 追加后的决策（形状不变）。
 */
function withNudge(decision: PostToolDecision, context: UserMessage): PostToolDecision {
  const additionalContexts = [...decision.additionalContexts ?? [], context]
  if (decision.kind === 'block') {
    return { kind: 'block', feedback: decision.feedback, additionalContexts }
  }
  if (decision.value !== undefined) {
    return { kind: 'accept', value: decision.value, additionalContexts }
  }
  if (decision.content !== undefined) {
    return { kind: 'accept', content: decision.content, additionalContexts }
  }
  return { kind: 'accept', additionalContexts }
}

/**
 * 单实例守卫：本模块已挂载时放弃本次安装。
 * @param ctx - 宿主上下文。
 * @returns 释放函数（交出挂载权）；已经挂载过时返回 undefined。
 */
function claimMount(ctx: ProgressUpdatesContext): (() => void) | undefined {
  const registry = globalThis as { [MOUNTED]?: unknown }
  const existing = registry[MOUNTED]
  const mounted = existing instanceof Set ? existing as Set<string> : new Set<string>()
  if (existing !== mounted) registry[MOUNTED] = mounted
  if (mounted.has(MODULE_ID)) return undefined
  mounted.add(MODULE_ID)
  const release = (): void => { mounted.delete(MODULE_ID) }
  // 两条释放路径：调用方自己卸（返回值），以及整个上下文被拆掉时兜底。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => release, 'dsh-chatgpt-subscription: progress updates mount')
  }
  return release
}

/**
 * 挂载「进展更新」的宿主半边。
 * @param ctx - 宿主插件上下文。
 * @param options - 挂载选项（设置读取器）。
 * @returns 卸载函数；重复挂载时返回一个空操作。
 */
export function installProgressUpdates(ctx: ProgressUpdatesContext, options: ProgressUpdatesOptions): () => void {
  const release = claimMount(ctx)
  if (release === undefined) return () => undefined

  /** 每次调用重新读服务：宿主树可能在本模块挂载之后才 settle，读一次存下来会漏。 */
  const serviceOf = <T>(name: string): T | undefined => {
    const read = ctx.get
    return typeof read === 'function' ? read.call(ctx, name) as T | undefined : undefined
  }

  /** 登记一个副作用；上下文没有 effect 时立即执行（测试用假上下文）。 */
  const track = (execute: () => unknown, label: string): void => {
    if (typeof ctx.effect === 'function') ctx.effect(execute, label)
    else execute()
  }

  /** 会话查找表：够把子会话回溯到顶层祖先即可。 */
  const sessionsOf = (): NudgeSessionLookup | undefined => serviceOf<NudgeSessionLookup>('sessions')

  /** 会话投影服务：只用来读 turnBoundary，把同一个模型步里的多条工具结果合并成一轮。 */
  const projectionsOf = (): TurnBoundaryLookup | undefined => serviceOf<TurnBoundaryLookup>('sessionProjections')

  /** 会话维度状态；键是计数会话 id（子会话已归并到顶层祖先）。 */
  const stores = new Map<string, ProgressUpdateStore>()

  /** 已经计过数的「步」：同一个模型步里的后续工具结果不再重复计数。 */
  const countedSteps = new Map<string, string>()

  /**
   * 取一个计数会话的 store，按需创建。
   * @param key - 计数会话 id。
   * @returns 该会话的 store。
   */
  const storeOf = (key: string): ProgressUpdateStore => {
    let store = stores.get(key)
    if (store === undefined) {
      store = createProgressUpdateStore()
      stores.set(key, store)
    }
    return store
  }

  /**
   * 一次工具调用归属的计数会话 id。
   * @param exec - 工具执行上下文（或任意带 agent 的对象）。
   * @returns 计数会话 id；判定不出来时归入 `session` 这一桶。
   */
  const counterKeyOf = (exec: unknown): string =>
    counterSessionIdOf((exec as { agent?: NudgeAgent } | undefined)?.agent, sessionsOf()) ?? 'session'

  /**
   * 浏览器半边的读取面：给定会话 id 就交出那个会话的进展快照。
   *
   * 请求不带 session（或带一个本进程没见过的 id）时，回退到那个"合成会话桶"：
   * 这是单会话部署里的常态，也是插件第一次被调用、祖先血缘还没建立时的落点。
   */
  const reader: ProgressUpdatesReader = {
    updatesOf: (sessionId: string) => {
      const direct = stores.get(sessionId)
      if (direct !== undefined) return direct.state().updates
      if (sessionId !== '') {
        // 允许用未归并的子会话 id 查询：回溯到它的计数会话。
        const merged = counterSessionIdOf({ id: sessionId }, sessionsOf())
        const parent = merged === undefined ? undefined : stores.get(merged)
        if (parent !== undefined) return parent.state().updates
        return []
      }
      const fallback = stores.get('session')
      return fallback === undefined ? [] : fallback.state().updates
    },
  }

  // 工具：始终注册。开关关闭时 execute 返回 displayed:false，而不是抛错。
  track(() => {
    const tools = serviceOf<ToolsService>('tools')
    if (tools === undefined) {
      serviceOf<LoggerService>('logger')?.warn('[dsh-chatgpt-subscription] progress updates tool skipped: no tools service')
      return () => undefined
    }
    const tool = createProgressUpdateTool({
      isEnabled: () => options.settings().enabled,
      sink: () => ({
        push: (update: ProgressUpdate) => {
          if (!options.settings().enabled) return false
          // 进展落进会话 store 就够浏览器读到了：路由直接从同一个 store 取数。
          // store.push 只负责写入列表，轮次归零由 execute 之后的 post-execute
          // （exec.name === NOTIFY_USER_TOOL 那条分支）统一处理，这里不重复做。
          storeOf(update.source ?? 'session').push(update)
          return true
        },
      }),
      sourceOf: exec => counterKeyOf(exec),
    })
    return tools.register(tool)
  }, 'dsh-chatgpt-subscription: progress update tool')

  // 提示词引导：文本用函数形式，开关关闭时返回空串。systemPrompt 是可选服务：
  // 没装 system-prompt 的宿主上，这条引导只是不存在，插件照样工作。
  track(() => {
    const systemPrompt = serviceOf<SystemPromptService>('systemPrompt')
    if (systemPrompt === undefined) return () => undefined
    return systemPrompt.section({
      name: PROGRESS_SECTION_NAME,
      order: PROGRESS_SECTION_ORDER,
      text: progressSectionText(() => options.settings().enabled),
    })
  }, 'dsh-chatgpt-subscription: progress update prompt section')

  // 浏览器半边的取数路由。开关关闭时也照常注册：客户端要靠它拿到"当前为空"这个
  // 事实，才能把面板渲染成空态而不是报错。
  track(() => {
    const webServer = serviceOf<WebServerService>('webServer')
    if (webServer === undefined) return () => undefined
    return webServer.register(makeProgressUpdatesRoute(reader))
  }, 'dsh-chatgpt-subscription: progress update route')

  // 8 轮催促：在工具结果之后计数，达到阈值就追加一条提醒，并把计数归零。
  // 计数按会话维度（子会话归并到顶层祖先），按模型步去重（一次并行调用多个工具
  // 只算一轮），且每条工具结果最多注入一次。
  const disposeListener = ctx.on?.('tools/post-execute', (async (
    exec: ToolExecution,
    _result: unknown,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    // 不能缓存 options.settings() 的结果：它是活引用，每轮都要重读。
    const current = options.settings()
    if (!current.enabled) return decision
    const key = counterKeyOf(exec)
    const store = storeOf(key)
    if (exec.name === NOTIFY_USER_TOOL) {
      // 模型自己报了进展：计数归零，不催促。它所在的那一步也不算进轮次。
      store.markUpdated()
      const reportedStep = stepKeyOf((exec as { agent?: NudgeAgent }).agent, projectionsOf())
      if (reportedStep !== undefined) countedSteps.set(key, reportedStep)
      return decision
    }
    // 同一个模型步里的第二条及以后的工具结果不重复计数。
    const step = stepKeyOf((exec as { agent?: NudgeAgent }).agent, projectionsOf())
    if (step !== undefined) {
      if (countedSteps.get(key) === step) return decision
      countedSteps.set(key, step)
    }
    const rounds = store.bumpRound()
    // 设置里没改过阈值时走 store 的冻结谓词（NUDGE_THRESHOLD = 8），改过则按设置值。
    const reached = current.nudgeThreshold === NUDGE_THRESHOLD
      ? shouldNudge(rounds)
      : rounds >= current.nudgeThreshold
    if (!reached) return decision
    const nudges = store.markNudged().nudges
    return withNudge(decision, createNudgeContext(nudges))
  }) as never)

  // 卸载时清掉会话状态并交出挂载权，避免同一进程内的下一份挂载读到上一份的计数
  // ——也避免一个已经卸掉的实例把后面每一次重新挂载都挡在门外。
  return () => {
    disposeListener?.()
    stores.clear()
    countedSteps.clear()
    release()
  }
}
