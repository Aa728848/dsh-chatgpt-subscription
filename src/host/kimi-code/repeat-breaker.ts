/**
 * Kimi Code 会话的「重复刹车」（Repeat Breaker）。
 *
 * 移植官方 MoonshotAI/kimi-code 的 AgentToolDedupeService
 * (packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts) 里的
 * **四段式重复刹车**：同一个工具、同一份参数连着被叫了太多次时，模型会陷进
 * 「同一个失败重试 N 遍」的循环里；官方用四段递进的提醒把它拽出来，最后一段
 * 直接**接管**这一轮 —— 后面的工具调用全部被拒，只准它交一份文字结论。
 *
 * ## 四段
 *
 * | 连击次数 | 官方动作 | 本模块的行为 |
 * | --- | --- | --- |
 * | 1-2 | 静默 | 不提醒 |
 * | 3-4 | REMINDER_TEXT_1 | 追加一条上下文：先写一句「我期待这次调用给出什么新东西」 |
 * | 5-7 | makeReminderText2(n) | 追加一条上下文：三选一（证伪 / 缺输入 / 收尾） |
 * | 8-11 | REMINDER_TEXT_3 | 追加一条上下文：现在就用文字收尾 |
 * | 12 | HANDOFF_VETO_TEXT | 守卫**拦下**这一次调用，并锁死后续所有调用 |
 *
 * ## 线路判定是结构探测
 *
 * 读 provider 的方式照抄本包既有的做法（见
 * src/host/minimax-code/runtime-enhancements.ts 的 minimaxSessionRouteOf 与
 * src/host/cache-warmup/install.ts 的 cacheWarmupRouteOf）：会话请求头 →
 * agent 的模型选择面 → agent 选项 → agent 自身。不 import 任何宿主代次专属的
 * 类型，所以同一份代码在 0.1.2-alpha.5 到 0.2.2-alpha.3 上都装得上。
 *
 * ## 接线面
 *
 * - ctx.tools.guard()：第 12 次连击时**拦下**调用，并锁死这一轮剩下的调用。
 * - tools/post-execute：三段提醒都走 additionalContexts。
 * - agent/pre-step / agent/disposed：新的一轮用户输入重置连击计数。
 *
 * 四条接缝都不碰工具声明面（tools:sdk 段与顶层工具 schema），Kimi Code 的
 * 前缀缓存不会因为这个模块重建一次。
 *
 * @module dsh-chatgpt-subscription/host/kimi-code/repeat-breaker
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 重复刹车的提醒上下文。 */
    'kimi-repeat-breaker': { kind: 'kimi-repeat-breaker' } & { form?: 'notice', summary?: string }
  }
}

/** 本模块只对 Kimi Code 这条线路生效。 */
export const KIMI_CODE_PROVIDER = 'kimi-code'

/** 官方重复刹车的开关环境变量。 */
export const REPEAT_BREAKER_ENV = 'KIMI_CODE_REPEAT_BREAKER'

/** 第一段提醒的起始连击次数（3-4）。 */
export const REPEAT_REMINDER_1_START = 3

/** 第二段提醒的起始连击次数（5-7）。 */
export const REPEAT_REMINDER_2_START = 5

/** 第三段提醒的起始连击次数（8-11）。 */
export const REPEAT_REMINDER_3_START = 8

/** 强停的连击次数：第 12 次开始由守卫接管这一轮。 */
export const REPEAT_FORCE_STOP_STREAK = 12

/** 第一段提醒文案。 */
export const REMINDER_TEXT_1 = '<system-reminder>\n'
  + 'The same tool call has been repeated several times in a row. '
  + 'Before making your next call, write one sentence stating what new information you expect it to produce. '
  + 'Then act on that sentence: if it names something this result does not already give you, '
  + 'choose the action that best provides it; otherwise, continue with the evidence you already have.\n'
  + '</system-reminder>'

/**
 * 造第二段提醒文案（连击 5-7 次时用）。
 *
 * @param repeatCount - 当前连击次数，原样写进文案。
 * @returns 提醒正文。
 */
