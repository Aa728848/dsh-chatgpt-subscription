/**
 * 「计划模式」服务 —— ctx.planMode 的 **fork**（本包在 dispatch preset 里替换
 * harness 官方的 @deepseek-ai/dsh-plan-mode）。
 *
 * ## 为什么必须 fork
 *
 * 官方实现的动态 plan:policy 段在进入/离开计划模式时翻转；exit_plan_mode 也带
 * { when } 逐步准入。0.2.2 起工具在首次进入后会持续保留，减少了后续切换的工具表
 * 变化，但首次准入与 system 段变化仍会重建 native tools 与 PTC tools:sdk 的前缀缓存。
 *
 * Kimi 线路按内容前缀命中，这两次重建是**计划模式必经**的固定税。这个 fork 把税
 * 取消掉，靠的是同一个观察：**末尾追加不破坏前缀**。
 *
 * ## 三个决定（每一个都对应上面一处重建）
 *
 * 1. **不注册任何动态 system 段。** system 段在整个会话里逐字节恒定。
 * 2. **exit_plan_mode 无条件注册。** 没有 { when }，它从会话第一步就在工具表里，
 *    进出计划模式都不改工具表；「只在计划模式可用」由 execute 里的 loggedActive
 *    判定执行（报错文案与官方一致）。代价是每一步多带一个工具声明，收益是
 *    native / PTC 两侧零重建。
 * 3. **部署方的 section 走尾部用户消息**（agent/pre-step 的 decision.messages，
 *    无回合时走 agent.inject），一次进入只投一次。手册性指引留在 enter_plan_mode
 *    的工具返回里（见 entry-plan-mode-pipeline.ts）。
 *
 * ## 第四件事：回合结束时的提醒（也不进前缀缓存）
 *
 * 计划模式里模型讲完一段话就收尾（`finish: stop`、零工具调用）时，宿主不会替它做任何
 * 事：那一回合就停在那里，直到人去催「确认呢」。`installPlanModeExitReminder` 在
 * `llm/stream` 上认一次**已完成、只有可见文本、零工具调用**的对话请求，在 agent 空闲
 * 之后补一条尾部消息（`createPlanNotice`），让模型自己选 `exit_plan_mode` /
 * `ask_user_question` / `leave_plan_mode`。它同样不注册 system 段、不动工具表，所以和
 * 上面三个决定一样零缓存漂移；cap 是每条连续收尾一条。
 *
 * ## 与官方实现的其余差别一律是「代次协商」，不是功能裁剪
 *
 * - plan 投影的 stateVersion 在 0.2.1-rc.5 及更早是 3（无 entered），0.2.2-alpha
 *   起是 4（含 entered）。sessionProjections.register 对同一个 key 的版本不一致是
 *   **硬失败**，而同一个宿主里另一个 preset 可能已经注册过它，所以这里先按 4 注册，
 *   失败时读错误里的 already registered at stateVersion N 用那个版本重试一次。
 * - register() 在旧代是同步的、状态要经 ctx.sessionProjections.stateOf() 读；新代
 *   返回可 await 的 ProjectionHandle。两种形状都在下面接住。
 * - 没有 sessionProjections（老代宿主）时退回进程内 WeakMap：计划模式照常可用，
 *   只是不随会话日志持久化。
 *
 * ## 不能 import 的东西
 *
 * @deepseek-ai/dsh-plan-mode / dsh-agent / dsh-session / dsh-commands /
 * dsh-user-questions / dsh-session-projection 都不在本包 peerDependencies 里，所以
 * 顶层**不 import 它们**，只按结构探测：ctx.get('sessionProjections')、
 * ctx.get('userQuestions')、ctx.get('tools')、ctx.get('agents')、ctx.get('commands')。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/plan-mode
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { hasRunningChildSubagent, isDelegatedCaller } from './host/dispatch-execution-guard.ts'

/** 组件行名；preset 里的行 id 与模块说明符另由 preset 文件决定。 */
export const name = 'dsh-chatgpt-subscription-plan-mode'

/** 模型侧审批出口的工具名。冻结契约的一部分，不要改动。 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** 官方实现用来承载计划指引的 prompt 段名（这个 fork 刻意**不注册**它）。 */
export const PLAN_POLICY_SECTION = 'plan:policy'

/** plan 投影的 key。跨 preset 共享，不能改名。 */
export const PLAN_PROJECTION_KEY = 'plan'

/** 会话日志里记录计划模式开关的事件类型（与官方同名，投影可互换折叠）。 */
export const PLAN_MODE_EVENT = 'plan/mode'

/** 最新一代的投影状态版本（0.2.2-alpha 起：含 entered）。 */
export const PLAN_STATE_VERSION = 4

/** 旧一代（≤0.2.1-rc.5）的投影状态版本：没有 entered。 */
export const LEGACY_PLAN_STATE_VERSION = 3

/** 审批问题在答案里的 id。 */
export const REVIEW_ID = 'plan-review'

/** 审批问题「批准」选项的文案。 */
export const APPROVE_LABEL = 'Approve'

/** 审批问题「继续规划」选项的文案。 */
export const KEEP_PLANNING_LABEL = 'Keep planning'

/** 尾部通知消息的来源 kind（本包自有，见下方 MessageSourceMap 增补）。 */
export const PLAN_NOTICE_SOURCE_KIND = 'plan-mode-notice'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本 fork 在 agent/pre-step 末尾追加的计划模式提示（不是新的用户回合）。 */
    'plan-mode-notice': { kind: 'plan-mode-notice' } & { form?: 'notice', summary?: string }
  }
}

/** 部署方配置：一段计划模式指引。字段集与官方完全一致。 */
export interface PlanModeConfig {
  /** 计划模式生效时交给模型的指引正文（这个 fork 走尾部消息，不进 system 段）。 */
  section: string
}

/**
 * 校验部署方配置。缺失、空白、类型不符与未知字段都在**挂载时**失败，而不是被忽略。
 * @param config - 原始插件配置。
 * @returns 一份脱离入参的校验后配置。
 * @throws {Error} 判定与文案与官方一致，便于既有部署配置与测试直接迁移。
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig> | undefined)?.section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const unknown = Object.keys(config ?? {}).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error('PlanModeConfig has unknown key(s) ' + unknown.join(', ') + ' — config is { section }')
  }
  return { section }
}

// ── 计划投影 ────────────────────────────────────────────────────────────────

/** plan 投影的宿主状态。字段与官方 0.2.2-alpha 起一致（entered 见 stateVersion）。 */
export interface PlanUnitState {
  /** 已记录的计划模式开关。 */
  active: boolean
  /** 尚未落到日志的选择目标；没有未决选择时是 null。 */
  wanted: boolean | null
  /** 最近一次 /plan 命令等待配对结算的记录。 */
  running: { commandId: string; wanted: boolean } | null
  /** 最近一次 request/header 时的 active 值；尚未发过请求时是 null。 */
  activeAtLastHeader: boolean | null
  /** 本会话是否曾经进入过计划模式。 */
  entered: boolean
}

/** plan 投影的线上视图（客户端只读这两个字段）。 */
export interface PlanProjectionView {
  /** 正生效的计划模式。 */
  active: boolean
  /** 有一个尚未生效的选择。 */
  pending: boolean
}

/** 投影折叠时读到的事件形状（不绑定 @deepseek-ai/dsh-session 的类型）。 */
export interface PlanEventLike {
  /** 事件类型。 */
  readonly type: string
  /** 事件数据。 */
  readonly data?: unknown
}

/** 一个投影定义（结构化类型，不 import @deepseek-ai/dsh-session-projection）。 */
export interface PlanProjectionDefinition {
  /** 投影 key。 */
  key: string
  /** 持久化缓存的失效版本。 */
  stateVersion: number
  /** 状态校验 schema（必须同时接受 v3 与 v4 的已存行）。 */
  stateSchema: { parse(value: unknown): PlanUnitState }
  /** 空日志的初始状态。 */
  init(): PlanUnitState
  /** 纯折叠：一条已提交事件 -> 新状态（无关事件原样返回同一个引用）。 */
  apply(state: PlanUnitState, event: PlanEventLike): PlanUnitState
  /** 客户端视图。 */
  wire: {
    /** 视图校验 schema。 */
    viewSchema: { parse(value: unknown): PlanProjectionView }
    /** 状态 -> 视图。 */
    view(state: PlanUnitState): PlanProjectionView
  }
}

