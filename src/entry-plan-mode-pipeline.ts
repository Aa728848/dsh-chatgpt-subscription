/**
 * 「计划模式管线」的宿主入口 —— 本包**第三个** loader 行（组件）。
 *
 * 调度模式（dispatch preset）的接线顺序是「R-G 澄清访谈收敛 → 规划 → 派发」。
 * 澄清访谈收敛之后，主代理需要**显式进入**计划模式，把「只是进入」与「下一步
 * 才开始探索并出计划」分开，否则模型会把进入与出计划压在同一步里，计划就变成
 * 了没有探索的猜测。放弃规划时同样需要一个明确的出口。
 *
 * 这一行因此只做两件事，各对应一个模型侧工具（工具名是冻结契约的一部分）：
 *
 * 1. `ENTER_PLAN_MODE_TOOL` —— `ctx.planMode.set(agent, true)`，返回给模型的
 *    文本把「本步只完成进入」讲清楚；
 * 2. `LEAVE_PLAN_MODE_TOOL` —— `ctx.planMode.set(agent, false)`，语义是
 *    **放弃规划、不交计划**，并且必须说清它不是审批出口。
 *
 * 审批出口是 `exit_plan_mode`，这一行**不注册**它、不替换它：在 dispatch preset 里
 * 它由本包 fork 的 plan-mode 服务注册（`src/entry-plan-mode.ts`），在别的 preset 里
 * 由 harness 官方实现注册；重复注册同名工具会让宿主启动失败。
 *
 * ## 与 fork 的协调：**两参调用是刻意的**
 *
 * fork 的 `set(agent, active, options?)` 接受第三个参数 `{ narrate: false }`，用来
 * 压制「用户切换了模式」那句尾部通知；但这一行**不传**它，原因有两条：
 *
 * 1. 那句通知是部署指引唯一的投递口。fork 把 `section` 放在尾部通知里（system 段
 *    保持恒定才有零缓存重建），压掉它就等于压掉整个计划模式指引；
 * 2. 老代/官方实现只认两个参数，多给的那个被静默忽略。两参调用在三种服务上都是
 *    正确行为，不需要按代次分支。
 *
 * 官方实现在「进入那一步」会把动态 `plan:policy` 段与 `exit_plan_mode` 一起塞进
 * 请求，那一步的前缀重建无法避免；fork 把 system 段摘掉、把 `exit_plan_mode` 无条件
 * 注册，于是这一行在 fork 上进入/离开都不再换来一次重建。这一行本身不参与那件事，
 * 只负责「进入」与「放弃」两个模型侧动作。
 *
 * ## 静态 `inject` 留空，注册等运行时的 `ctx.inject()`
 *
 * 静态 `inject` 与运行时 `ctx.inject()` 不是一回事：静态 `inject` 缺服务等于
 * **整行挂不上**（preset 解析失败），而这一行必须能挂在没装 agent-loop、也没有
 * 计划模式的宿主上；所以静态 `inject` 保持 `[]`，两个工具的注册改由 `apply()`
 * 里的 `ctx.inject(['planMode'], …)` 在服务到达时驱动。服务永不到达 = 安静地
 * 零注册，preset 里别的行照常挂载。
 *
 * ## 计划模式服务的多代形状
 *
 * `@deepseek-ai/dsh-plan-mode` 不在本包的依赖里（也不该在：用户装不装它不该由
 * 本包决定），所以**顶层不 import 它**，只按结构探测 `ctx.get('planMode')`：
 * `set(agent, active)` 从 0.2.x 起返回 `'committed' | 'queued' | 'cancelled' |
 * 'noop'`，更老或更新一代的返回值一律按字符串原样转述，不做断言。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/plan-mode-pipeline
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Loader 行名；preset 里的行 id 与模块说明符另由 preset 文件决定。 */
export const name = 'dsh-chatgpt-subscription-plan-mode-pipeline'