export function makeReminderText2(repeatCount: number): string {
  return '<system-reminder>\n'
    + 'The same tool call has now been issued ' + String(repeatCount) + ' times in a row. '
    + 'Choose exactly one of the following and state your choice before acting:\n'
    + '(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, '
    + 'if such a test exists.\n'
    + '(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n'
    + '(3) Conclude: deliver your best result based on the evidence already gathered, '
    + 'listing anything that remains uncertain.\n'
    + '</system-reminder>'
}

/** 第三段提醒文案（连击 8 次起，以及强停那一轮）。 */
export const REMINDER_TEXT_3 = '<system-reminder>\n'
  + 'Write your final response now, without any further tool calls. '
  + 'Cover: the current blocker, each approach you have tried and what it established, '
  + 'and the specific information or decision you need from the user to unblock progress. '
  + 'Text only.\n'
  + '</system-reminder>'

/** 强停那一轮之后，守卫用来拒绝后续工具调用的文案。 */
export const HANDOFF_VETO_TEXT = 'This turn was ended by the repeat breaker after the same tool call was issued '
  + String(REPEAT_FORCE_STOP_STREAK) + ' times in a row. '
  + 'This step accepts a text response only, so the tool call was not executed. '
  + 'Reply in text: the current blocker, what you tried, and what you need next.'

/**
 * 不计入连击的协调类工具。
 *
 * 这些工具**本来就会**被反复调用：报一次进展、更新一次待办、问一次用户。把它们
 * 算进连击等于让刹车对着正常的心跳乱响。
 */
export const REPEAT_BREAKER_EXEMPT_TOOLS: readonly string[] = Object.freeze([
  'progress_update',
  'todo_write',
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
  'leave_plan_mode',
  'create_goal',
  'update_goal',
  'get_goal',
  'dispatch_ledger',
  'present',
])

/**
 * 判断一个工具是不是不计入连击的协调类工具。
 *
 * @param toolName - 工具名。
 * @returns 豁免时为 true。
 */
export function isRepeatBreakerExemptTool(toolName: string): boolean {
  return REPEAT_BREAKER_EXEMPT_TOOLS.includes(toolName)
}

/** 读得到的环境变量视图。 */
export type KimiRepeatBreakerEnv = { readonly [key: string]: string | undefined }

/** 明确表示「关掉」的环境变量取值。 */
const DISABLED_ENV_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off'])

/**
 * 读重复刹车当前是否启用。
 *
 * **默认开启**：刹车是保护，不是功能开关。只有环境变量明确写成
 * 0 / false / no / off（大小写不敏感）才关掉它。
 *
 * @param env - 环境变量视图；默认读 process.env。
 * @returns 启用时为 true。
 */
export function isKimiRepeatBreakerEnabled(env: KimiRepeatBreakerEnv = process.env): boolean {
  const raw = env[REPEAT_BREAKER_ENV]
  if (typeof raw !== 'string') return true
  return !DISABLED_ENV_VALUES.has(raw.trim().toLowerCase())
}

/**
 * 判断一个值是不是普通对象（原型是 Object.prototype 或 null）。
 *
 * @param value - 任意值。
 * @returns 是普通对象时为 true。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 判断一个值是不是对象（数组也算）。
 *
 * @param value - 任意值。
 * @returns 是对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 读一个未知字段为非空字符串。
 *
 * @param value - 候选值。
 * @returns 字符串，或任何其它类型的 undefined。
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 一次工具调用所属的线路。 */
export interface KimiSessionRoute {
  /** 当前会话被路由到的 provider id。 */
  readonly provider?: string
  /** 当前会话标识。 */
  readonly sessionId?: string
}

/** 事件里 agent 上本模块会读的部分（结构化类型，不绑定具体 SDK 版本）。 */
interface AgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly header?: { readonly id?: unknown }
    /** 会话当前被路由到的模型线路。老宿主上可能没有这个方法。 */
    requestHeader?(): { readonly config?: { readonly provider?: unknown } } | undefined
  }
  /** 宿主的模型选择面：先给已记录的选择，没有记录时才退回 agent 选项。 */
  readonly model?: { current?(): { readonly provider?: unknown } | undefined }
  readonly options?: { readonly provider?: unknown }
  readonly provider?: unknown
}