/**
 * 投影状态 schema。
 *
 * 刻意**不用 strict()、并给 entered 一个默认值**：同一个 key 可能被按 v3 注册的
 * 另一份定义（≤0.2.1-rc.5，没有 entered 字段）写进持久化缓存，严格的 schema 会让
 * 那份缓存整行作废，进而把服务从「共享」变成「冲突」。
 */
const planUnitStateSchema = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.string(),
    wanted: zod.boolean(),
  }).nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
  entered: zod.boolean().default(false),
})

/** 线上视图 schema。 */
const planProjectionViewSchema = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
})

/**
 * 造一份 plan 投影定义。
 *
 * 折叠逻辑与官方逐句等价：/plan 命令的生命周期（command/run -> command/done）、
 * plan/mode 整值记录、request/header 记下「上一次告诉模型的模式」。等价是硬要求：
 * 同一个宿主里另一份定义可能已经按别的 stateVersion 注册了同一个 key，两边折叠出的
 * 状态必须是同一个东西，共享才安全。
 * @param stateVersion - 投影状态版本，默认最新一代（4）。冲突时用冲突方的版本重试。
 * @returns 投影定义。
 */
export function createPlanProjectionDefinition(stateVersion: number = PLAN_STATE_VERSION): PlanProjectionDefinition {
  return {
    key: PLAN_PROJECTION_KEY,
    stateVersion,
    stateSchema: planUnitStateSchema,
    init: () => ({ active: false, wanted: null, running: null, activeAtLastHeader: null, entered: false }),
    apply: (state, event) => {
      const data = (event.data ?? {}) as Record<string, unknown>
      if (event.type === 'command/run' && data.name === 'plan') {
        if (data.args === undefined) return state
        const wanted = typeof data.args === 'string' ? data.args.trim() !== 'off' : false
        return { ...state, running: { commandId: String(data.commandId ?? ''), wanted } }
      }
      if (event.type === 'command/done' && state.running !== null && data.commandId === state.running.commandId) {
        const wanted = data.kind === 'success' && state.running.wanted !== state.active
          ? state.running.wanted
          : null
        return { ...state, wanted, running: null }
      }
      if (event.type === PLAN_MODE_EVENT) {
        const active = data.active === true
        return { ...state, active, wanted: null, entered: state.entered || active }
      }
      if (event.type === 'request/header') {
        return { ...state, activeAtLastHeader: state.active }
      }
      return state
    },
    wire: {
      viewSchema: planProjectionViewSchema,
      view: (state) => {
        const wanted = state.running?.wanted ?? state.wanted
        return { active: state.active, pending: wanted !== null && wanted !== state.active }
      },
    },
  }
}

/** 最新一代（stateVersion 4）的 plan 投影定义。 */
export const planProjectionDefinition: PlanProjectionDefinition = createPlanProjectionDefinition()

// ── 多代结构探测 ────────────────────────────────────────────────────────────

/** 可 await 的投影句柄（新代形状）。 */
interface PlanProjectionHandleLike {
  /** 读某个会话的当前状态。 */
  stateOf(session: unknown): unknown
}

/** 会话投影注册面（两种代次形状都在这里接住）。 */
interface SessionProjectionsLike {
  /** 注册一个投影；新代返回可 await 的句柄，旧代返回同步 disposer。 */
  register(definition: unknown): unknown
  /** 旧代的按 key 读法。 */
  stateOf?(session: unknown, key: string): unknown
}

/** 工具注册面（这个 fork 只用单参数形状）。 */
interface ToolsRegistryLike {
  /** 注册一个工具定义。 */
  register(definition: ToolDefinition): unknown
}

/** agent 登记表里本模块会读的部分。 */
interface AgentsLike {
  /** 会话的回合边界。 */
  turnBoundaryOf?(session: unknown): { openTurnStartSeq?: unknown } | undefined
}

/** 一个会话记录里本模块会读的部分。 */
interface SessionLike {
  /** 追加一条已提交事件。 */
  append?(type: string, data: unknown): unknown
}

/** 用户问答通道。 */
interface UserQuestionsLike {
  /** 问一个问题并等答案。 */
  ask(request: unknown): Promise<{ answers?: readonly UserQuestionAnswerLike[] }>
}

/** 一条答案。 */
interface UserQuestionAnswerLike {
  /** 问题 id。 */
  id: string
  /** 选中的选项文案。 */
  selected: readonly string[]
  /** 自定义输入。 */
  custom?: string
}

/** 命令注册面。 */
interface CommandsRegistryLike {
  /** 注册一条 / 命令。 */
  register(definition: unknown): unknown
}

/** agent 里本模块会读的部分。 */
interface AgentLike {
  /** 会话记录。 */
  readonly session?: unknown
  /** 把一个尾部消息塞进本会话（无回合时用）。 */
  inject?(message: unknown): void
  /** 把一条用户消息推进回合（/plan 带正文时用）。 */
  steer?(message: unknown): void
}

/** 事件订阅面（老代 cordis 上可能没有 on）。 */
interface EventHostLike {
  /**
   * 订阅一个事件，返回解绑函数。
   *
   * 第三参数是 cordis 的订阅选项（`{ global: true }` 让宿主级监听器看到每个会话的
   * 事件）。单测里的假宿主只认两个参数，所以它是可选的，而且调用方必须准备好
   * 「宿主对着第三个参数抛错」的退路。
   */
  on?(
    name: string,
    listener: (...args: never[]) => unknown,
    options?: { global?: boolean },
  ): (() => void) | undefined
}

/** 注入面（老代 cordis 上可能没有 inject）。 */
interface InjectHostLike {
  /** 等一组服务到齐后回调。 */
  inject?(deps: string[], callback: (scope: unknown) => void): unknown
}

/** effect 面。 */
interface EffectHostLike {
  /** 注册一个随本行卸载的 effect。 */
  effect?(body: () => () => void, label?: string): unknown
}

/** 日志面。 */
interface LoggerLike {
  /** 提示级日志。 */
  info(message: string): void
  /** 警告级日志。 */
  warn(message: string, ...rest: unknown[]): void
}

/** exit_plan_mode 的执行上下文里本模块会读的部分。 */
interface ExitExecutionLike {
  /** 调用方 agent。 */
  agent?: unknown
  /** 本次调用 id（审批卡片带着它，跨代可能没有）。 */
  callId?: unknown
  /** 取消信号。 */
  signal?: unknown
  /** 结束本回合（0.2.x 起；更老的代没有）。 */
  concludeTurn?(): void
}

/** 一条 pre-step 决策里本模块会读的部分。 */
interface PreStepDecisionLike {
  /** enter / reject。 */
  kind?: string
  /** 本步的输入消息。 */
  messages?: unknown[]
}

/** pre-step 事件的载荷里本模块会读的部分。 */
interface PreStepPayloadLike {
  /** 本步的 agent。 */
  agent?: AgentLike
  /** 取消信号。 */
  signal?: { aborted?: boolean }
}

/** 待投递的选择。narrate=false 表示工具结果已经讲清楚了。 */
interface PendingIntent {
  /** 目标状态。 */
  active: boolean
  /** 是否还要补一条尾部通知。 */
  narrate: boolean
}

/** 什么读不到时的空状态。 */
const EMPTY_PLAN_STATE: PlanUnitState = Object.freeze({
  active: false,
  wanted: null,
  running: null,
  activeAtLastHeader: null,
  entered: false,
})