/**
 * 静态 `inject` 为空，这一行**不因缺服务而挂不上**。
 *
 * 空数组不等于「不等任何东西」：等 `planMode` 发生在 `apply()` 里的运行时
 * `ctx.inject(['planMode'], …)`，服务一到就注册两个工具，永不到达就零注册。
 * `tools`、`agents` 仍在调用时用 `ctx.get()` 探测。两者都不影响 preset 里其他行
 * 的挂载。
 */
export const inject: string[] = []

/** 进入计划模式的工具名。冻结契约的一部分，不要改动。 */
export const ENTER_PLAN_MODE_TOOL = 'enter_plan_mode'

/** 放弃规划（不交计划）的工具名。冻结契约的一部分，不要改动。 */
export const LEAVE_PLAN_MODE_TOOL = 'leave_plan_mode'

/**
 * 真正的审批出口。这一行只**提及**它，不注册、不替换、不代理。
 *
 * harness 的 plan-mode 服务自己把它按「本步是否处于计划模式」逐步准入（见
 * `packages/plan/plan-mode/src/index.ts`），这里再注册一份同名工具会让宿主
 * 启动直接失败。
 */
export const APPROVAL_EXIT_TOOL = 'exit_plan_mode'

/** 开关键名。冻结契约的一部分：profile、设置卡片与新入口共用这一个键。 */
export const SETTINGS_KEY = 'planModePipeline'

/** 这一行报错的错误码。 */
export type PlanModePipelineErrorCode =
  /** `exec.agent` 是 undefined：拿不到调用方，既读不了存活根也切不了模式。 */
  | 'CALLER_MISSING'
  /** 调用方不是这个 id 当前登记的那个存活 agent（会话已结束或已被替换）。 */
  | 'CALLER_NOT_LIVE'
  /** 调用方是子代理：决定要带回调度者，不能在这里自行进/出计划模式。 */
  | 'DELEGATED_CALLER'
  /** 计划模式服务在这一行**挂载之后**消失了（重载/拆除）。 */
  | 'PLAN_MODE_UNAVAILABLE'

/**
 * 这一行的结构化错误。
 *
 * 不 extends harness 的 `HarnessError`：那个基类在更老的代上不一定存在，而错误码
 * 只需要一个字符串字段就够调用方判断。
 */
export class PlanModePipelineError extends Error {
  /** 稳定错误码，供调度者/测试判断分支。 */
  readonly code: PlanModePipelineErrorCode

  /**
   * @param message - 给模型看的完整文案。
   * @param code - 稳定错误码。
   */
  constructor(message: string, code: PlanModePipelineErrorCode) {
    super(message)
    this.name = 'PlanModePipelineError'
    this.code = code
  }
}

// ── 开关 ────────────────────────────────────────────────────────────────────

/**
 * 开关递交槽位的 global symbol。
 *
 * 走 global symbol 而不是模块级变量，理由与本包 `host/progress-updates/index.ts`
 * 的单实例登记表相同：摆渡的两端是**两个 bundle 里的模块实例**（核心行
 * `lib/index.js` 与这一行 `lib/plan-mode-pipeline.js`），同一个包也可能被装上两份
 * （npm 拷贝 + 仓库 link）。模块级变量在"两份实例"下永远对接不上 —— 那时核心行写
 * 自己的副本、这一行读自己的副本，开关就静默失效；进程级登记表没有这个问题。
 */
const SETTINGS_SLOT = Symbol.for('dsh-chatgpt-subscription.plan-mode-pipeline.settings')

/**
 * 由核心入口在挂载时调用，把 `planModePipeline` 的读取面交给这一行。
 *
 * 幂等：重复递交以最后一次为准（核心行重挂时活引用会换一份新的）。
 * @param read - 每次调用都重读当前开关值（活引用：设置保存后下一步生效）。
 */
export function attachPlanModePipelineSettings(read: () => boolean): void {
  ;(globalThis as unknown as Record<symbol, unknown>)[SETTINGS_SLOT] = read
}