/**
 * 读一次工具调用所属的线路。
 *
 * provider 的四个来源按可靠性排序：**请求头快照**（唯一反映「已经真的路由到
 * 哪个 provider」的那一份）→ **模型选择面**（首步还没有请求头时唯一还能说出
 * 这一场走哪条线路的地方）→ **agent 选项**（还没发出请求时唯一的意图）→
 * **agent 自身的 provider 字段**（最后的兜底）。
 *
 * 每一处读取都独立 try/catch：任何一处抛错都只是「这一处读不到」，不改变
 * 其余来源的行为，也不让整次读取失败。
 *
 * @param agent - 事件里的调用方 agent。
 * @returns 线路信息；读不到的字段省略。
 */
export function kimiSessionRouteOf(agent: unknown): KimiSessionRoute {
  const record = isRecord(agent) ? (agent as unknown as AgentLike) : undefined
  const session = record?.session

  let provider: string | undefined
  try {
    provider = stringOf(session?.requestHeader?.()?.config?.provider)
  } catch {
    // 会话正在拆除、或这一代宿主没有 requestHeader：退回下一个来源。
    provider = undefined
  }
  if (provider === undefined) {
    try {
      provider = stringOf(record?.model?.current?.()?.provider)
    } catch {
      provider = undefined
    }
  }
  if (provider === undefined) provider = stringOf(record?.options?.provider)
  if (provider === undefined) provider = stringOf(record?.provider)

  // 会话 id 只认会话头，退一步才用 agent 自己的 id：前者是日志与引用归属的真名。
  const sessionId = stringOf(session?.header?.id) ?? stringOf(record?.id)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * 判断一次工具调用是不是 Kimi Code 这条线路上的。
 *
 * @param agent - 事件里的调用方 agent。
 * @returns 是 Kimi Code 时为 true。
 */
export function isKimiSession(agent: unknown): boolean {
  return kimiSessionRouteOf(agent).provider === KIMI_CODE_PROVIDER
}

/**
 * 递归把一个值重排成「键名有序」的形状。
 *
 * 数组**保持原序**：数组元素的顺序本身就是语义（[1, 2] 与 [2, 1] 不是同一件事），
 * 只有对象的键名顺序没有语义。
 *
 * @param value - 当前值。
 * @returns 重排后的值。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key])
  }
  return out
}

/**
 * 造一次工具调用的**规范键**。
 *
 * 键 = 工具名 + 参数的规范 JSON。参数先递归重排键名再序列化，于是
 * { a: 1, b: 2 } 与 { b: 2, a: 1 } 得到**完全相同**的键 —— 否则模型只是把参数
 * 的书写顺序换了一下，刹车就看不见这是一个连击。
 *
 * @param toolName - 工具名。
 * @param args - 工具参数。
 * @returns 规范键。
 */
export function canonicalKimiToolCallKey(toolName: string, args: unknown): string {
  let json: string | undefined
  try {
    json = JSON.stringify(sortJsonValue(args))
  } catch {
    // 循环引用之类的病态参数：退回字符串形态，至少还是确定的。
    json = undefined
  }
  return toolName + ' ' + (json ?? String(args))
}

/** 一个会话在重复刹车里的状态。 */
export interface KimiRepeatBreakerState {
  /** 当前连击对应的规范键。 */
  consecutiveKey: string | null
  /** 当前连击的次数。 */
  consecutiveCount: number
  /** 这一轮是否已经被强停接管。 */
  handoffActive: boolean
}

/** 重复刹车的状态机。 */
export interface KimiRepeatBreaker {
  /**
   * 执行前判定：这一次调用要不要被拦下。
   *
   * @param sessionId - 会话标识。
   * @param toolName - 工具名。
   * @param args - 工具参数。
   * @returns 拒绝理由（只有强停那一种）；不拦时是 undefined。
   */
  checkBeforeExecute(sessionId: string, toolName: string, args: unknown): string | undefined
  /**
   * 执行后记账：算出这一连击要不要给模型追加提醒。
   *
   * @param sessionId - 会话标识。
   * @param toolName - 工具名。
   * @param args - 工具参数。
   * @returns 提醒正文；不提醒时是 undefined。
   */
  recordAfterExecute(sessionId: string, toolName: string, args: unknown): string | undefined
  /**
   * 重置一个会话的连击计数（新一轮用户输入时调用）。
   *
   * @param sessionId - 会话标识。
   */
  resetSession(sessionId: string): void
}

/**
 * 造一台重复刹车。
 *
 * 状态**按会话**分开：连击是「这场对话里的同一件事重复了多少次」，两个会话
 * 互不相干。
 *
 * @returns 一台重复刹车。
 */
export function createKimiRepeatBreaker(): KimiRepeatBreaker {
  const sessions = new Map<string, KimiRepeatBreakerState>()

  /** 取一个会话的状态；没有就新建一个。 */
  const stateOf = (sessionId: string): KimiRepeatBreakerState => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: KimiRepeatBreakerState = {
      consecutiveKey: null,
      consecutiveCount: 0,
      handoffActive: false,
    }
    sessions.set(sessionId, created)
    return created
  }

  return {
    checkBeforeExecute(sessionId: string, toolName: string, args: unknown): string | undefined {
      const state = stateOf(sessionId)
      // 强停已经接管这一轮：这一次调用根本不该执行。
      if (state.handoffActive) return HANDOFF_VETO_TEXT
      const key = canonicalKimiToolCallKey(toolName, args)
      // 这一场已经是同一次调用了，而且再叫一次就到强停线：拦下并接管这一轮。
      if (state.consecutiveKey === key && state.consecutiveCount + 1 >= REPEAT_FORCE_STOP_STREAK) {
        state.consecutiveCount += 1
        state.handoffActive = true
        return HANDOFF_VETO_TEXT
      }
      return undefined
    },

    recordAfterExecute(sessionId: string, toolName: string, args: unknown): string | undefined {
      // 协调类工具不计入连击。
      if (isRepeatBreakerExemptTool(toolName)) return undefined
      const state = stateOf(sessionId)
      // 强停已经接管：这一轮只准交文字结论。
      if (state.handoffActive) return REMINDER_TEXT_3

      const key = canonicalKimiToolCallKey(toolName, args)
      if (state.consecutiveKey === key) state.consecutiveCount += 1
      else {
        state.consecutiveKey = key
        state.consecutiveCount = 1
      }

      if (state.consecutiveCount >= REPEAT_FORCE_STOP_STREAK) {
        state.handoffActive = true
        return REMINDER_TEXT_3
      }
      if (state.consecutiveCount >= REPEAT_REMINDER_3_START) return REMINDER_TEXT_3
      if (state.consecutiveCount >= REPEAT_REMINDER_2_START) return makeReminderText2(state.consecutiveCount)
      if (state.consecutiveCount >= REPEAT_REMINDER_1_START) return REMINDER_TEXT_1
      return undefined
    },

    resetSession(sessionId: string): void {
      sessions.delete(sessionId)
    },
  }
}