/**
 * 调用时读一个可选服务。服务缺席或读取抛错一律 undefined —— 这一行不该因为
 * 某个服务不在而挂不上。
 * @param ctx - 宿主上下文（结构类型：老代的 ctx 也认）。
 * @param service - 服务名。
 * @returns 服务实例；不存在或读取抛错时 undefined。
 */
function serviceOf<T>(ctx: unknown, service: string): T | undefined {
  const read = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, service) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 记一条日志。日志服务缺席时安静跳过。
 * @param ctx - 宿主上下文。
 * @param level - 级别。
 * @param message - 正文。
 */
function log(ctx: unknown, level: 'info' | 'warn', message: string): void {
  const logger = (ctx as { logger?: LoggerLike } | undefined)?.logger
  try {
    if (level === 'warn') logger?.warn(message)
    else logger?.info(message)
  } catch {
    // 日志失败不影响功能。
  }
}

/**
 * 会话对象作为 WeakMap 键。
 * @param session - 任意值。
 * @returns 是对象时原样返回，否则 undefined（没有会话就等于没有状态）。
 */
function objectKey(session: unknown): object | undefined {
  return typeof session === 'object' && session !== null ? session as object : undefined
}

/**
 * 从版本冲突错误里读冲突方的 stateVersion。
 * @param error - register 抛出的错误。
 * @returns 冲突方版本；不是版本冲突时 undefined。
 */
function conflictingStateVersion(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /already registered at stateVersion (\d+)/.exec(message)
  if (match === null) return undefined
  const version = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(version) && version >= 0 ? version : undefined
}

/**
 * 把 register() 的返回值接成句柄。
 *
 * 三种形状：可 await 的 ProjectionHandle（新代）、同步 disposer 函数（旧代，状态要
 * 经 ctx.sessionProjections.stateOf 读）、以及两者都不是（这一代没有投影注册面）。
 * @param ready - register 的返回值。
 * @param projections - 投影服务本身（旧代读状态的兜底）。
 * @returns 句柄；接不住时 undefined。
 */
async function handleOf(ready: unknown, projections: SessionProjectionsLike): Promise<PlanProjectionHandleLike | undefined> {
  const thenable = ready as { then?: unknown } | undefined
  if (typeof thenable?.then === 'function') {
    const handle = await (ready as Promise<unknown>)
    return typeof (handle as PlanProjectionHandleLike | undefined)?.stateOf === 'function'
      ? handle as PlanProjectionHandleLike
      : legacyHandle(projections)
  }
  return legacyHandle(projections)
}

/**
 * 旧代的读法：按 key 读。
 * @param projections - 投影服务。
 * @returns 句柄；服务没有按 key 读的能力时 undefined。
 */
function legacyHandle(projections: SessionProjectionsLike): PlanProjectionHandleLike | undefined {
  if (typeof projections.stateOf !== 'function') return undefined
  return {
    stateOf: (session: unknown) => projections.stateOf?.(session, PLAN_PROJECTION_KEY),
  }
}
// ── 事件订阅 ────────────────────────────────────────────────────────────────

/**
 * 订阅一个事件；这一代没有事件总线时安静跳过。
 * @param ctx - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 监听器。
 * @param options - cordis 订阅选项（`{ global: true }` 只看全局事件）。省略时按两参数订阅。
 * @returns 解绑函数；订不上时 undefined。
 */
function subscribe(
  ctx: unknown,
  event: string,
  listener: (...args: never[]) => unknown,
  options?: { global?: boolean },
): (() => void) | undefined {
  const on = (ctx as EventHostLike | undefined)?.on
  if (typeof on !== 'function') return undefined
  if (options !== undefined) {
    try {
      return on.call(ctx, event, listener, options)
    } catch {
      // 只认两个参数的宿主：退回去按两参数订阅，而不是整条订阅失败。
    }
  }
  try {
    return on.call(ctx, event, listener)
  } catch {
    return undefined
  }
}

/** 一次切换的四个动作（冻结契约的一部分）。 */
export type PlanTransition = 'committed' | 'queued' | 'cancelled' | 'noop'

/** 一次切换的可选参数。 */
export interface PlanSetOptions {
  /**
   * 是否补一条尾部通知。省略即 true（/plan 命令、用户点击都要那句说明）；
   * false 只给「工具结果已经把话说完了」的调用方用。
   */
  narrate?: boolean
}

/**
 * ctx.planMode 的实现。
 *
 * 一个会话一份（agent plane），所以内部所有状态都按会话/agent 分桶：待投递选择按
 * 会话 WeakMap，投影句柄一份（投影本身按会话折叠），内存兜底状态按会话 WeakMap。
 */
export class PlanModeController extends Service {
  /**
   * 依赖：tools 注册审批出口，sessionProjections 折叠状态，agents 读回合边界。
   *
   * **故意不含 systemPrompt** —— 这个 fork 一个 prompt 段都不注册，system 段在
   * 整个会话里逐字节恒定，进出计划模式都不重建前缀缓存。
   */
  static inject = ['tools', 'sessionProjections', 'agents']

  /** 校验后的部署指引，只经尾部消息投递。 */
  private readonly section: string

  /** plan 投影的读面；没有投影服务时 undefined。 */
  private planProjectionHandle: PlanProjectionHandleLike | undefined

  /** 尚未落到日志的选择，按会话。 */
  private readonly pendingIntents = new WeakMap<object, PendingIntent>()

  /** 没有投影服务时的内存状态兜底（计划模式照常可用，只是不持久化）。 */
  private readonly memoryStates = new WeakMap<object, PlanUnitState>()

  /** 服务在自己脚下被卸载：此时批过的计划不能再被追加，必须让模型重新呈交。 */
  private disposed = false