/**
 * 读当前挂着的读取面。
 * @returns 核心行递交过的读取函数；还没递交（或递交的不是函数）时 undefined。
 */
function attachedReader(): (() => boolean) | undefined {
  const candidate = (globalThis as unknown as Record<symbol, unknown>)[SETTINGS_SLOT]
  return typeof candidate === 'function' ? candidate as () => boolean : undefined
}

/**
 * 当前开关值，默认**开启**。
 *
 * 与「进展更新」行刻意不同的一点：那边在没有设置时**等**（用一个写死的默认值
 * 假装在跑会让「设置显示打开」与「实际没挂」同时成立）。这里不能等——这一行挂在
 * **preset** 里，按会话挂载；核心行若被用户单独关掉，等下去的结果是这一行静默地
 * 一个工具都不注册，而设置面板上根本不存在一个「关掉的开关」供人对账。所以缺设置
 * 时按默认值（开）工作。
 *
 * @returns 开关是否打开。
 */
export function readPlanModePipelineEnabled(): boolean {
  const read = attachedReader()
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    // 读设置本身出错不是「用户关了」：按默认值继续，别让一次读失败吃掉工具。
    return true
  }
}

/** 一个可能被 loader 解析成活引用（`{ get() }`）的配置字段。 */
interface ConfigRef<T> {
  /** 读取当前已提交的值。 */
  get(): T | undefined
}

/** 配置字段：活引用或普通值。 */
export type PlanModePipelineConfigField<T> = ConfigRef<T> | T | undefined

/** 核心行交给本模块的配置形状（只取本模块认识的那一个字段）。 */
export interface PlanModePipelineConfigFields {
  /** 计划模式管线总开关。 */
  planModePipeline?: PlanModePipelineConfigField<boolean>
}

/**
 * 把核心行的配置解析成开关值。
 *
 * 沿 volatile 活引用取当前值，所以设置保存后立刻生效。
 * @param config - 核心入口收到的插件配置（活引用或普通值）。
 * @returns 是否启用；缺省与非法值都按默认值（开）处理。
 */
export function resolvePlanModePipelineEnabled(config?: PlanModePipelineConfigFields): boolean {
  const field = config?.planModePipeline
  if (field === undefined || field === null) return true
  if (typeof field === 'object' && typeof (field as ConfigRef<boolean>).get === 'function') {
    return (field as ConfigRef<boolean>).get() !== false
  }
  return field !== false
}

// ── 多代结构探测 ────────────────────────────────────────────────────────────

/** 计划模式服务里本模块会读的部分（结构化类型，不绑定具体 SDK 版本）。 */
interface PlanModeControllerLike {
  /**
   * 选择是否处于计划模式。
   * @param agent - 会话所属 agent。
   * @param active - 目标状态。
   * @param options - 可选：`narrate: false` 表示调用方的工具结果已经把话说完了。
   *   官方实现与旧代只认前两个参数，多给的那个被 JS 静默忽略；本行**不传**它
   *   （理由见模块说明：fork 的尾部通知就是计划指引的投递口）。
   * @returns 0.2.x 起是 `'committed' | 'queued' | 'cancelled' | 'noop'`；别的代原样转述。
   */
  set(agent: unknown, active: boolean, options?: { narrate?: boolean }): unknown
  /**
   * 若服务支持，压制下一次尾部通知。
   *
   * 只作结构声明存在：本行刻意不调用它，因为那句通知带着部署指引（`section`），
   * 压掉它等于让模型拿不到计划模式手册。
   * @param session - 会话。
   */
  suppressNextNarration?(session: unknown): void
}

/** agent 登记里本模块会读的部分。 */
interface AgentsLookup {
  /** 按 id 查当前存活的 agent 对象。 */
  get?(id: string): unknown
  /** 顶层（存活根）agent。 */
  roots?(): readonly unknown[]
}

/** 一步的准入判定（只需要 agent）。 */
type ToolAdmissionWhen = (context: { readonly agent?: unknown }) => boolean