/** 工具注册面（本模块用到的 guard 这一条接缝）。 */
interface ToolsLike {
  /** 注册一条单调守卫；返回注销器。 */
  guard?: (guard: (execution: unknown) => string | undefined) => (() => void) | undefined
}

/** 本模块读得到的宿主上下文（结构化类型，不绑定具体 SDK 版本）。 */
export interface KimiRepeatBreakerContext {
  /** Cordis 的副作用登记。 */
  effect?<T>(execute: () => T, label?: string): unknown
  /** Cordis 的事件总线。 */
  on?(event: string, listener: (...args: never[]) => unknown): () => void
  /** 服务查找：**调用时**读可选服务。 */
  get?(name: string): unknown
  /** 工具注册面（没走 get 时的兜底读法）。 */
  readonly tools?: unknown
}

/** 安装选项。 */
export interface KimiRepeatBreakerOptions {
  /**
   * 当前是否启用。**每次执行都重读**，所以环境变量改完下一步就生效，不必重挂
   * 这一行，也不必重挂插件行。
   */
  readonly enabled?: () => boolean
}

/**
 * 读宿主上下文上的工具注册面。
 *
 * @param ctx - 宿主上下文。
 * @returns 工具注册面；没有时为 undefined。
 */
function toolsServiceOf(ctx: KimiRepeatBreakerContext): ToolsLike | undefined {
  const read = ctx.get
  if (typeof read === 'function') {
    try {
      const found = read.call(ctx, 'tools')
      if (found !== undefined) return found as ToolsLike
    } catch {
      // 服务缺席或正在拆除：走下面的兜底读法。
    }
  }
  const direct = ctx.tools
  return direct === undefined ? undefined : (direct as ToolsLike)
}

