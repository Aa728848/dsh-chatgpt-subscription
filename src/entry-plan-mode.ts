/**
 * 「计划模式」服务 —— ctx.planMode 的 **fork**（本包在 dispatch preset 里替换
 * harness 官方的 @deepseek-ai/dsh-plan-mode）。
 *
 * ## 为什么必须 fork
 *
 * 官方实现在**进入**与**离开**计划模式的那一步同时改两样东西，而这两样都是请求
 * 前缀的一部分，于是每进一次计划模式就烧掉一整次前缀缓存重建：
 *
 * 1. 动态 plan:policy 段：systemPrompt.section(...) 的文本在 section 与 '' 之间翻转
 *    —— system 段在请求最前面，改一个字就是全前缀作废；
 * 2. exit_plan_mode 用 { when } 逐步准入 —— 工具表一变，native tools 与 PTC
 *    tools:sdk 两边同时重建。
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
  /** 订阅一个事件，返回解绑函数。 */
  on?(name: string, listener: (...args: never[]) => unknown): (() => void) | undefined
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
 * @returns 解绑函数；订不上时 undefined。
 */
function subscribe(
  ctx: unknown,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  const on = (ctx as EventHostLike | undefined)?.on
  if (typeof on !== 'function') return undefined
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
    this.registerExitTool()
    this.registerPlanCommand()
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
   * 已记录的计划状态。
   * @param session - 会话。
   * @returns 状态；读不到时是空状态（绝不抛错 —— 一个读失败不该打断整步）。
   */
  private planState(session: unknown): PlanUnitState {
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