/**
 * 工具注册面。
 *
 * 第二参数的 `{ when }` 是**新代**才有的一步一准入开关（harness：
 * `ToolRegistrationOptions.when`）。已发布的 0.2.1-rc.3 的 `register` 只收一个
 * 参数，多给的那个被 JS 原样忽略——所以这里按结构类型调用：新代上开关逐步准入，
 * 老代上开关退化成 execute 里的同一次判定（见两个工具的实现）。
 */
interface ToolsRegistryLike {
  register(definition: ToolDefinition, options?: { when?: ToolAdmissionWhen }): () => void
}

/** 日志面（可选）。 */
interface LoggerLike {
  /** 提示级日志。 */
  info(message: string): void
}

/**
 * 调用时读一个可选服务。
 * @param ctx - 宿主上下文。
 * @param service - 服务名。
 * @returns 服务实例；不存在或读取抛错时 undefined。
 */
function serviceOf<T>(ctx: Context, service: string): T | undefined {
  const read = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof read !== 'function') return undefined
  try {
    return read.call(ctx, service) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 记一条 info 日志。日志服务缺席时安静跳过——这一行不该因为日志而失败。
 * @param ctx - 宿主上下文。
 * @param message - 日志正文。
 */
function logInfo(ctx: Context, message: string): void {
  const logger = (ctx as unknown as { logger?: LoggerLike }).logger
  try {
    logger?.info(message)
  } catch {
    // 日志失败不影响挂载。
  }
}

// ── 存活根校验 ──────────────────────────────────────────────────────────────

/** 调用方不是存活根的完整文案。 */
const NOT_LIVE_TEXT = 'plan mode control requires the exact live calling agent for this session; '
  + 'this session no longer owns the caller, so no plan was entered or left here'

/** 调用方是子代理时的完整文案（要求把未决决定带回调度者）。 */
const DELEGATED_TEXT = 'plan mode control is unavailable while the calling agent is owned by another live agent; '
  + 'include the unresolved question or decision in the child agent\'s final result for the dispatcher, '
  + 'and let the dispatcher enter or leave plan mode'

/**
 * 校验调用方是这个会话**现在的**那个存活根 agent，按宿主所能提供的信息**三级降级**：
 *
 * 1. `agents` 在、`agents.roots()` 可用 —— 全量校验（存活 + 根判定，照抄 harness 的
 *    `user-questions`）；确认不是根时抛 `DELEGATED_CALLER`，这是它**唯一**的抛出点。
 * 2. `agents` 在、`roots` 不可用（老代上未必有）—— 只判存活（`agents.get(id) === agent`）
 *    就放行：判不了根不等于确认是子代理，而 `planMode.set()` 本身不需要根身份。
 * 3. `agents` 服务缺失 —— 存活与根都无从判定，直接放行（同样不需要 agents）。
 *
 * 降级的代价：老代上识别不出子代理，子代理可能自己进入它自己的计划模式；那边没有
 * `exit_plan_mode` 审批出口可用，所以这是可接受的降级，好过让切换在整个老代上永久失败。
 * @param ctx - 宿主上下文。
 * @param agent - `exec.agent`。
 * @throws {PlanModePipelineError} `CALLER_MISSING` / `CALLER_NOT_LIVE` / `DELEGATED_CALLER`。
 */
function assertLiveRoot(ctx: Context, agent: unknown): void {
  if (agent === undefined || agent === null) {
    throw new PlanModePipelineError(
      'plan mode control needs a calling agent, but this call carries none; '
      + 'a plan is entered and left by the dispatcher that owns the session',
      'CALLER_MISSING',
    )
  }
  const agents = serviceOf<AgentsLookup>(ctx, 'agents')
  // 第三级：没有 agents 服务，存活与根都判不了 —— 放行。
  if (agents === undefined) return
  const id = (agent as { id?: unknown }).id
  let current: unknown
  try {
    current = typeof id === 'string' ? agents.get?.(id) : undefined
  } catch {
    current = undefined
  }
  if (current !== agent) {
    throw new PlanModePipelineError(NOT_LIVE_TEXT, 'CALLER_NOT_LIVE')
  }
  let roots: readonly unknown[] | undefined
  if (typeof agents.roots === 'function') {
    try {
      roots = agents.roots.call(agents)
    } catch {
      roots = undefined
    }
  }
  // 第二级：有 agents 但 roots 不可用（老代）—— 只判存活，判不了根就放行。
  if (!Array.isArray(roots)) return
  // 第一级：roots 可用且确实不含该 agent —— 这是 DELEGATED_CALLER 唯一的抛出点。
  if (!roots.includes(agent)) {
    throw new PlanModePipelineError(DELEGATED_TEXT, 'DELEGATED_CALLER')
  }
}

// ── 工具文案 ────────────────────────────────────────────────────────────────

/**
 * `enter_plan_mode` 的模型侧描述。
 *
 * **刻意压到 380 字符以内。** 工具描述与 system 段一样，每一步都随请求重发，是计划
 * 模式期间**每一步都在付**的常驻开销（Kimi 线路按内容前缀命中，进入计划模式那一步
 * 工具表一变，前缀必然重建一次；但重建之后，每一步还要为这些字节付输入费）。所以
 * 这里只留「能不能调用」的四条判定：只有调度模式用；只有 L2 且 R-G 访谈收敛后才可
 * 调用；进入这一步**只完成进入**；L0/L1 或访谈未收敛时不得调用。
 *
 * 探索纪律、决策完备清单、`exit_plan_mode` 唯一最后调用、打回循环都搬到
 * `enterResultText()` 的工具返回里：工具结果是**末尾追加**，不破坏前缀，且比描述便宜。
 */
export const ENTER_DESCRIPTION = 'Enter plan mode for the rest of this session. '
  + 'Dispatch mode only: call it only once the task is triaged L2 and the R-G interview has converged '
  + '(frontier empty, user confirmed shared understanding). '
  + 'This step completes only the entry; exploring and writing the plan happen in your next step. '
  + 'Never call it for L0/L1 or while a frontier question is open.'

/**
 * `leave_plan_mode` 的模型侧描述。
 *
 * 同样压短（≤ 220 字符），只留两条别人替代不了的：它不是审批出口（审批出口是官方的
 * `exit_plan_mode`）；只在用户**明确**表示不做计划时用。
 */
export const LEAVE_DESCRIPTION = 'Leave plan mode without submitting a plan. '
  + 'Dispatch mode only: use it only when the user explicitly says no plan is wanted. '
  + 'It is NOT the approval exit—exit_plan_mode is; leaving approves nothing.'

/** 一次切换的结果，canonical JSON（冻结契约的一部分）。 */
export interface PlanModeTransitionResult {
  /** 切换之后模型是否处于计划模式（`disabled` 时是 false）。 */
  active: boolean
  /** 服务报告的动作，或这一行的 `disabled`。 */
  transition: string
}

/** 开关关着时 execute 返回的标记。 */
const DISABLED_TRANSITION = 'disabled'

/**
 * 把 `ctx.planMode.set()` 的返回值规整成字符串。
 * @param value - 服务返回值。
 * @returns 字符串动作；非字符串时按 `unknown` 转述。
 */
function transitionText(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'unknown'
}

/**
 * 当前计划模式服务；缺了就是 undefined（老宿主、或这一行挂载后被拆除）。
 * @param ctx - 宿主上下文。
 * @returns 服务实例或 undefined。
 */
function planModeOf(ctx: Context): PlanModeControllerLike | undefined {
  return serviceOf<PlanModeControllerLike>(ctx, 'planMode')
}

/**
 * 取一次计划模式服务，缺了就报可执行的错。
 * @param ctx - 宿主上下文。
 * @returns 服务实例。
 * @throws {PlanModePipelineError} `PLAN_MODE_UNAVAILABLE`。
 */
function requirePlanMode(ctx: Context): PlanModeControllerLike {
  const controller = planModeOf(ctx)
  if (controller === undefined) {
    throw new PlanModePipelineError(
      'the plan-mode service left this session after the pipeline mounted; '
      + 'ask the user to restart the session and present the plan through exit_plan_mode instead',
      'PLAN_MODE_UNAVAILABLE',
    )
  }
  return controller
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

/** 注入回调：cordis 在依赖服务到齐后调用它，服务变化时拆掉重跑。 */
type InjectCallback = (scope: Context) => void

/**
 * 等一组服务到达，到齐后调一次 `onArrive`。
 *
 * 老代 cordis 上 `ctx.inject` 不一定存在；不是函数时返回 false，由调用方退化回
 * 「apply 时探测一次」。回调拿到的 scope 这里**故意不用**：注册挂在行自己的 ctx
 * 上，这样服务在这之后消失时两个工具仍在，调用时报 `PLAN_MODE_UNAVAILABLE`，
 * 而不是变成「未知工具」。
 * @param ctx - 宿主上下文。
 * @param services - 要等的服务名。
 * @param onArrive - 服务到齐后调用一次。
 * @returns 是否订上了注入。
 */
function whenServicesArrive(ctx: Context, services: string[], onArrive: () => void): boolean {
  const inject = (ctx as unknown as { inject?: unknown }).inject
  if (typeof inject !== 'function') return false
  ;(inject as (deps: string[], callback: InjectCallback) => unknown)
    .call(ctx, services, () => { onArrive() })
  return true
}

/**
 * 挂载「计划模式管线」这一行。
 *
 * 注册**由服务到达驱动**：`ctx.inject(['planMode'], …)` 在计划模式服务可用时调
 * `registerTools`。服务永不到达（老代 harness、或部署方没在这一行所在组里装
 * plan-mode）时零注册、不抛错，preset 照常挂载。
 *
 * ## 为什么不是「apply 时探测一次」
 *
 * cordis 里**行序 ≠ apply 顺序**：本行静态 `inject` 为空，会被立即 apply；同组里
 * 排在它前面的 plan-mode 行要等 tools/systemPrompt/sessionProjections/agents 到齐
 * 才 apply。于是「apply 时探测一次」总是先跑，`ctx.get('planMode')` 必然 undefined，
 * 零注册看起来像降级成功，实际是把两个工具永久摘掉了。改成等服务到达再注册后，
 * 两行谁先挂都不影响。
 * @param ctx - 这一行自己的上下文（agent plane：每个会话一份）。
 */
export function apply(ctx: Context): void {
  /** 已注册就不再注册：依赖服务变化时 cordis 会拆掉注入回调再跑一遍。 */
  let mounted = false

  /** 服务到达后（以及老代 fallback 里）执行的挂载主体。 */
  const mount = (): void => {
    if (mounted) return
    // 先记「已到过」：重复 register 同名工具会让宿主启动/重载失败。
    mounted = true
    registerTools(ctx)
  }

  if (whenServicesArrive(ctx, ['planMode'], mount)) {
    // 服务永不出现的老代宿主也走这条路：什么都不注册，只留一条能对账的日志。
    // 延到微任务再读一次，避免把「回调刚订上、下一拍就到」误报成「在等」。
    void Promise.resolve().then(() => {
      if (mounted || planModeOf(ctx) !== undefined) return
      logInfo(ctx, '[dsh-chatgpt-subscription] plan-mode pipeline waiting for the planMode service: '
        + 'enter_plan_mode/leave_plan_mode are registered once it arrives')
    })
    return
  }

  // 老代 cordis 没有 ctx.inject：退回 apply 时探测一次（服务若在这之后才到，
  // 本行就赶不上了——与改动前的行为一致）。
  if (planModeOf(ctx) === undefined) {
    // 老代 harness 没有计划模式，或部署方没在这一行所在组里装 plan-mode：
    // 安静降级，绝不抛错——preset 里别的行还要挂。
    logInfo(ctx, '[dsh-chatgpt-subscription] plan-mode pipeline inactive: this host exposes no planMode service, '
      + 'so enter_plan_mode/leave_plan_mode were not registered')
    return
  }
  mount()
}

/**
 * 注册两个工具，只在计划模式服务确认可用后调用一次。
 *
 * 缺 `tools` 时零注册 + 一条 info 日志：注册面本身缺席时什么都不做，preset 照常挂载。
 * @param ctx - 这一行自己的上下文。
 */
function registerTools(ctx: Context): void {
  const tools = serviceOf<ToolsRegistryLike>(ctx, 'tools')
  if (tools === undefined) {
    logInfo(ctx, '[dsh-chatgpt-subscription] plan-mode pipeline inactive: this host exposes no tools service, '
      + 'so enter_plan_mode/leave_plan_mode were not registered')
    return
  }

  /**
   * 逐步准入判定：开关关着就不把这个工具放进这一步的声明里。
   *
   * 新代 harness 会按这一步调用它；老代的 `register` 忽略第二个参数，那时开关由
   * 两个 execute 里的同一次判定兜住（见 `readPlanModePipelineEnabled()`）。
   */
  const admission: ToolAdmissionWhen = () => readPlanModePipelineEnabled()

  /**
   * 把一个工具登记进 tools 服务，并让它在整行卸载时自动注销。
   * @param definition - 工具定义。
   */
  const register = (definition: ToolDefinition): void => {
    ctx.effect(
      () => tools.register(definition, { when: admission }),
      'dsh-chatgpt-subscription: ' + definition.name + ' tool',
    )
  }

  register(defineTool({
    name: ENTER_PLAN_MODE_TOOL,
    description: ENTER_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true, description: 'Whether plan mode is now in effect for this session.' },
          transition: {
            type: 'string',
            required: true,
            description: 'What the plan-mode service reported (committed, queued, cancelled, noop), or disabled when the pipeline switch is off.',
          },
        },
      },
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: enterResultText(value as PlanModeTransitionResult) }]
      },
    },
    async execute(_args, exec): Promise<PlanModeTransitionResult> {
      if (!readPlanModePipelineEnabled()) return { active: false, transition: DISABLED_TRANSITION }
      const agent = exec.agent
      assertLiveRoot(ctx, agent)
      // 两参调用：第三个参数（{ narrate: false }）会压掉 fork 那条承载 section 的
      // 尾部通知，而官方实现与旧代只认两个参数。见模块说明「与 fork 的协调」。
      const transition = transitionText(requirePlanMode(ctx).set(agent, true))
      // 这四个动作都意味着「目标状态已经达到」：对模型来说只差一句说明，不是失败。
      const active = transition === 'committed' || transition === 'queued'
        || transition === 'cancelled' || transition === 'noop'
      return { active, transition }
    },
  }))

  register(defineTool({
    name: LEAVE_PLAN_MODE_TOOL,
    description: LEAVE_DESCRIPTION,
    parameters: {
      reason: {
        type: 'string',
        description: 'Optional short note on why planning is abandoned (for example "the user dropped the task"). It is recorded with this call; do not put a plan here.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true, description: 'Whether plan mode is still in effect (normally false).' },
          transition: {
            type: 'string',
            required: true,
            description: 'What the plan-mode service reported (committed, queued, cancelled, noop), or disabled when the pipeline switch is off.',
          },
        },
      },
      render(_args, value): ContentBlock[] {
        return [{ type: 'text', text: leaveResultText(value as PlanModeTransitionResult) }]
      },
    },
    async execute(_args, exec): Promise<PlanModeTransitionResult> {
      if (!readPlanModePipelineEnabled()) return { active: false, transition: DISABLED_TRANSITION }
      const agent = exec.agent
      assertLiveRoot(ctx, agent)
      // 同样两参调用：离开方向的尾部通知不携带 section，但保持与进入方向一致的
      // 调用形状，老代服务上也不会因为多一个参数而行为不明。
      const transition = transitionText(requirePlanMode(ctx).set(agent, false))
      return { active: false, transition }
    },
  }))
}