  /**
   * @param ctx - 宿主上下文。
   * @param config - 部署配置（默认空 section，会在挂载时被 resolveConfig 拒绝）。
   */
  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
  }

  /**
   * 挂载主体：注册投影、订阅 pre-step、注册审批出口与 /plan 命令。
   *
   * 顺序有讲究：投影先就位，pre-step 与 exit_plan_mode 才能读到状态。
   * @returns 挂载完成（投影注册可能是异步的）。
   */
  protected async [Service.init](): Promise<void> {
    const ctx: unknown = this.ctx
    this.planProjectionHandle = await this.acquirePlanProjection()
    const effect = (ctx as EffectHostLike | undefined)?.effect
    if (typeof effect === 'function') {
      try {
        effect.call(ctx, () => () => { this.disposed = true }, 'dsh-chatgpt-subscription: close plan-mode service')
      } catch {
        // 拿不到 effect 面就少一条卸载保护，不影响挂载。
      }
    }
    this.subscribePreStep()
    this.subscribeExitReminder()
    this.registerExitTool()
    this.registerPlanCommand()
  }

  /**
   * 订阅「回合以纯文本收尾」的提醒。
   *
   * 读法是 {@link PlanModeController.selectedActive}：它含未决选择，所以
   * `exit_plan_mode` 刚排进 `{ active: false }`、日志还没落的那一刻不会误提醒。
   * 宿主里同时装着 `installPlanModeCacheGuard` 时，进程级登记册保证一条
   * `llm/stream` 只被一条监听器接手，两处不会各提醒一次。
   */
  private subscribeExitReminder(): void {
    const controller = this
    const dispose = installPlanModeExitReminder(this.ctx, {
      isActive: (agent) => controller.selectedActive((agent as AgentLike | undefined)?.session),
    })
    if (dispose === undefined) return
    const effect = (this.ctx as unknown as EffectHostLike | undefined)?.effect
    if (typeof effect !== 'function') return
    try {
      effect.call(this.ctx, () => dispose, 'dsh-chatgpt-subscription: close the plan-mode exit reminder')
    } catch {
      // effect 面装不上就没有卸载钩子：就地摘掉，别留一条活过本服务的监听器。
      dispose()
    }
  }

  // ── 投影注册（版本协商） ──────────────────────────────────────────────────

  /**
   * 注册 plan 投影，并在版本冲突时按冲突方的 stateVersion 重试一次。
   *
   * 冲突本身是「同一个宿主里另一个 preset 已经注册了 plan」：那不是错误，而是
   * 共享同一个折叠单元的前提。所以只读错误里的版本号，不按 harness 版本猜。
   * @returns 投影读面；这一代没有投影注册面时 undefined。
   */
  private async acquirePlanProjection(): Promise<PlanProjectionHandleLike | undefined> {
    const projections = serviceOf<SessionProjectionsLike>(this.ctx, 'sessionProjections')
    if (projections === undefined || typeof projections.register !== 'function') {
      log(this.ctx, 'info', '[dsh-chatgpt-subscription] plan mode has no sessionProjections service: '
        + 'plan mode works but its state is not persisted in this host')
      return undefined
    }
    let stateVersion = PLAN_STATE_VERSION
    // 最多两次：默认版本 + 冲突方报告的版本。第三次没有新的信息来源。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const definition = createPlanProjectionDefinition(stateVersion)
      try {
        return await handleOf(projections.register(definition), projections)
      } catch (error: unknown) {
        const reported = conflictingStateVersion(error)
        if (reported === undefined || reported === stateVersion) {
          log(this.ctx, 'warn', '[dsh-chatgpt-subscription] plan mode could not register the plan projection: '
            + (error instanceof Error ? error.message : String(error)))
          return undefined
        }
        stateVersion = reported
      }
    }
    return undefined
  }

  // ── 状态读取 ──────────────────────────────────────────────────────────────

  /**
   * 服务是否已在自己脚下被卸载。
   *
   * 登记册（{@link registeredPlanControllerActive}）用它把「已经不算数的控制器」
   * 摘出判定：卸载之后残留的登记不能让宿主继续按老状态提醒。
   * @returns true 表示已卸载。
   */
  isDisposed(): boolean {
    return this.disposed
  }

  /**
   * 把会话对象绑进进程级登记册，让**宿主根作用域**也能读到本控制器的判定。
   *
   * 挂载点不止一个（`installPlanModeCacheGuard` 在根作用域、本控制器可能在
   * `isolate: { planMode: true }` 的子 realm），而 `ctx.get()` 看不见子 realm。
   * 控制器每观察到一个会话就登记一次，登记册跨 realm 共享，于是两边读到同一份
   * 判定。已卸载就不再登记。
   * @param session - 会话对象。
   */
  private bindSession(session: unknown): void {
    if (this.disposed) return
    const key = objectKey(session)
    if (key === undefined) return
    exitReminderRegistry().controllers.set(key, this)
  }

  /**
   * 已记录的计划状态。
   * @param session - 会话。
   * @returns 状态；读不到时是空状态（绝不抛错 —— 一个读失败不该打断整步）。
   */
  private planState(session: unknown): PlanUnitState {
    this.bindSession(session)
    const handle = this.planProjectionHandle
    if (handle !== undefined) {
      try {
        const state = handle.stateOf(session)
        if (typeof state === 'object' && state !== null && typeof (state as PlanUnitState).active === 'boolean') {
          return state as PlanUnitState
        }
      } catch {
        // 落到内存兜底。
      }
    }
    const key = objectKey(session)
    return key === undefined ? EMPTY_PLAN_STATE : this.memoryStates.get(key) ?? EMPTY_PLAN_STATE
  }

  /**
   * 已记录的计划模式开关。
   * @param session - 会话。
   * @returns 是否在计划模式。
   */
  loggedActive(session: unknown): boolean {
    return this.planState(session).active
  }

  /**
   * 本步会呈现给模型的状态：未决选择优先，否则是已记录状态。
   * @param session - 会话。
   * @returns 是否生效。
   */
  selectedActive(session: unknown): boolean {
    const key = objectKey(session)
    const pending = key === undefined ? undefined : this.pendingIntents.get(key)
    return pending?.active ?? this.loggedActive(session)
  }

  /**
   * 上一次告诉模型的模式；还没发过请求时 undefined。
   * @param session - 会话。
   * @returns true / false / undefined。
   */
  loggedActiveAtLastHeader(session: unknown): boolean | undefined {
    return this.planState(session).activeAtLastHeader ?? undefined
  }

  /**
   * 会话是否处在打开的回合里（决定「立刻落日志」还是「等下一个被接受的 pre-step」）。
   *
   * 三级降级，与官方等价：agents.turnBoundaryOf（新代）> 投影里的 turnBoundary
   * 状态（旧代）> 判定为没有打开回合（无从判定时按回合结束处理，与官方的
   * 「回合之外立刻提交」一致）。
   * @param session - 会话。
   * @returns 是否有打开回合。
   */
  hasOpenTurn(session: unknown): boolean {
    const agents = serviceOf<AgentsLike>(this.ctx, 'agents')
    if (typeof agents?.turnBoundaryOf === 'function') {
      try {
        const boundary = agents.turnBoundaryOf(session)
        if (boundary !== undefined) return boundary?.openTurnStartSeq !== null
      } catch {
        // 落到下一级。
      }
    }
    const projections = serviceOf<SessionProjectionsLike>(this.ctx, 'sessionProjections')
    if (typeof projections?.stateOf === 'function') {
      try {
        const boundary = projections.stateOf(session, 'turnBoundary') as { openTurnStartSeq?: unknown } | undefined
        if (boundary !== undefined) return boundary?.openTurnStartSeq !== null
      } catch {
        // 落到下一级。
      }
    }
    return false
  }

  /**
   * 读当前计划模式（已记录 + 未决选择），供调用方展示。
   * @param agent - 要读的 agent。
   * @returns 已记录状态，以及在果有未决选择时的目标。
   */
  get(agent: AgentLike): { active: boolean; pending?: boolean } {
    const session = agent?.session
    const active = this.loggedActive(session)
    const key = objectKey(session)
    const pending = key === undefined ? undefined : this.pendingIntents.get(key)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  // ── 切换 ──────────────────────────────────────────────────────────────────

  /**
   * 选择计划模式是否生效。
   *
   * 回合之外立刻落日志并补一句说明；回合之内留作未决选择，等下一个被接受的
   * pre-step（那时才写日志、才补说明）。重复选择当前值或已未决的同值是 no-op。
   * @param agent - 要切换的 agent。
   * @param active - 目标状态。
   * @param options - 可选：narrate=false 表示调用方的工具结果已经把话说完了。
   * @returns 发生了什么。
   */
  set(agent: AgentLike, active: boolean, options: PlanSetOptions = {}): PlanTransition {
    const session = agent?.session
    const key = objectKey(session)
    if (key === undefined) return 'noop'
    this.bindSession(session)
    const narrate = options.narrate !== false
    const pending = this.pendingIntents.get(key)
    const target = pending?.active ?? this.loggedActive(session)
    if (active === target) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(key, { active, narrate })
      return this.loggedActive(session) === active ? 'cancelled' : 'queued'
    }
    if (active === this.loggedActive(session)) {
      this.pendingIntents.delete(key)
      return 'cancelled'
    }
    this.appendMode(session, active)
    this.pendingIntents.delete(key)
    const narration = this.narration(session, active)
    if (narration !== undefined) this.injectMessage(agent, narration)
    return 'committed'
  }

  /**
   * 把一个未决选择落进日志。
   * @param session - 会话。
   */
  private onBoundary(session: unknown): void {
    const key = objectKey(session)
    if (key === undefined) return
    const pending = this.pendingIntents.get(key)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.loggedActive(session)) {
      this.pendingIntents.delete(key)
      return
    }
    this.appendMode(session, target)
    this.pendingIntents.delete(key)
  }

  /**
   * 追加一条 plan/mode 事件，并同步内存兜底状态。
   *
   * 只在 append 成功后更新内存：写失败要留下可重试的选择，而不是一个假状态。
   * @param session - 会话。
   * @param active - 目标状态。
   */
  private appendMode(session: unknown, active: boolean): void {
    const append = (session as SessionLike | undefined)?.append
    if (typeof append === 'function') {
      append.call(session, PLAN_MODE_EVENT, { active })
    }
    const key = objectKey(session)
    if (key === undefined) return
    const current = this.memoryStates.get(key) ?? EMPTY_PLAN_STATE
    this.memoryStates.set(key, { ...current, active, wanted: null, entered: current.entered || active })
  }

  /**
   * 把一条尾部消息塞进当前会话。
   * @param agent - 调用方 agent。
   * @param message - 用户角色消息。
   */
  private injectMessage(agent: AgentLike, message: unknown): void {
    const inject = agent?.inject
    if (typeof inject === 'function') {
      inject.call(agent, message)
      return
    }
    const steer = agent?.steer
    if (typeof steer === 'function') steer.call(agent, message)
  }

  /**
   * 造一条「用户切换了模式」的尾部通知。
   *
   * 与官方的差别只有一处：进入时的通知**携带部署指引**（section）。官方把指引放在
   * 动态 system 段里，那正是前缀重建的来源；改成一次性尾部消息后，指引只付一次
   * 输入费，而且之后每一步都还在历史里（末尾追加不破坏前缀）。
   *
   * 触发条件也放宽了一点：官方只在「上一次请求头告诉过模型另一种模式」时才讲；
   * 这里在进入方向还接受 told === undefined（用户在第一发请求之前就 /plan）。
   * @param session - 会话。
   * @param target - 目标状态。
   * @returns 通知消息；不需要讲时 undefined。
   */
  narration(session: unknown, target: boolean): unknown {
    const told = this.loggedActiveAtLastHeader(session)
    if (target) {
      if (told === true) return undefined
      return createPlanNotice('The user switched this session to plan mode.', this.section)
    }
    if (told !== true) return undefined
    return createPlanNotice('The user switched this session back to the default mode.')
  }

  // ── pre-step 监听 ─────────────────────────────────────────────────────────

  /**
   * 订阅 agent/pre-step：先 await next()，只对已经落定的决策动手。
   *
   * 三件事：把未决选择落进日志；在需要时把通知**追加到消息末尾**（末尾追加不改变
   * 已发前缀，这是这个 fork 的全部意义所在）。
   */
  private subscribePreStep(): void {
    const listener = async (
      payload: PreStepPayloadLike,
      next: () => Promise<PreStepDecisionLike | undefined>,
    ): Promise<PreStepDecisionLike | undefined> => {
      const decision = await next()
      const agent = payload?.agent
      const session = agent?.session
      const key = objectKey(session)
      if (decision === undefined || decision.kind === 'reject' || key === undefined) return decision
      if (payload?.signal?.aborted === true) return decision
      // 宿主守卫可能挂在根作用域、本控制器挂在隔离的子 realm：会话一到手就登记，
      // 免得「先 claim 再判定」的守卫读不到本控制器的未决选择。
      if (!this.disposed) this.bindSession(session)
      const pending = this.pendingIntents.get(key)
      if (pending === undefined) return decision
      const narration = this.narration(session, pending.active)
      try {
        this.onBoundary(session)
      } catch (error: unknown) {
        log(this.ctx, 'warn', '[dsh-chatgpt-subscription] failed to append the selected plan mode at step start: '
          + (error instanceof Error ? error.message : String(error)))
        return decision
      }
      if (pending.narrate === false || narration === undefined) return decision
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, narration] }
    }
    subscribe(this.ctx, 'agent/pre-step', listener as unknown as (...args: never[]) => unknown)
  }

  // ── 审批出口 ──────────────────────────────────────────────────────────────

  /**
   * 注册 exit_plan_mode —— **不带 { when }**。
   *
   * 这是与官方唯一的工具面差别，也是 tools / tools:sdk 两边零重建的全部原因：
   * 条件准入会让工具表在进入那一步变大，PTC 的 run_code 绑定与 native 声明同时重发。
   * 无条件注册后，「只在计划模式可用」由 execute 里的 loggedActive 判定执行，报错
   * 文案与官方一致。
   */
  private registerExitTool(): void {
    const tools = serviceOf<ToolsRegistryLike>(this.ctx, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      log(this.ctx, 'info', '[dsh-chatgpt-subscription] plan mode has no tools service: '
        + 'exit_plan_mode was not registered, so the plan can only be left through /plan off')
      return
    }
    try {
      tools.register(this.exitDefinition())
    } catch (error: unknown) {
      log(this.ctx, 'warn', '[dsh-chatgpt-subscription] plan mode could not register exit_plan_mode: '
        + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * 造 exit_plan_mode 的定义。
   * @returns 工具定义。
   */
  private exitDefinition(): ToolDefinition {
    const ctx = this.ctx
    // defineTool 的执行器**不回传接收者**（dsh-tools 的 runTool 直接调 execute），
    // 所以 execute 里不能读 this：这里把控制器捕获成闭包常量。
    const controller = this
    // 不传第二个参数：{ when } 会让工具表随计划模式变化，那正是要消掉的重建。
    return defineTool({
      name: EXIT_PLAN_MODE,
      description: 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
        + 'The user may approve (carry out the plan from your next step) or keep '
        + 'planning — their feedback comes back in the tool result; revise and present again.',
      parameters: {
        plan: {
          type: 'string',
          required: true,
          description: 'The complete plan, as markdown, starting with a # heading that names it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          const approved = (value as { approved?: unknown } | undefined)?.approved === true
          return [{
            type: 'text',
            text: approved
              ? 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
              : 'The user dismissed the plan review to reply in their own words; plan mode remains active.',
          }] as ContentBlock[]
        },
      },
      async execute(args, exec): Promise<{ approved: boolean }> {
        const execution = exec as unknown as ExitExecutionLike
        const agent = execution.agent as AgentLike | undefined
        // 准入不再由 { when } 表达：这里就是唯一的门。工具随时在表里，但只有计划
        // 模式生效时才允许交计划。
        if (agent === undefined || agent === null || !controller.loggedActive(agent.session)) {
          throw new Error(EXIT_PLAN_MODE + ' is only available in plan mode')
        }
        const plan = typeof (args as { plan?: unknown }).plan === 'string' ? (args as { plan: string }).plan : ''
        if (!/^#\s+\S/.test(plan.trim())) {
          throw new Error(EXIT_PLAN_MODE + ' requires a non-empty markdown plan starting with a # heading')
        }
        const interaction = serviceOf<UserQuestionsLike>(ctx, 'userQuestions')
        if (interaction === undefined || typeof interaction.ask !== 'function') {
          throw new Error('no user-questions channel is available to review the plan; '
            + 'ask the user to switch the session mode instead')
        }
        let answer: { answers?: readonly UserQuestionAnswerLike[] }
        try {
          answer = await interaction.ask({
            questions: [{
              id: REVIEW_ID,
              header: 'Plan review',
              question: 'Approve this plan and leave plan mode?',
              detail: plan,
              options: [
                { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
                { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
              ],
              // 只影响呈现：能画审批卡片的 UI 会把它画成评审决定，两种情况下答案都
              // 还是上面两个文案之一。
              intent: { kind: 'plan-review', approve: APPROVE_LABEL, callId: execution.callId },
            }],
            agent,
            signal: execution.signal,
          })
        } catch (cause: unknown) {
          // 用户撤掉审批不是「审批失败」：他把这一回合拿回去说别的话了，所以在这里
          // 结束回合，而不是花一次模型请求去等。中止（取消回合、线路拆除）保留自己的
          // 失败。
          if ((cause as { code?: unknown } | undefined)?.code === 'ASK_CANCELLED') {
            if (typeof execution.concludeTurn === 'function') {
              execution.concludeTurn()
              return { approved: false }
            }
            throw new Error('the user dismissed the plan review and this harness generation cannot conclude the turn '
              + 'from a tool; present the plan again or switch the session mode instead')
          }
          throw cause
        }
        // 审批可能比本插件 fiber 活得久。没有 pre-step 监听器，一个被批准的选择永远
        // 落不进日志，所以这里失败并让模型继续规划。
        if (controller.disposed) {
          throw new Error('the plan-mode service was reloaded while the plan was under review; '
            + 'present the plan again')
        }
        const items = (answer?.answers ?? []).filter(entry => entry.id === REVIEW_ID)
        const item = items.length === 1 ? items[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = typeof item?.custom === 'string' ? item.custom : ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : 'The user chose to keep planning; their feedback: ' + feedback)
        }
        // 本批工具调用余下步骤仍要看到计划指引：静默选择在下一个被接受的 pre-step
        // 之前落日志（工具结果已经讲清了切换，所以不再补通知）。
        const key = objectKey(agent.session)
        if (key !== undefined) controller.pendingIntents.set(key, { active: false, narrate: false })
        return { approved: true }
      },
    })
  }

  // ── /plan 命令 ────────────────────────────────────────────────────────────

  /**
   * 注册 /plan 命令（手动进入/离开计划模式的入口）。
   *
   * 命令面板在部分宿主里不存在，所以这里用运行时注入：有 commands 才注册，
   * 没有就安静跳过 —— 缺一个可选服务不该让计划模式整体挂不上。
   */
  private registerPlanCommand(): void {
    const ctx = this.ctx
    const inject = (ctx as unknown as InjectHostLike).inject
    if (typeof inject !== 'function') return
    try {
      inject.call(ctx, ['commands'], (scope: unknown) => {
        const commands = serviceOf<CommandsRegistryLike>(scope, 'commands')
        if (commands === undefined || typeof commands.register !== 'function') return
        try {
          commands.register({
            definitionId: name,
            name: 'plan',
            description: 'Enter or leave plan mode',
            input: { hint: '[off|message]', attachments: true },
            handler: (payload: { agent: AgentLike, rawInput?: string, attachments?: unknown[] }) => {
              const raw = typeof payload?.rawInput === 'string' ? payload.rawInput.trim() : ''
              const attachments = Array.isArray(payload?.attachments) ? payload.attachments : []
              if (raw === 'off' && attachments.length > 0) {
                return { kind: 'error', text: 'Attachments cannot accompany /plan off.' }
              }
              if (raw === 'off') {
                switch (this.set(payload.agent, false)) {
                  case 'committed':
                    return { kind: 'success', text: 'Plan mode off.' }
                  case 'queued':
                    return { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
                  case 'cancelled':
                    return { kind: 'success', text: 'Plan mode entry cancelled.' }
                  case 'noop':
                    return this.loggedActive(payload.agent?.session)
                      ? { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
                      : { kind: 'success', text: 'Plan mode is already inactive.' }
                }
              }
              const outcome = this.set(payload.agent, true)
              if (raw !== '' || attachments.length > 0) {
                const steer = payload.agent?.steer
                if (typeof steer === 'function') {
                  steer.call(payload.agent, createUserMessage({
                    content: [
                      ...attachments as ContentBlock[],
                      ...(raw === '' ? [] : [{ type: 'text' as const, text: raw }]),
                    ],
                    source: { kind: 'user' },
                  }))
                }
              }
              return {
                kind: 'success',
                text: outcome === 'committed'
                  ? 'Plan mode on. Use /plan off to leave.'
                  : 'Entering plan mode (applies from the next step). Use /plan off to leave.',
              }
            },
          })
        } catch {
          // 命令名已被占用：宿主里另一份 plan-mode 已经注册过，不抢。
        }
      })
    } catch {
      // 没有命令注册面。
    }
  }
}

// ── 回合结束提醒（零缓存漂移） ──────────────────────────────────────────────

/**
 * 计划模式下「只用纯文本收尾」时投给模型的提醒正文。
 *
 * 冻结契约的一部分：只经 {@link createPlanNotice} 的尾部用户消息投递，**不进 system
 * 段、不动工具表**，所以它不会让任何前端前缀缓存重建。
 */
export const PLAN_EXIT_REMINDER_TEXT = 'Plan mode is still active, and the previous response ended in plain text '
  + 'without calling a tool. If the plan is ready, call exit_plan_mode now with the complete markdown plan '
  + '(starting with a # heading) as the sole tool call. If an unsettled user decision blocks planning, call '
  + 'ask_user_question instead. If the user explicitly asked to abandon planning, call leave_plan_mode.'

/** 一条「纯文本收尾」之后的提醒状态，按会话分桶。 */
interface ExitReminderState {
  /** 连续「纯文本收尾」的次数；工具调用、离开计划模式都会清零。 */
  consecutive: number
  /** 本回合已经排进 whenIdle 队列的提醒（同一回合只排一次）。 */
  pending: boolean
}

/**
 * 提醒的进程级登记册。
 *
 * 两个挂载点（`PlanModeController` 与 `installPlanModeCacheGuard`）可能同时活在一个
 * 进程里，`llm/stream` 又是**全局瀑布**：同一个 `request` 对象会被一路传下去，每个
 * 监听器都能看到它。这里用登记册把两件事统一起来：
 *
 * - `claimed`：一个 `request` 只允许一条监听器接手，另一条原样 `next()` 透传；
 * - `states`：按会话分桶的计数，两处读的是同一份，cap 才是真的 1（而不是各 1）。
 */
export interface PlanModeExitReminderRegistry {
  /** 已被某条提醒监听器接手过的 `llm/stream` 请求对象。 */
  claimed: WeakSet<object>
  /** 按会话（`agent.session ?? agent`）分桶的提醒状态。 */
  states: WeakMap<object, ExitReminderState>
  /**
   * 按会话对象登记的 {@link PlanModeController}。
   *
   * 宿主守卫装在**根作用域**，控制器却可能挂在 dispatch preset 的
   * `isolate: { planMode: true }` 子 realm 里：那种情况下根作用域的
   * `ctx.get('planMode')` 恒为 undefined，读不到 `selectedActive`（含未决选择），
   * 提醒要么完全不来（内存兜底宿主没有 plan 投影），要么按投影读到过期的
   * `active: true` 而误提醒。控制器每见到一个会话对象就在这里登记一次，宿主
   * 守卫改成先读这里，隔离与否都读得到同一份判定。
   */
  controllers: WeakMap<object, RegisteredPlanController>
}

/** 登记册里记录的控制器读面（结构化，避免与 cordis 实例形状耦合）。 */
export interface RegisteredPlanController {
  /** 本步会呈现给模型的状态：未决选择优先，否则是已记录状态。 */
  selectedActive(session: unknown): boolean
  /** 控制器是否已经卸载；卸载后它的判定不再作数。 */
  isDisposed(): boolean
}

/** 登记册在 `globalThis` 上的键。跨模块实例共享，值本身只由本模块写入。 */
const EXIT_REMINDER_KEY = Symbol.for('dsh-chatgpt-subscription.plan-mode.exit-reminder.claimed')

/**
 * 取（或建）进程级登记册。
 *
 * 用 `Symbol.for` 而不是模块级常量：同一个进程里可能有两份本包实例（宿主插件与
 * preset 行分别加载），它们必须看到同一份 `claimed` / `states`。
 * @returns 登记册。
 */
function exitReminderRegistry(): PlanModeExitReminderRegistry {
  const holder = globalThis as unknown as Record<symbol, PlanModeExitReminderRegistry | undefined>
  const existing = holder[EXIT_REMINDER_KEY]
  if (
    existing !== undefined
    && existing.claimed instanceof WeakSet
    && existing.states instanceof WeakMap
    && existing.controllers instanceof WeakMap
  ) {
    return existing
  }
  const created: PlanModeExitReminderRegistry = {
    claimed: new WeakSet<object>(),
    states: new WeakMap<object, ExitReminderState>(),
    controllers: new WeakMap<object, RegisteredPlanController>(),
  }
  holder[EXIT_REMINDER_KEY] = created
  return created
}

/**
 * 用会话对象问本包的 {@link PlanModeController}：此刻算不算在计划模式。
 *
 * 与 `ctx.get('planMode')` 的区别是**看不见 realm 边界**：登记册挂在
 * `globalThis` 上，控制器往里面登记的是「这个会话由我负责」，所以宿主根作用域
 * 也能读到 preset 里 `isolate: { planMode: true }` 那个子 realm 的判定 —— 含未决
 * 选择（`exit_plan_mode` 刚排进 `{ active: false }`、日志还没落的那一刻）。
 *
 * 未登记（不是本包的控制器，比如内置 preset 挂的官方服务）、已卸载、或读法抛错
 * 时返回 undefined，由调用方自己退回投影。
 * @param session - 会话对象。
 * @returns true / false / undefined。
 */
export function registeredPlanControllerActive(session: unknown): boolean | undefined {
  const key = objectKey(session)
  if (key === undefined) return undefined
  const controller = exitReminderRegistry().controllers.get(key)
  if (controller === undefined || controller.isDisposed()) return undefined
  try {
    const active = controller.selectedActive(session)
    return typeof active === 'boolean' ? active : undefined
  } catch {
    return undefined
  }
}

/**
 * 一个 agent 的提醒桶键：优先会话对象（同一会话换一个 agent 也还是同一桶），
 * 否则退回 agent 自己。
 * @param agent - 任意值。
 * @returns 桶键；两者都不是对象时 undefined。
 */
function reminderBucket(agent: unknown): object | undefined {
  const session = (agent as { session?: unknown } | undefined)?.session
  return objectKey(session) ?? objectKey(agent)
}

/**
 * 取（或建）一个桶的提醒状态。
 * @param registry - 登记册。
 * @param bucket - 桶键。
 * @returns 状态（就地可变）。
 */
function reminderStateOf(registry: PlanModeExitReminderRegistry, bucket: object): ExitReminderState {
  let state = registry.states.get(bucket)
  if (state === undefined) {
    state = { consecutive: 0, pending: false }
    registry.states.set(bucket, state)
  }
  return state
}

/**
 * 读宿主的 Agent 登记表，两条路线都试（`ctx.get('agents')` 与结构化属性）。
 * @param ctx - 宿主上下文。
 * @returns 登记表；读不到时 undefined。
 */
function agentRegistryOf(ctx: unknown): { get(id: unknown): unknown } | undefined {
  const viaGetter = serviceOf<{ get?: unknown }>(ctx, 'agents')
  if (typeof viaGetter?.get === 'function') return viaGetter as { get(id: unknown): unknown }
  let direct: unknown
  try {
    direct = (ctx as { agents?: unknown } | undefined)?.agents
  } catch {
    return undefined
  }
  return typeof (direct as { get?: unknown } | undefined)?.get === 'function'
    ? direct as { get(id: unknown): unknown }
    : undefined
}

/** `llm/stream` 请求里本模块会读的部分。 */
interface ReminderStreamRequestLike {
  /** 会话 id（用它反查 agent）。 */
  readonly sessionId?: unknown
  /** 调用目的；对话请求是 undefined，标题/压缩等一次性请求带值。 */
  readonly purpose?: unknown
}

/** `llm/stream` 的一个块里本模块会读的部分。 */
interface ReminderChunkLike {
  /** 块类型。 */
  readonly type?: unknown
  /** 文本增量。 */
  readonly text?: unknown
  /** `block-start` 的块种类。 */
  readonly blockType?: unknown
  /** 终结块的原因。 */
  readonly reason?: { readonly kind?: unknown } | null
}

/** agent 上本模块会读的部分。 */
interface ReminderAgentLike {
  /** 会话对象。 */
  readonly session?: unknown
  /** 等这个 agent 空闲。 */
  readonly whenIdle?: () => unknown
  /** 把一条用户消息推进回合。 */
  readonly steer?: (message: unknown) => void
  /** 把一个尾部消息塞进本轮（`steer` 缺席时的退路）。 */
  readonly inject?: (message: unknown) => void
}

/** 提醒的安装选项。 */
export interface PlanModeExitReminderOptions {
  /**
   * 「此刻还在计划模式吗」。
   *
   * 两个挂载点各给各的读法：控制器给 `selectedActive`（含未决选择），宿主守卫给
   * plan 投影。返回 `undefined` 表示这一代读不出来 —— 那就不提醒：一条读不准的
   * 提醒会把模型从正当的收尾里拽回来，代价比漏一次大。
   * @param agent - 调用方 agent。
   * @returns true / false / undefined。
   */
  isActive?(agent: unknown): boolean | undefined
}

/**
 * 这个块是不是一段可见文本。
 *
 * 空白一律 trim：只有空白的文本等于没说话，那种回合归 `no-answer-resume` 管，不该
 * 在这里被当成「讲完了话」。
 * @param chunk - 候选块。
 * @returns 是可见文本时为 true。
 */
function isVisibleTextChunk(chunk: ReminderChunkLike | undefined): boolean {
  return chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== ''
}

/**
 * 这个块是不是工具调用的开始。
 * @param chunk - 候选块。
 * @returns 是工具调用时为 true。
 */
function isToolCallChunk(chunk: ReminderChunkLike | undefined): boolean {
  if (chunk?.type === 'tool-call-delta') return true
  return chunk?.type === 'block-start' && chunk.blockType === 'tool-call'
}

/**
 * 这个块是不是「模型自己讲完了」的终结块。
 * @param chunk - 候选块。
 * @returns `finish` 且原因为 `stop` 时为 true。
 */
function isStopFinish(chunk: ReminderChunkLike | undefined): boolean {
  return chunk?.type === 'finish' && chunk.reason?.kind === 'stop'
}

/**
 * 把一条订阅句柄解掉（cordis 两代形状：函数或带 dispose 的对象）。
 * @param handle - `subscribe` 的返回值。
 */
function releaseSubscription(handle: unknown): void {
  if (typeof handle === 'function') {
    handle()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  try {
    disposable?.dispose?.()
  } catch {
    // 卸载期的单点失败不影响其余卸载。
  }
}

/**
 * 装一台「计划模式回合结束提醒」。
 *
 * ## 它解决什么
 *
 * 计划模式里模型讲完一段话就收尾（`finish: stop`、零工具调用）时，宿主不会替它做
 * 任何事：那一回合就停在那里，直到人去催「确认呢」。这里在 `llm/stream` 上观察一
 * 次已完成、只有文本、没有工具调用的对话请求，然后在 agent 空闲之后补一条尾部通知，
 * 让模型自己选三条出路（`exit_plan_mode` / `ask_user_question` / `leave_plan_mode`）。
 *
 * ## 为什么零缓存漂移
 *
 * 一条 `agent.steer(createPlanNotice(...))` 的尾部用户消息：不注册 system 段、不动
 * `tools.definitions`、不改任何工具 schema。末尾追加不破坏已发前缀。
 *
 * ## 为什么不会重复提醒
 *
 * 同一进程里两个挂载点共享 {@link PlanModeExitReminderRegistry}：`claimed` 让一条
 * `llm/stream` 只被一条监听器接手（另一条原样透传），`states` 让两处读同一个计数。
 *
 * @param ctx - 宿主上下文（结构化：老代 ctx 也认）。
 * @param options - 见 {@link PlanModeExitReminderOptions}。
 * @returns 摘掉全部订阅的 disposer；这一代没有事件总线、或一条都没订上时 undefined。
 */
export function installPlanModeExitReminder(
  ctx: unknown,
  options: PlanModeExitReminderOptions = {},
): (() => void) | undefined {
  const on = (ctx as EventHostLike | undefined)?.on
  if (typeof on !== 'function') return undefined
  const registry = exitReminderRegistry()
  let closed = false

  /**
   * 读「此刻还在计划模式吗」。读法抛错等于读不出来。
   * @param agent - 调用方 agent。
   * @returns true / false / undefined。
   */
  const activeOf = (agent: unknown): boolean | undefined => {
    if (typeof options.isActive !== 'function') return undefined
    try {
      return options.isActive(agent)
    } catch {
      return undefined
    }
  }

  /**
   * 用会话 id 反查活着的 agent。每次现读：这个插件可能比 agents 服务先加载。
   * @param sessionId - 请求上的会话 id。
   * @returns agent；读不到时 undefined。
   */
  const resolveAgent = (sessionId: unknown): ReminderAgentLike | undefined => {
    if (typeof sessionId !== 'string') return undefined
    let resolved: unknown
    try {
      resolved = agentRegistryOf(ctx)?.get(sessionId)
    } catch {
      return undefined
    }
    return objectKey(resolved) === undefined ? undefined : resolved as ReminderAgentLike
  }

  /**
   * 空闲之后真正投递。排队期间插件可能已经卸载、会话可能已经关掉、计划模式可能
   * 已经退出、子代理可能还在跑 —— 这些都要在**投递那一刻**重新判断。
   * @param state - 本会话的提醒状态。
   * @param agent - 调用方 agent。
   */
  const fire = (state: ExitReminderState, agent: ReminderAgentLike): void => {
    state.pending = false
    if (closed) return
    // 子代理不该收到主控的提醒：它在自己的会话里干活，计划是主控的事。
    if (isDelegatedCaller(agent, ctx)) return
    const active = activeOf(agent)
    if (active !== true) {
      // 已经离开计划模式：这一次连续收尾到此为止，下次进入重新开始。
      // 读不出来（undefined —— 这一步的宿主还没给判定）时**既不清零也不计数**：
      // 它既不是一次计划模式的收尾，也不该把这次名额用掉。
      if (active === false) state.consecutive = 0
      return
    }
    if (hasRunningChildSubagent(agent, ctx)) {
      // 有子代理在跑：主控按 R-W 是**合法地**结束回合去等完成，不能打扰它。
      // 但这一次提醒不能算用掉：子代理完成后主控大概率还要再讲一次话。
      state.consecutive = 0
      return
    }
    // 到这里才真的用掉这一次名额：上面每一条退出路径都没有投递，不能占 cap。
    if (state.consecutive >= 1) return
    state.consecutive += 1
    const message = createPlanNotice(PLAN_EXIT_REMINDER_TEXT, undefined, 'Plan mode exit reminder')
    try {
      if (typeof agent.steer === 'function') agent.steer(message)
      else if (typeof agent.inject === 'function') agent.inject(message)
    } catch (error: unknown) {
      log(ctx, 'warn', '[dsh-chatgpt-subscription] could not queue the plan-mode exit reminder: '
        + (error instanceof Error ? error.message : String(error)))
    }
  }

  /**
   * 等 agent 空闲，再投递。
   *
   * `whenIdle` 是整件事的前提：回合还在跑的时候 `steer` 只会被塞进收件箱而没有
   * 唤醒跟着，那条消息永远不会被读到。这一代没有 `whenIdle` 时退成微任务，投递
   * 仍会发生，只是取件时机由宿主决定。
   * @param state - 本会话的提醒状态。
   * @param agent - 调用方 agent。
   */
  const queue = (state: ExitReminderState, agent: ReminderAgentLike): void => {
    const whenIdle = agent.whenIdle
    let idle: unknown
    if (typeof whenIdle === 'function') {
      try {
        idle = whenIdle.call(agent)
      } catch {
        idle = undefined
      }
    }
    if (idle === undefined || idle === null) {
      queueMicrotask(() => fire(state, agent))
      return
    }
    Promise.resolve(idle).then(
      () => fire(state, agent),
      () => fire(state, agent),
    )
  }

  /**
   * 一次已完成的对话流落定之后做什么。
   * @param request - `llm/stream` 的请求对象。
   * @param observed - 这次流里观察到的事实。
   */
  const settleTurn = (
    request: unknown,
    observed: { visibleText: boolean; toolCall: boolean; stopped: boolean },
  ): void => {
    const call = request as ReminderStreamRequestLike | undefined
    const agent = resolveAgent(call?.sessionId)
    const bucket = reminderBucket(agent)
    // 有工具调用的回合不进「连续纯文本」的账：它就是这一轮干了实事。
    if (observed.toolCall) {
      if (bucket !== undefined) reminderStateOf(registry, bucket).consecutive = 0
      return
    }
    // 标题、压缩之类的一次性请求没有「回合」可言。
    if (call?.purpose !== undefined) return
    // 一段可见文字都没有：那是 no-answer-resume 的地盘。
    if (!observed.visibleText || !observed.stopped) return
    if (agent === undefined || bucket === undefined) return
    if (typeof agent.steer !== 'function' && typeof agent.inject !== 'function') return
    if (closed) return
    const state = reminderStateOf(registry, bucket)
    // 一个回合只排一条；连续收尾封顶一条（cap = 1）。
    if (state.pending || state.consecutive >= 1) return
    // 明摆着不在计划模式的回合不进账，也不排 whenIdle：普通聊天会话不该每个回合都
    // 排一条注定什么都不做的任务。计数只在 fire() 真正投递时发生，所以 undefined
    // （判定还没准备好）既不清零也不占名额。
    if (activeOf(agent) === false) {
      state.consecutive = 0
      return
    }
    state.pending = true
    queue(state, agent)
  }

  /**
   * 包住下游流：原样透传每个块，只记下判定需要的三件事。
   *
   * `finally` 在每条退出路径上都会跑，而其中两条什么都没证明：消费者中途放弃
   * （用户按了停止），或下游抛错。两者都没有交付终结块，所以都不落定。
   * @param request - `llm/stream` 的请求对象。
   * @param next - 下一棒。
   * @returns 透传流。
   */
  const watch = (request: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    return (async function* () {
      let visibleText = false
      let toolCall = false
      let stopped = false
      let completed = false
      try {
        for await (const chunk of next()) {
          const seen = chunk as ReminderChunkLike | undefined
          if (isVisibleTextChunk(seen)) visibleText = true
          else if (isToolCallChunk(seen)) toolCall = true
          else if (isStopFinish(seen)) stopped = true
          yield chunk
        }
        completed = true
      } finally {
        if (completed) settleTurn(request, { visibleText, toolCall, stopped })
      }
    })()
  }

  /**
   * `llm/stream` 的监听器：接手一条流，或原样透传。
   * @param request - 请求对象。
   * @param next - 下一棒。
   * @returns 流。
   */
  const onStream = (request: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const claim = objectKey(request)
    if (claim !== undefined) {
      if (registry.claimed.has(claim)) return next()
      registry.claimed.add(claim)
    }
    return watch(request, next)
  }

  /**
   * 会话关掉时丢掉它的计数：连续收尾的账属于那个会话，不该活过它。
   * @param payload - `agent/disposed` 的载荷。
   */
  const onAgentDisposed = (payload: { agent?: unknown }): void => {
    const bucket = reminderBucket(payload?.agent)
    if (bucket === undefined) return
    registry.states.delete(bucket)
  }

  const offStream = subscribe(
    ctx,
    'llm/stream',
    onStream as unknown as (...args: never[]) => unknown,
    { global: true },
  )
  const offDisposed = subscribe(ctx, 'agent/disposed', onAgentDisposed as unknown as (...args: never[]) => unknown)
  if (offStream === undefined && offDisposed === undefined) return undefined
  return () => {
    closed = true
    releaseSubscription(offStream)
    releaseSubscription(offDisposed)
  }
}

/**
 * 造一条计划模式尾部通知。
 *
 * 用 createUserMessage 而不是手写消息字面量：DSH 对每条被接纳的消息都校验 id 与
 * source，手写字面量会在第一次 steer 时同步抛错（见 SKILL 的陷阱清单）。
 * @param text - 通知正文；指引会接在它后面。
 * @param section - 计划模式指引正文，接在通知之后。
 * @returns 用户角色消息。
 */
export function createPlanNotice(text: string, section?: string, summary?: string): unknown {
  const body = section === undefined || section.trim() === '' ? text : text + '\n\n' + section
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    // 通知本身通常就是一句话，摘要即它自己；注入长正文时由调用方给一个短标签。
    source: { kind: PLAN_NOTICE_SOURCE_KIND, form: 'notice', summary: summary ?? text },
  })
}

export default PlanModeController