/**
 * 已挂载的模块登记表，走一个 global symbol：同一个包的两份模块实例（npm 拷贝与
 * 仓库 link）仍然共享一次判定，而重复装两台刹车会让同一次调用被记两遍。
 */
const MOUNTED = Symbol.for('dsh-chatgpt-subscription.mounted-modules')

/** 本模块在登记表里的名字。 */
const MODULE_ID = 'kimi-repeat-breaker'

/**
 * 单实例守卫：本模块已挂载时放弃本次安装。
 *
 * @param ctx - 宿主上下文。
 * @returns 释放函数（交出挂载权）；已经挂载过时返回 undefined。
 */
function claimMount(ctx: KimiRepeatBreakerContext): (() => void) | undefined {
  const registry = globalThis as { [MOUNTED]?: unknown }
  const existing = registry[MOUNTED]
  const mounted = existing instanceof Set ? existing as Set<string> : new Set<string>()
  if (existing !== mounted) registry[MOUNTED] = mounted
  if (mounted.has(MODULE_ID)) return undefined
  mounted.add(MODULE_ID)
  const release = (): void => { mounted.delete(MODULE_ID) }
  // 两条释放路径：调用方自己卸（返回值），以及整个上下文被拆掉时兜底。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => release, 'dsh-chatgpt-subscription: kimi repeat breaker mount')
  }
  return release
}

/**
 * 把一条 post-execute 决策接上附加上下文，保住它原有的形状。
 *
 * @param decision - next() 交回来的决策。
 * @param contexts - 要追加的上下文。
 * @returns 追加后的决策。
 */
function withAdditionalContexts(decision: PostToolDecision, contexts: UserMessage[]): PostToolDecision {
  const additionalContexts = [...decision.additionalContexts ?? [], ...contexts]
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
 * 造一条重复刹车的提醒上下文。
 *
 * @param text - 提醒正文。
 * @returns 可直接放进 additionalContexts 的用户角色消息。
 */
function createRepeatBreakerReminder(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'kimi-repeat-breaker',
      form: 'notice',
      summary: 'repeat breaker reminder',
    },
  })
}

/**
 * 判断一条消息是不是**真的**用户发言。
 *
 * 本模块自己追加的提醒也是 user 角色的消息（宿主要求附加上下文走 user 角色），
 * 所以判定不能只看角色：得看来源是不是 user。
 *
 * @param message - 候选消息。
 * @returns 是真人用户发言时为 true。
 */
function isRealUserTurn(message: unknown): boolean {
  if (!isRecord(message)) return false
  const role = message['role']
  if (role !== undefined && role !== 'user') return false
  const source = message['source']
  if (!isRecord(source)) return false
  return source['kind'] === 'user'
}