// ── 返回给模型的正文 ────────────────────────────────────────────────────────

/**
 * `enter_plan_mode` 返回给模型的正文——计划模式期间**详细指引的唯一常驻落点**。
 *
 * 为什么搬到这里：工具描述与 system 段每一步都随请求重发，而工具结果是**末尾追加**，
 * 不改变已发前缀。所以探索纪律、决策完备清单、`exit_plan_mode` 作为该轮唯一且最后
 * 的调用、打回循环、批准前不实施，全部放在这里——进入之后的每一步都还看得到它，
 * 而代价只付一次。
 *
 * 体量上限由 test/plan-mode-pipeline.test.ts 断言：正常分支正文 ≤ 1400 字符。
 * @param result - 切换结果。
 * @returns 模型看到的文本。
 */
export function enterResultText(result: PlanModeTransitionResult): string {
  if (result.transition === DISABLED_TRANSITION) {
    return 'The plan-mode pipeline is disabled in this session (the planModePipeline switch is off), so plan mode was not entered. '
      + 'Ask the user to enable it, or plan without plan mode.'
  }
  const head = result.transition === 'committed' || result.transition === 'queued'
    ? 'Plan mode entry recorded (' + result.transition + ').'
    : 'Plan mode was already in effect (' + result.transition + '); nothing changed in this step.'
  return head
    + ' This step only completes the entry: do not explore, plan, dispatch, or implement anything else now.'
    + ' From your NEXT step, inside Plan Mode:'
    + ' (1) explore read-only — reads, searches and static checks only, preferring existing functions and patterns;'
    + ' never edit or write files, mutate config, or run formatters, codegen or any command that rewrites tracked files;'
    + ' dispatch read-only subagents only on routes returned by list_subagent_models (R2).'
    + ' (2) write a decision-complete plan: goal and success criteria; changes grouped by subsystem;'
    + ' public API, schema and data-flow changes; boundaries and failure modes; test strategy;'
    + ' acceptance criteria; explicit assumptions — enough that an executor needs no further design decisions.'
    + ' (3) submit it with ' + APPROVAL_EXIT_TOOL + ' as the sole and final tool call of that turn;'
    + ' never paste the plan into a chat reply and never ask "should I proceed?" in prose or via ask_user_question.'
    + ' If the plan is rejected, fold the feedback in and submit it again via ' + APPROVAL_EXIT_TOOL
    + ': a rejection keeps you in Plan Mode, it is not an exit.'
    + ' ' + APPROVAL_EXIT_TOOL + ' is the only approval exit: implement nothing and dispatch nothing before approval,'
    + ' and ' + LEAVE_PLAN_MODE_TOOL + ' abandons planning without approving anything.'
}

/**
 * `leave_plan_mode` 返回给模型的正文。
 * @param result - 切换结果。
 * @returns 模型看到的文本。
 */
export function leaveResultText(result: PlanModeTransitionResult): string {
  if (result.transition === DISABLED_TRANSITION) {
    return 'The plan-mode pipeline is disabled in this session (the planModePipeline switch is off), so plan mode was not left. '
      + 'Ask the user to enable it if you need to leave plan mode explicitly.'
  }
  return 'Left plan mode without submitting a plan (' + result.transition + '). '
    + 'Nothing was reviewed or approved: this is the abandon path, not the approval exit. '
    + APPROVAL_EXIT_TOOL + ' is the only way to present a plan and leave plan mode; '
    + 'if you still intend to plan, re-enter with ' + ENTER_PLAN_MODE_TOOL + ' and submit the plan through ' + APPROVAL_EXIT_TOOL + '.'
}