/**
 * 装上 Kimi Code 的重复刹车。
 *
 * 四条接缝：ctx.tools.guard()（强停时拦下调用）、tools/post-execute（三段提醒）、
 * agent/pre-step（新一轮用户输入重置连击）、agent/disposed（会话拆除时清状态）。
 * 工具声明面一个字节都不改。
 *
 * @param ctx - 宿主插件上下文。
 * @param options - 安装选项。
 * @returns 卸载函数。
 */
export function installKimiRepeatBreaker(
  ctx: KimiRepeatBreakerContext,
  options: KimiRepeatBreakerOptions = {},
): () => void {
  const releaseMount = claimMount(ctx)
  if (releaseMount === undefined) return () => undefined

  const breaker = createKimiRepeatBreaker()
  const enabled = options.enabled ?? (() => isKimiRepeatBreakerEnabled())

  /** 读一次开关。读失败按**开启**处理：保护不该因为一次读失败而失效。 */
  const isEnabled = (): boolean => {
    try {
      return enabled() !== false
    } catch {
      return true
    }
  }

  /**
   * 取一次执行所属的会话；不是 Kimi Code 这条线路时是 undefined。
   *
   * @param agent - 调用方 agent。
   * @returns 会话标识；不该管时是 undefined。
   */
  const kimiSessionIdOf = (agent: unknown): string | undefined => {
    const route = kimiSessionRouteOf(agent)
    if (route.provider !== KIMI_CODE_PROVIDER) return undefined
    return route.sessionId
  }

  // 1) 强停：执行期拦下调用。
  const tools = toolsServiceOf(ctx)
  const disposeGuard = tools?.guard?.((execution: unknown) => {
    try {
      if (!isEnabled()) return undefined
      const record = isRecord(execution) ? execution : undefined
      const agent = record?.['agent']
      const sessionId = kimiSessionIdOf(agent)
      if (sessionId === undefined) return undefined
      const toolName = stringOf(record?.['name'])
      if (toolName === undefined) return undefined
      const veto = breaker.checkBeforeExecute(sessionId, toolName, record?.['arguments'])
      if (veto === HANDOFF_VETO_TEXT) return HANDOFF_VETO_TEXT
      return veto
    } catch {
      // 判定失败不该让这一次工具调用失败。
      return undefined
    }
  })

  // 2) 三段提醒：post-execute 面。
  const disposePostExecute = ctx.on?.('tools/post-execute', (async (
    exec: ToolExecution,
    result: unknown,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    try {
      if (!isEnabled()) return decision
      const agent = (exec as { agent?: unknown }).agent
      const sessionId = kimiSessionIdOf(agent)
      if (sessionId === undefined) return decision
      const toolName = stringOf((exec as { name?: unknown }).name)
      if (toolName === undefined) return decision
      const reminder = breaker.recordAfterExecute(sessionId, toolName, (exec as { arguments?: unknown }).arguments)
      if (reminder === undefined) return decision
      return withAdditionalContexts(decision, [createRepeatBreakerReminder(reminder)])
    } catch {
      // 旁路：任何一步失败都不该影响这一步本身。
      return decision
    }
  }) as never)

  // 3) 新的一轮用户输入：连击归零。
  const disposePreStep = ctx.on?.('agent/pre-step', (async (
    payload: { agent?: unknown; messages?: unknown[] },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    try {
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      const tail = messages.at(-1)
      if (!isRealUserTurn(tail)) return decision
      const sessionId = kimiSessionIdOf(payload?.agent)
      if (sessionId === undefined) return decision
      breaker.resetSession(sessionId)
    } catch {
      return decision
    }
    return decision
  }) as never)

  // 4) agent 拆除：这一场的连击计数一起走。
  const disposeDisposed = ctx.on?.('agent/disposed', ((payload: { agent?: unknown }) => {
    try {
      const sessionId = kimiSessionIdOf(payload?.agent)
      if (sessionId === undefined) return
      breaker.resetSession(sessionId)
    } catch {
      // 拆除期的读取失败不值得再抛一次。
    }
  }) as never)

  return () => {
    disposeGuard?.()
    disposePostExecute?.()
    disposePreStep?.()
    disposeDisposed?.()
    releaseMount()
  }
}
