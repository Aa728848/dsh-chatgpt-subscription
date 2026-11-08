/**
 * 「调度账本」：把**持久会话日志**折成一份可审计的派发账本。
 *
 * ## 它折的是什么
 *
 * 账本不写任何新事件（会话事件类型是封闭词表，加一种新类型会让旧读者拒绝
 * 重建整个会话），它只是**折叠**已经存在的事件：
 *
 * - `tool/call`（原生调用）与 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`
 *   （PTC 模式）——一次**派发尝试**；
 * - `tool/result` / `tool/ptc-dispatch`——同一次尝试的**结局**；
 * - `agent/inbox/spliced`——子代理**报告**落到 owner 会话。
 *
 * ## 命名空间占用
 *
 * 命名空间 = (brief_id, run_id, idem)。它由**第一次真正执行（或确实派发出去）**
 * 的尝试占用，此后**不可复用**——不管那次运行后来是完成了还是被释放了。
 * `released` 只解禁 **brief**（同一个工作项可以开新的一次运行），不解禁命名空间。
 * 所以重做一件事要换新的 `run_id` 与新的 `idem`。
 *
 * **例外：派发前就被拒的尝试不占用命名空间。** 判据是 {@link classifyToolOutcome}
 * 能证明这次调用根本没有落地——账本自己的 `DISPATCH_LEDGER_V2:` 拒绝，以及本插件
 * 模型选择守卫的 `subagent model selection:` 拒绝。它们把运行置为 `denied`，
 * 而 `denied` 的运行允许同一命名空间再收一次修正后的尝试：否则"第一次调用形状
 * 写错了"会永久烧掉这个命名空间，模型改对之后必然撞 `MANDATE_DUPLICATE`，
 * 一步错误变成一整轮派不出去（`session-9e27d9f1` 实测四次尝试全部落空）。
 *
 * ## attempt 层与聚合
 *
 * 一次尝试的结局可能丢失（崩溃、宿主没写、留存策略），所以状态不是挂在
 * "这次派发"上，而是挂在**一组 attempt**上：
 *
 * - `succeeded` > 0 → booked（子代理真的建起来了）
 * - 否则 `unknown` > 0 → booked 且**未结算**（绝不自动释放）
 * - 否则 `tool_error` > 0 → released（派发本身失败）
 * - 否则全是 `guard_denied` → denied（从未派发出去）
 *
 * **`guard_denied` 不参与"释放"判定**。这就是"第二次并行调用被守卫拒掉"不会
 * 把第一次仍在 booked 的运行释放掉的原因；只有**全部**尝试都是被守卫拒的
 * （`denied`）才说明这个运行从未派发出去。
 *
 * 展示的 attempt 列表最多 {@link MAX_ATTEMPTS_SHOWN} 条，但**聚合计数另存**
 * 在 `attemptTotals` 里——截断展示不会改变状态。
 *
 * ## 保守方向
 *
 * 读不出来的状态一律往"仍被占用"上取：结局丢失 → unknown → 键继续占着，
 * 同命名空间重派被拒。这条规则让**重启**不需要任何特殊处理：重启前后看见的
 * 是同一份日志，判定自然一致。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/ledger
 */

import { z } from 'zod'
import {
  mandateNamespaceKey,
  mandateNamespaceKeyOf,
  parseMandateHeader,
  type MandateHeader,
} from './header.ts'
import { sha256Hex } from './policy.ts'
import {
  catalogChildrenOfSession,
  heldMandatesOfSession,
  mandateFromContent,
  parentSessionIdOfSession,
  sessionIdOf,
  textBlocksOf,
  type SessionLike,
} from './binding.ts'

/** 折叠状态的持久化版本。字段结构或折叠语义一变就 +1。 */
export const DISPATCH_LEDGER_STATE_VERSION = 2

/** 一个会话里最多保留多少条运行记录。 */
export const MAX_RUNS_PER_SESSION = 256

/** 一个会话里最多保留多少个工作项。 */
export const MAX_BRIEFS_PER_SESSION = 64

/** 展示用的 attempt 上限（聚合计数不受它影响）。 */
export const MAX_ATTEMPTS_SHOWN = 8

/** 一条运行保留的历史状态上限。 */
export const MAX_RELEASED_HISTORY = 4

/** 尚未结算的 attempt 上限（同时在飞的派发）。 */
export const MAX_PENDING_ATTEMPTS = 512

/** 默认承认的派发工具名。 */
export const DEFAULT_DISPATCH_TOOLS: readonly string[] = ['subagent', 'subagent_fork']

/** 守卫拒绝文案的统一前缀。 */
export const DISPATCH_GUARD_DENIAL_PREFIX = 'DISPATCH_LEDGER_V2'

/**
 * 模型选择守卫（{@link ../subagent-model-authorization.ts}）那族拒绝的文案前缀。
 *
 * 那族守卫在派发**之前**就拒（{@link ../subagent-model-authorization.ts} 的
 * `inheritOverrideReason` 等理由全部以这句开头），所以它和账本自己的拒绝一样，
 * 证明这次调用从未落地。识别它，运行才会落到 `denied`，被拒的命名空间才有
 * 机会接收修正后的重试。
 */
export const SUBAGENT_SELECTION_DENIAL_PREFIX = 'subagent model selection:'

/** 模型选择守卫拒绝时记下的拒绝码。 */
export const SUBAGENT_SELECTION_DENIAL_CODE = 'SUBAGENT_MODEL_SELECTION'

/** 一次尝试的结局。 */
export type AttemptOutcome = 'succeeded' | 'tool_error' | 'guard_denied' | 'unknown'

/** 一条运行的状态。 */
export type RunState = 'booked' | 'completed' | 'blocked' | 'released' | 'denied'

/** 运行被释放的原因。 */
export type RunRelease = 'hand_back' | 'failed' | 'dropped' | 'dispatch_failed'

/** 一次派发尝试。 */
export interface LedgerAttempt {
  /** 调用 id：原生是 `tool/call.callId`，PTC 是 `subCallId`。 */
  readonly callId: string
  /** 命名空间键。 */
  readonly ns: string
  /** 尝试事件在日志里的序号。 */
  readonly seq: number
  /** 尝试事件的时刻（Unix 毫秒）。 */
  readonly at: number
  /** 派发工具名。 */
  readonly tool: string
  /** 结局。 */
  readonly outcome: AttemptOutcome
  /** 守卫拒绝码（仅 `guard_denied`）。 */
  readonly denialCode?: string
}

/** 聚合计数：不受展示列表截断影响。 */
export interface AttemptTotals {
  /** 尝试总数。 */
  total: number
  /** 成功数。 */
  succeeded: number
  /** 未结算数。 */
  unknown: number
  /** 一般失败数。 */
  toolError: number
  /** 被守卫拒绝数。 */
  guardDenied: number
}

/** 一次运行（= 一个命名空间）的账本记录。 */
export interface LedgerRun {
  /** 命名空间键。 */
  readonly ns: string
  /** 工作项 id。 */
  readonly brief_id: string
  /** 运行 id。 */
  readonly run_id: string
  /** 幂等键。 */
  readonly idem: string
  /** 授权快照版本。 */
  readonly mandate_version: number
  /** 提示词修订号。 */
  readonly prompt_ref: string
  /** 策略引用。 */
  readonly policy: { readonly id: string; readonly version: string; readonly sha256: string }
  /** 原始任务的引用（不是正文）。 */
  readonly task: readonly string[]
  /** 结构化边界。 */
  readonly boundary: readonly string[]
  /** 允许的后续上下文。 */
  readonly followup: readonly string[]
  /** 正文 sha256：由**插件**按围栏之后的正文算出，模型无法提供或伪造。 */
  readonly body_sha256: string
  /** 派发工具名。 */
  readonly tool: string
  /** 第一次尝试的序号。 */
  readonly seq: number
  /** 第一次尝试的时刻。 */
  readonly at: number
  /** 运行状态。 */
  readonly state: RunState
  /** 释放原因。 */
  readonly release?: RunRelease
  /** 展示用的 attempt 列表。 */
  readonly attempts: readonly LedgerAttempt[]
  /** attempt 聚合计数。 */
  readonly attemptTotals: AttemptTotals
  /** 占用这个命名空间的第一次尝试的 callId。 */
  readonly createdByCallId: string
  /** 收到的报告。 */
  readonly report?: { readonly status: string; readonly seq: number; readonly at: number }
  /** 血缘：本次接替的那一次运行的命名空间。 */
  readonly parent_run?: string
  /** 历史状态。 */
  readonly releasedHistory: readonly {
    readonly state: RunState
    readonly release?: RunRelease
    readonly seq: number
    readonly at: number
  }[]
}

/** 一个工作项的状态。 */
export interface BriefState {
  /** 工作项 id。 */
  readonly brief_id: string
  /** occupied（有未了结的运行）/ closed（有已交付的运行）/ free（可开新运行）。 */
  readonly state: 'occupied' | 'closed' | 'free'
  /** 最新一次运行的命名空间。 */
  readonly latestRun?: string
  /** 最新一次运行的序号（内部排序用）。 */
  readonly latestSeq: number
}

/** 一个子代理与它持有的 Mandate 的绑定。 */
export interface ChildBinding {
  /** 命名空间键。 */
  readonly ns: string
  /** 工作项 id。 */
  readonly brief_id: string
  /** 运行 id。 */
  readonly run_id: string
  /** 幂等键。 */
  readonly idem: string
  /** 授权快照版本。 */
  readonly mandate_version: number
  /** 提示词修订号。 */
  readonly prompt_ref: string
  /** 绑定的时刻。 */
  readonly at: number
}

/** 账本计数器。 */
export interface DispatchLedgerCounters {
  /** 没有头部的派发尝试。 */
  unmandated: number
  /** 头部损坏或角色不匹配。 */
  malformed: number
  /** 同命名空间的重复尝试（在派发前被拒的运行上重试不算重复）。 */
  duplicates: number
  /** 同工作项被另一个未了结的运行占用。 */
  briefBusy: number
  /** 策略快照过期（由守卫记账）。 */
  policyStale: number
  /** 找不到对应运行的报告。 */
  orphanReports: number
  /** 持有绑定不成立（由守卫记账）。 */
  notHeld: number
}

/** 容量快照：账本还能不能接下**一次新的派发**。 */
export interface DispatchLedgerCapacity {
  /** 已记录的运行数。 */
  readonly runs: number
  /** 已记录的工作项数。 */
  readonly briefs: number
  /** 运行数是否已达上限。 */
  readonly runsFull: boolean
  /** 工作项数是否已达上限。 */
  readonly briefsFull: boolean
  /**
   * 一次新的派发是否会被容量挡住。
   *
   * 挡住的两种情况：运行总数已满；或者工作项数已满而这次要**新建**一个工作项
   * （同一个工作项再开一次运行不占新的工作项名额）。
   */
  readonly full: boolean
  /** 指定工作项的情况（给了工作项 id 时有）。 */
  readonly brief?: {
    /** 工作项 id。 */
    readonly brief_id: string
    /** 该工作项下的运行数。 */
    readonly runs: number
    /** 该工作项的状态。 */
    readonly state: BriefState['state']
  }
}

/** 折叠出来的账本状态。 */
export interface DispatchLedgerState {
  /** 状态版本。 */
  readonly ledger: number
  /** 运行记录，按命名空间键索引。 */
  readonly runs: Readonly<Record<string, LedgerRun>>
  /** 工作项状态。 */
  readonly briefs: Readonly<Record<string, BriefState>>
  /** 子代理绑定。 */
  readonly children: Readonly<Record<string, ChildBinding>>
  /** 尚未结算的 attempt：callId → 命名空间。 */
  readonly pending: Readonly<Record<string, string>>
  /** 计数器。 */
  readonly counters: DispatchLedgerCounters
}

/** 折叠读到的一条会话事件。 */
export interface DispatchLedgerEventLike {
  /** 事件类型。 */
  readonly type?: unknown
  /** 事件序号。 */
  readonly seq?: unknown
  /** 事件时刻。 */
  readonly time?: unknown
  /** 事件载荷。 */
  readonly data?: unknown
}

/** 折叠选项。 */
export interface DispatchLedgerFoldOptions {
  /** 视为"派发"的工具名。 */
  readonly dispatchTools?: readonly string[]
}

const ATTEMPT_SCHEMA = z.strictObject({
  callId: z.string(),
  ns: z.string(),
  seq: z.number(),
  at: z.number(),
  tool: z.string(),
  outcome: z.enum(['succeeded', 'tool_error', 'guard_denied', 'unknown']),
  denialCode: z.string().optional(),
})

const TOTALS_SCHEMA = z.strictObject({
  total: z.number(),
  succeeded: z.number(),
  unknown: z.number(),
  toolError: z.number(),
  guardDenied: z.number(),
})

const POLICY_REF_SCHEMA = z.strictObject({
  id: z.string(),
  version: z.string(),
  sha256: z.string(),
})

const RUN_SCHEMA = z.strictObject({
  ns: z.string(),
  brief_id: z.string(),
  run_id: z.string(),
  idem: z.string(),
  mandate_version: z.number(),
  prompt_ref: z.string(),
  policy: POLICY_REF_SCHEMA,
  task: z.array(z.string()),
  boundary: z.array(z.string()),
  followup: z.array(z.string()),
  body_sha256: z.string().optional(),
  tool: z.string(),
  seq: z.number(),
  at: z.number(),
  state: z.enum(['booked', 'completed', 'blocked', 'released', 'denied']),
  release: z.enum(['hand_back', 'failed', 'dropped', 'dispatch_failed']).optional(),
  attempts: z.array(ATTEMPT_SCHEMA),
  attemptTotals: TOTALS_SCHEMA,
  createdByCallId: z.string(),
  report: z.strictObject({ status: z.string(), seq: z.number(), at: z.number() }).optional(),
  parent_run: z.string().optional(),
  releasedHistory: z.array(z.strictObject({
    state: z.enum(['booked', 'completed', 'blocked', 'released', 'denied']),
    release: z.enum(['hand_back', 'failed', 'dropped', 'dispatch_failed']).optional(),
    seq: z.number(),
    at: z.number(),
  })),
})

const BRIEF_SCHEMA = z.strictObject({
  brief_id: z.string(),
  state: z.enum(['occupied', 'closed', 'free']),
  latestRun: z.string().optional(),
  latestSeq: z.number(),
})

const CHILD_SCHEMA = z.strictObject({
  ns: z.string(),
  brief_id: z.string(),
  run_id: z.string(),
  idem: z.string(),
  mandate_version: z.number(),
  prompt_ref: z.string(),
  at: z.number(),
})

const COUNTERS_SCHEMA = z.strictObject({
  unmandated: z.number(),
  malformed: z.number(),
  duplicates: z.number(),
  briefBusy: z.number(),
  policyStale: z.number(),
  orphanReports: z.number(),
  notHeld: z.number(),
})

/** 折叠状态的 schema（宿主状态）。 */
export const dispatchLedgerStateSchema = z.strictObject({
  ledger: z.literal(DISPATCH_LEDGER_STATE_VERSION),
  runs: z.record(z.string(), RUN_SCHEMA),
  briefs: z.record(z.string(), BRIEF_SCHEMA),
  children: z.record(z.string(), CHILD_SCHEMA),
  pending: z.record(z.string(), z.string()),
  counters: COUNTERS_SCHEMA,
})

/**
 * 判断一个值是不是普通记录对象。
 * @param value - 候选值。
 * @returns 是记录对象时 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一个值里的非空字符串。
 * @param value - 候选值。
 * @returns 字符串；其它类型为 undefined。
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读一条运行记录。
 *
 * 用 `Object.hasOwn` 而不是直接索引再比 `undefined`：索引签名给出的是
 * `LedgerRun`（不是 `LedgerRun | undefined`），直接比较会被类型检查判成
 * 永假。
 * @param runs - 运行记录表。
 * @param ns - 命名空间键。
 * @returns 运行记录；没有时 undefined。
 */
function lookupRun(
  runs: Readonly<Record<string, LedgerRun>>,
  ns: string,
): LedgerRun | undefined {
  return Object.hasOwn(runs, ns) ? runs[ns] : undefined
}

/**
 * 读一条未结算 attempt 的归属。
 * @param pending - 未结算表。
 * @param callId - 调用 id。
 * @returns 命名空间键；没有时 undefined。
 */
function lookupPending(
  pending: Readonly<Record<string, string>>,
  callId: string,
): string | undefined {
  return Object.hasOwn(pending, callId) ? pending[callId] : undefined
}

/**
 * 读一个工作项的状态。
 * @param briefs - 工作项表。
 * @param brief_id - 工作项 id。
 * @returns 工作项状态；没有时 undefined。
 */
function lookupBrief(
  briefs: Readonly<Record<string, BriefState>>,
  brief_id: string,
): BriefState | undefined {
  return Object.hasOwn(briefs, brief_id) ? briefs[brief_id] : undefined
}

/**
 * 读一个事件序号。
 * @param event - 事件。
 * @returns 序号；不是有限数字时 0。
 */
function seqOf(event: DispatchLedgerEventLike): number {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0
}

/**
 * 读一个事件时刻。
 * @param event - 事件。
 * @returns 时刻；不是有限数字时 0。
 */
function atOf(event: DispatchLedgerEventLike): number {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
}

/**
 * 造一份空账本。
 * @returns 空状态。
 */
export function initialDispatchLedgerState(): DispatchLedgerState {
  return {
    ledger: DISPATCH_LEDGER_STATE_VERSION,
    runs: {},
    briefs: {},
    children: {},
    pending: {},
    counters: {
      unmandated: 0,
      malformed: 0,
      duplicates: 0,
      briefBusy: 0,
      policyStale: 0,
      orphanReports: 0,
      notHeld: 0,
    },
  }
}

/**
 * 给一个计数器加一。
 * @param state - 当前状态。
 * @param key - 计数器名。
 * @returns 新状态。
 */
function withCounter(state: DispatchLedgerState, key: keyof DispatchLedgerCounters): DispatchLedgerState {
  return { ...state, counters: { ...state.counters, [key]: state.counters[key] + 1 } }
}

/**
 * 裁剪展示用的 attempt 列表：保留最早的一条与最近的几条。
 *
 * **聚合不看这个列表**（看 `attemptTotals`），所以裁剪不会改变状态。
 * @param attempts - 全部 attempt。
 * @returns 裁剪后的列表。
 */
export function trimAttempts(attempts: readonly LedgerAttempt[]): LedgerAttempt[] {
  if (attempts.length <= MAX_ATTEMPTS_SHOWN) return [...attempts]
  const first = attempts[0]
  const recent = attempts.slice(attempts.length - (MAX_ATTEMPTS_SHOWN - 1))
  return [first, ...recent]
}

/**
 * 裁剪历史状态列表。
 * @param history - 全部历史。
 * @returns 最近的几条。
 */
export function trimReleasedHistory(
  history: readonly { state: RunState; release?: RunRelease; seq: number; at: number }[],
): { state: RunState; release?: RunRelease; seq: number; at: number }[] {
  if (history.length <= MAX_RELEASED_HISTORY) return [...history]
  return history.slice(history.length - MAX_RELEASED_HISTORY)
}

/**
 * 算出一次尝试的结局。
 *
 * 守卫的拒绝文案统一前缀 `DISPATCH_LEDGER_V2:<CODE>`，宿主把它包成
 * `Error: <reason>`（原生走 `tool/result` 的 message.content，PTC 走
 * `tool/ptc-dispatch` 的 content）——所以内容文本是跨代次宿主都可用的判据。
 * @param isError - 结果是否失败。
 * @param content - 结果内容块。
 * @returns 结局与（可选的）拒绝码。
 */
export function classifyToolOutcome(
  isError: boolean,
  content: unknown,
): { outcome: AttemptOutcome; denialCode?: string } {
  if (isError !== true) return { outcome: 'succeeded' }
  const denialCode = detectGuardDenialCode(content)
  if (denialCode !== undefined) return { outcome: 'guard_denied', denialCode }
  return { outcome: 'tool_error' }
}

/**
 * 从一段结果内容里读出守卫拒绝码。
 * @param content - 结果内容块。
 * @returns 拒绝码；不是守卫拒绝时 undefined。
 */
export function detectGuardDenialCode(content: unknown): string | undefined {
  const texts = textBlocksOf(content)
  if (texts.length === 0) return undefined
  const joined = texts.join('\n').trim()
  const match = new RegExp('^(?:Error:\\s*)?' + DISPATCH_GUARD_DENIAL_PREFIX + ':([A-Z_]+)').exec(joined)
  if (match?.[1] !== undefined) return match[1]
  // 本插件另一族「派发前就拒」的守卫：模型选择。它的每一条理由都以
  // `subagent model selection:` 开头，宿主把它包成 `Error: <reason>`。
  // 认不出它，这类拒绝会被记成 `tool_error`、运行变 `released`，命名空间
  // 于是被永久占住——修正后的重试只能拿到 `MANDATE_DUPLICATE`。
  const selection = new RegExp('^(?:Error:\\s*)?' + SUBAGENT_SELECTION_DENIAL_PREFIX)
  return selection.test(joined) ? SUBAGENT_SELECTION_DENIAL_CODE : undefined
}

/**
 * 聚合一次运行的 attempt 计数，得出它的状态。
 *
 * 优先级：succeeded → unknown → tool_error → 全是 guard_denied。
 *
 * 两条额外的单调性规则：
 *
 * 1. **报告是终态**：报告到达之后，后来的 attempt 不再改写状态。
 * 2. **已落地的终态不被后来的 attempt 改写**：released / completed / blocked
 *    之后不再回到 booked——否则"第二次被拒的失败"会把第一次的结论改掉。
 *    `denied` **是例外**：它只说明这个运行的尝试全部被守卫在派发前拒掉，
 *    没有任何已经发生的派发值得保护，所以再收到一次尝试时按计数重算
 *    （修正后的同一命名空间因此能真的派发出去）。
 * @param run - 当前运行记录。
 * @param totals - attempt 聚合计数。
 * @returns 运行状态。
 */
export function aggregateRunState(run: LedgerRun, totals: AttemptTotals): RunState {
  if (run.report !== undefined) return run.state
  if (run.state !== 'booked' && run.state !== 'denied') return run.state
  if (totals.succeeded > 0) return 'booked'
  if (totals.unknown > 0) return 'booked'
  if (totals.toolError > 0) return 'released'
  if (totals.total > 0 && totals.guardDenied === totals.total) return 'denied'
  return 'booked'
}

/**
 * 把一次 attempt 记进运行记录。
 * @param run - 运行记录。
 * @param attempt - 新 attempt。
 * @returns 新运行记录。
 */
function applyAttemptToRun(run: LedgerRun, attempt: LedgerAttempt): LedgerRun {
  const attempts = trimAttempts([...run.attempts, attempt])
  const totals: AttemptTotals = {
    total: run.attemptTotals.total + 1,
    succeeded: run.attemptTotals.succeeded + (attempt.outcome === 'succeeded' ? 1 : 0),
    unknown: run.attemptTotals.unknown + (attempt.outcome === 'unknown' ? 1 : 0),
    toolError: run.attemptTotals.toolError + (attempt.outcome === 'tool_error' ? 1 : 0),
    guardDenied: run.attemptTotals.guardDenied + (attempt.outcome === 'guard_denied' ? 1 : 0),
  }
  const next: LedgerRun = { ...run, attempts, attemptTotals: totals }
  return settleRunState(next)
}

/**
 * 按聚合计数结算运行状态。
 * @param run - 运行记录。
 * @returns 结算后的记录。
 */
function settleRunState(run: LedgerRun): LedgerRun {
  const state = aggregateRunState(run, run.attemptTotals)
  if (state === run.state) return run
  if (state === 'released') {
    const { release: _previous, ...rest } = run
    return { ...rest, state, release: 'dispatch_failed' }
  }
  return { ...run, state }
}

/**
 * 造一条运行记录。
 * @param header - 派发头。
 * @param attempt - 第一次尝试。
 * @param tool - 派发工具名。
 * @param seq - 尝试的序号。
 * @param at - 尝试的时刻。
 * @param body - 围栏之后的正文；它的 sha256 由**插件**算，模型给不了也伪造不了。
 * @returns 运行记录。
 */
function createRun(
  header: MandateHeader,
  attempt: LedgerAttempt,
  tool: string,
  seq: number,
  at: number,
  body: string,
): LedgerRun {
  const run: LedgerRun = {
    ns: attempt.ns,
    brief_id: header.brief_id,
    run_id: header.run_id,
    idem: header.idem,
    mandate_version: header.mandate_version,
    prompt_ref: header.prompt_ref,
    policy: { id: header.policy.id, version: header.policy.version, sha256: header.policy.sha256 },
    task: [...(header.task ?? [])],
    boundary: [...(header.boundary ?? [])],
    followup: [...(header.followup ?? [])],
    body_sha256: sha256Hex(body),
    tool,
    seq,
    at,
    state: 'booked',
    attempts: [attempt],
    attemptTotals: {
      total: 1,
      succeeded: attempt.outcome === 'succeeded' ? 1 : 0,
      unknown: attempt.outcome === 'unknown' ? 1 : 0,
      toolError: attempt.outcome === 'tool_error' ? 1 : 0,
      guardDenied: attempt.outcome === 'guard_denied' ? 1 : 0,
    },
    createdByCallId: attempt.callId,
    releasedHistory: [],
    ...(header.parent_mandate === undefined || header.parent_mandate === null
      ? {}
      : {
        parent_run: mandateNamespaceKeyOf(
          header.parent_mandate.brief_id,
          header.parent_mandate.run_id,
          header.parent_mandate.idem,
        ),
      }),
  }
  return settleRunState(run)
}

/**
 * 记一次派发尝试。
 * @param state - 当前状态。
 * @param header - 派发头。
 * @param callId - 调用 id。
 * @param tool - 派发工具名。
 * @param outcome - 结局（未结算时为 'unknown'）。
 * @param denialCode - 守卫拒绝码。
 * @param seq - 尝试的序号。
 * @param at - 尝试的时刻。
 * @returns 新状态。
 */
function recordAttempt(
  state: DispatchLedgerState,
  header: MandateHeader,
  callId: string,
  tool: string,
  outcome: AttemptOutcome,
  denialCode: string | undefined,
  seq: number,
  at: number,
  body: string,
): DispatchLedgerState {
  const ns = mandateNamespaceKey(header)
  const attempt: LedgerAttempt = {
    callId,
    ns,
    seq,
    at,
    tool,
    outcome,
    ...(denialCode === undefined ? {} : { denialCode }),
  }
  const existing = lookupRun(state.runs, ns)
  const pending = outcome === 'unknown'
    ? { ...state.pending, [callId]: ns }
    : state.pending
  const boundedPending = boundPending(pending)
  if (existing === undefined) {
    const run = createRun(header, attempt, tool, seq, at, body)
    const runs = { ...state.runs, [ns]: run }
    const counters = {
      ...state.counters,
      ...(briefIsBusy(state, header.brief_id) ? { briefBusy: state.counters.briefBusy + 1 } : {}),
    }
    return refreshLedger({ ...state, runs, pending: boundedPending, counters })
  }
  // 复用一个 denied 运行：它此前的身体一次都没落地，所以账本以**这次**尝试为准——
  // 正文哈希与工具名都换成新的，attempts 历史仍然保留。
  const base = existing.state === 'denied'
    ? { ...existing, body_sha256: sha256Hex(body), tool }
    : existing
  const run = applyAttemptToRun(base, attempt)
  const runs = { ...state.runs, [ns]: run }
  // 在 denied 运行上重试是「修正后重派」，不是重复：它不计数。
  const counters = existing.state === 'denied'
    ? state.counters
    : { ...state.counters, duplicates: state.counters.duplicates + 1 }
  return refreshLedger({ ...state, runs, pending: boundedPending, counters })
}

/**
 * 给未结算的 attempt 表定上限。
 * @param pending - 当前表。
 * @returns 裁剪后的表（超出时淘汰最早的）。
 */
function boundPending(pending: Record<string, string>): Record<string, string> {
  const keys = Object.keys(pending)
  if (keys.length <= MAX_PENDING_ATTEMPTS) return pending
  const bounded = { ...pending }
  for (const key of keys.slice(0, keys.length - MAX_PENDING_ATTEMPTS)) delete bounded[key]
  return bounded
}

/**
 * 结算一次未结算的 attempt。
 * @param state - 当前状态。
 * @param callId - 调用 id。
 * @param outcome - 结局。
 * @param denialCode - 守卫拒绝码。
 * @returns 新状态；没有这条待结算的 attempt 时是同一个引用。
 */
function settleAttempt(
  state: DispatchLedgerState,
  callId: string,
  outcome: AttemptOutcome,
  denialCode: string | undefined,
): DispatchLedgerState {
  const ns = lookupPending(state.pending, callId)
  if (ns === undefined) return state
  const run = lookupRun(state.runs, ns)
  if (run === undefined) return state
  const pending = { ...state.pending }
  delete pending[callId]
  const index = run.attempts.findIndex(attempt => attempt.callId === callId)
  const attempts = index >= 0
    ? run.attempts.map((attempt, position) => position === index
      ? { ...attempt, outcome, ...(denialCode === undefined ? {} : { denialCode }) }
      : attempt)
    : run.attempts
  const totals: AttemptTotals = {
    total: run.attemptTotals.total,
    succeeded: run.attemptTotals.succeeded + (outcome === 'succeeded' ? 1 : 0),
    unknown: Math.max(0, run.attemptTotals.unknown - 1),
    toolError: run.attemptTotals.toolError + (outcome === 'tool_error' ? 1 : 0),
    guardDenied: run.attemptTotals.guardDenied + (outcome === 'guard_denied' ? 1 : 0),
  }
  const updated = settleRunState({ ...run, attempts, attemptTotals: totals })
  const runs = { ...state.runs, [ns]: updated }
  return refreshLedger({ ...state, runs, pending })
}

/**
 * 重建工作项状态。
 * @param runs - 运行记录。
 * @returns 工作项状态。
 */
export function rebuildBriefs(runs: Readonly<Record<string, LedgerRun>>): Record<string, BriefState> {
  const briefs: Record<string, BriefState> = {}
  for (const run of Object.values(runs)) {
    const existing = briefs[run.brief_id]
    if (existing === undefined) {
      briefs[run.brief_id] = { brief_id: run.brief_id, state: 'free', latestRun: run.ns, latestSeq: run.seq }
      continue
    }
    if (run.seq > existing.latestSeq) {
      briefs[run.brief_id] = { ...existing, latestRun: run.ns, latestSeq: run.seq }
    }
  }
  for (const run of Object.values(runs)) {
    const brief = briefs[run.brief_id]
    if (brief === undefined) continue
    if (run.state === 'booked' || run.state === 'blocked') {
      briefs[run.brief_id] = { ...brief, state: 'occupied' }
      continue
    }
    if (run.state === 'completed' && brief.state !== 'occupied') {
      briefs[run.brief_id] = { ...brief, state: 'closed' }
    }
  }
  return briefs
}

/**
 * 重建派生索引：工作项状态、子代理绑定、未结算 attempt 表。
 *
 * **这里不淘汰任何东西。** 账本必须忠实保留全部幂等事实：一个命名空间一旦
 * 被占用就永远占着，删掉它等于给重复派发开门。容量上限由
 * {@link dispatchLedgerCapacity} 报告给守卫，由守卫在**新的一次有效派发**
 * 之前用 MANDATE_LEDGER_FULL 拒绝——而不是靠丢历史来腾地方。
 *
 * @param state - 当前状态。
 * @returns 重建后的状态。
 */
function refreshLedger(state: DispatchLedgerState): DispatchLedgerState {
  const runs = state.runs
  const briefs = rebuildBriefs(runs)
  const children: Record<string, ChildBinding> = {}
  for (const [childId, binding] of Object.entries(state.children)) {
    if (lookupRun(runs, binding.ns) === undefined) continue
    children[childId] = binding
  }
  const pending: Record<string, string> = {}
  for (const [callId, ns] of Object.entries(state.pending)) {
    if (lookupRun(runs, ns) === undefined) continue
    pending[callId] = ns
  }
  return { ...state, runs, briefs, children, pending }
}

/**
 * 容量查询：账本还能不能接下**一次新的派发**。
 *
 * 纯函数，守卫在放行新派发**之前**问它：满了就用 MANDATE_LEDGER_FULL 拒绝。
 * 账本本身**不淘汰**任何历史——淘汰会让旧命名空间重新变得可派，等于绕过防重。
 *
 * @param state - 当前状态。
 * @param briefId - 本次派发要用的工作项 id；给了就一并报出它的情况。
 * @returns 容量快照。
 */
export function dispatchLedgerCapacity(
  state: DispatchLedgerState,
  briefId?: string,
): DispatchLedgerCapacity {
  const runs = Object.keys(state.runs).length
  const briefs = Object.keys(state.briefs).length
  const brief = briefId === undefined ? undefined : lookupBrief(state.briefs, briefId)
  const briefRuns = briefId === undefined
    ? 0
    : Object.values(state.runs).filter(run => run.brief_id === briefId).length
  const runsFull = runs >= MAX_RUNS_PER_SESSION
  const briefsFull = briefs >= MAX_BRIEFS_PER_SESSION
  return {
    runs,
    briefs,
    runsFull,
    briefsFull,
    // 新的一次派发会被拒：运行总数已满，或者（新建工作项时）工作项数已满。
    full: runsFull || (briefsFull && brief === undefined),
    ...(brief === undefined
      ? {}
      : { brief: { brief_id: brief.brief_id, runs: briefRuns, state: brief.state } }),
  }
}

/**
 * 读一个工作项是否被未了结的运行占用。
 * @param state - 当前状态。
 * @param brief_id - 工作项 id。
 * @param excludeNs - 不计入的命名空间（一般是本次要开的新运行）。
 * @returns 是否被占用。
 */
export function briefIsBusy(
  state: DispatchLedgerState,
  brief_id: string,
  excludeNs?: string,
): boolean {
  return Object.values(state.runs).some(run => run.brief_id === brief_id
    && run.ns !== excludeNs
    && (run.state === 'booked' || run.state === 'blocked'))
}

/**
 * 读一个工作项最新一次运行的命名空间。
 * @param state - 当前状态。
 * @param brief_id - 工作项 id。
 * @returns 命名空间；没有时 undefined。
 */
export function latestRunNsOfBrief(state: DispatchLedgerState, brief_id: string): string | undefined {
  const brief = lookupBrief(state.briefs, brief_id)
  return brief?.latestRun
}

/**
 * 读一个工作项的状态。
 * @param state - 当前状态。
 * @param brief_id - 工作项 id。
 * @returns 工作项状态；没有时 undefined。
 */
export function briefStateOf(
  state: DispatchLedgerState,
  brief_id: string,
): BriefState['state'] | undefined {
  return lookupBrief(state.briefs, brief_id)?.state
}

/**
 * 判断一个命名空间是否已被**别的**尝试占用。
 *
 * 守卫在执行期用它判"重复"：宿主把本次调用先写进日志，所以本次调用自己
 * 也会出现在账本里——必须按 callId 排除自己。
 * @param state - 当前状态。
 * @param ns - 命名空间键。
 * @param callId - 本次调用的 id。
 * @returns 是否已被别的尝试占用。
 */
export function isNamespaceClaimedByAnother(
  state: DispatchLedgerState,
  ns: string,
  callId: string,
): boolean {
  const run = lookupRun(state.runs, ns)
  if (run === undefined) return false
  return run.createdByCallId !== callId
}

/**
 * 读一条运行记录。
 * @param state - 当前状态。
 * @param ns - 命名空间键。
 * @returns 运行记录；没有时 undefined。
 */
export function runOf(state: DispatchLedgerState, ns: string): LedgerRun | undefined {
  return state.runs[ns]
}

/**
 * 折叠一次原生工具调用。
 * @param state - 当前状态。
 * @param event - 事件。
 * @param dispatchTools - 派发工具名。
 * @returns 新状态。
 */
function foldNativeCall(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
  dispatchTools: readonly string[],
): DispatchLedgerState {
  const data = event.data
  if (!isRecord(data)) return state
  const name = asString(data['name'])
  if (name === undefined || !dispatchTools.includes(name)) return state
  const raw = data['arguments']
  if (typeof raw !== 'string') return state
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return state
  }
  if (!isRecord(parsed)) return state
  const prompt = asString(parsed['prompt'])
  if (prompt === undefined) return withCounter(state, 'unmandated')
  const callId = asString(data['callId'])
  if (callId === undefined) return state
  return foldDispatchAttempt(state, prompt, callId, name, 'unknown', undefined, seqOf(event), atOf(event))
}

/**
 * 折叠一次 PTC 子派发开始。
 * @param state - 当前状态。
 * @param event - 事件。
 * @param dispatchTools - 派发工具名。
 * @returns 新状态。
 */
function foldPtcStart(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
  dispatchTools: readonly string[],
): DispatchLedgerState {
  const data = event.data
  if (!isRecord(data)) return state
  const name = asString(data['name'])
  if (name === undefined || !dispatchTools.includes(name)) return state
  const argumentsValue = data['arguments']
  if (!isRecord(argumentsValue)) return state
  const prompt = asString(argumentsValue['prompt'])
  if (prompt === undefined) return withCounter(state, 'unmandated')
  const callId = asString(data['subCallId'])
  if (callId === undefined) return state
  return foldDispatchAttempt(state, prompt, callId, name, 'unknown', undefined, seqOf(event), atOf(event))
}

/**
 * 折叠一次 PTC 子派发结算。
 * @param state - 当前状态。
 * @param event - 事件。
 * @param dispatchTools - 派发工具名。
 * @returns 新状态。
 */
function foldPtcSettle(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
  dispatchTools: readonly string[],
): DispatchLedgerState {
  const data = event.data
  if (!isRecord(data)) return state
  const name = asString(data['name'])
  if (name === undefined || !dispatchTools.includes(name)) return state
  const callId = asString(data['subCallId'])
  if (callId === undefined) return state
  const classified = classifyToolOutcome(data['isError'] === true, data['content'])
  if (lookupPending(state.pending, callId) !== undefined) {
    return settleAttempt(state, callId, classified.outcome, classified.denialCode)
  }
  const existing = Object.values(state.runs).find(run => run.createdByCallId === callId)
  if (existing !== undefined) {
    return settleAttempt(state, callId, classified.outcome, classified.denialCode)
  }
  const argumentsValue = data['arguments']
  if (!isRecord(argumentsValue)) return state
  const prompt = asString(argumentsValue['prompt'])
  if (prompt === undefined) return withCounter(state, 'unmandated')
  return foldDispatchAttempt(
    state, prompt, callId, name, classified.outcome, classified.denialCode, seqOf(event), atOf(event),
  )
}

/**
 * 折叠一次派发尝试的公共部分。
 * @param state - 当前状态。
 * @param prompt - 提示词原文。
 * @param callId - 调用 id。
 * @param tool - 派发工具名。
 * @param outcome - 结局。
 * @param denialCode - 守卫拒绝码。
 * @param seq - 序号。
 * @param at - 时刻。
 * @returns 新状态。
 */
function foldDispatchAttempt(
  state: DispatchLedgerState,
  prompt: string,
  callId: string,
  tool: string,
  outcome: AttemptOutcome,
  denialCode: string | undefined,
  seq: number,
  at: number,
): DispatchLedgerState {
  const parsed = parseMandateHeader(prompt)
  if (parsed.state === 'none') return withCounter(state, 'unmandated')
  if (parsed.state === 'invalid' || parsed.header === undefined) return withCounter(state, 'malformed')
  const header = parsed.header
  if (header.kind !== 'dispatch') return withCounter(state, 'malformed')
  // 正文由插件自己取、自己算哈希：模型既不提供也不伪造。
  return recordAttempt(state, header, callId, tool, outcome, denialCode, seq, at, parsed.body ?? '')
}

/**
 * 折叠一次原生工具结果。
 * @param state - 当前状态。
 * @param event - 事件。
 * @returns 新状态。
 */
function foldNativeResult(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
): DispatchLedgerState {
  const data = event.data
  if (!isRecord(data)) return state
  const message = data['message']
  if (!isRecord(message)) return state
  const callId = asString(message['toolCallId'])
  if (callId === undefined) return state
  const classified = classifyToolOutcome(message['isError'] === true, message['content'])
  return settleAttempt(state, callId, classified.outcome, classified.denialCode)
}

/**
 * 把一个报告状态映射成运行状态。
 * @param status - 报告状态。
 * @returns 目标状态与释放原因。
 */
function reportTransition(
  status: string,
): { state: RunState; release?: RunRelease } {
  switch (status) {
    case 'ready':
      return { state: 'completed' }
    case 'hand_back':
      return { state: 'released', release: 'hand_back' }
    case 'failed':
      return { state: 'released', release: 'failed' }
    case 'dropped':
      return { state: 'released', release: 'dropped' }
    case 'blocked':
      return { state: 'blocked' }
    default:
      return { state: 'blocked' }
  }
}

/**
 * 折叠一次收件箱投递（子代理的报告落在这里）。
 * @param state - 当前状态。
 * @param event - 事件。
 * @returns 新状态。
 */
function foldInboxSplice(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
): DispatchLedgerState {
  const data = event.data
  if (!isRecord(data)) return state
  const inserted = data['inserted']
  if (!Array.isArray(inserted)) return state
  let next = state
  for (const message of inserted) {
    if (!isRecord(message)) continue
    const parsed = mandateFromContent(message['content'])
    if (parsed.state !== 'ok' || parsed.header === undefined) continue
    const header = parsed.header
    if (header.kind !== 'report') continue
    const ns = mandateNamespaceKey(header)
    const run = lookupRun(next.runs, ns)
    if (run === undefined) {
      next = withCounter(next, 'orphanReports')
      continue
    }
    if (header.mandate_version !== run.mandate_version || header.prompt_ref !== run.prompt_ref) {
      next = withCounter(next, 'malformed')
      continue
    }
    const status = header.status
    if (status === undefined) {
      next = withCounter(next, 'malformed')
      continue
    }
    const transition = reportTransition(status)
    const releasedHistory = transition.state === 'released'
      ? trimReleasedHistory([
        ...run.releasedHistory,
        {
          state: run.state,
          ...(run.release === undefined ? {} : { release: run.release }),
          seq: seqOf(event),
          at: atOf(event),
        },
      ])
      : run.releasedHistory
    const { release: _previous, ...rest } = run
    const updated: LedgerRun = {
      ...rest,
      state: transition.state,
      ...(transition.release === undefined ? {} : { release: transition.release }),
      report: { status, seq: seqOf(event), at: atOf(event) },
      releasedHistory,
    }
    next = { ...next, runs: { ...next.runs, [ns]: updated } }
  }
  return next === state ? state : refreshLedger(next)
}

/**
 * 把一条**已提交**的会话事件折进账本。
 *
 * 纯函数：与本事件无关时返回**同一个引用**（`Object.is` 相等，下游零工作）。
 * @param state - 当前状态。
 * @param event - 已提交的事件。
 * @param options - 折叠选项。
 * @returns 下一份状态。
 */
export function foldDispatchLedger(
  state: DispatchLedgerState,
  event: DispatchLedgerEventLike,
  options: DispatchLedgerFoldOptions = {},
): DispatchLedgerState {
  if (!isRecord(event)) return state
  const dispatchTools = options.dispatchTools ?? DEFAULT_DISPATCH_TOOLS
  const type = event.type
  if (type === 'tool/call') return foldNativeCall(state, event, dispatchTools)
  if (type === 'tool/ptc-dispatch-start') return foldPtcStart(state, event, dispatchTools)
  if (type === 'tool/ptc-dispatch') return foldPtcSettle(state, event, dispatchTools)
  if (type === 'tool/result') return foldNativeResult(state, event)
  if (type === 'agent/inbox/spliced') return foldInboxSplice(state, event)
  return state
}

/**
 * 折叠一整份会话日志。
 * @param events - 有序事件。
 * @param options - 折叠选项。
 * @returns 折叠后的状态。
 */
export function foldDispatchLedgerEvents(
  events: readonly DispatchLedgerEventLike[],
  options: DispatchLedgerFoldOptions = {},
): DispatchLedgerState {
  let state = initialDispatchLedgerState()
  for (const event of events) state = foldDispatchLedger(state, event, options)
  return state
}

/**
 * 把子代理与它持有的 Mandate 绑定起来。
 *
 * 关联只用**持久事实**，分两条来源：
 *
 * 1. 父会话的 §subagent/catalog§ 给出子会话 id（可续子代理）；
 * 2. 调用方给定的**候选会话列表**——one-shot 子代理没有 catalog 条目，只能
 *    这样把候选交给本函数。
 *
 * 两条来源合并后，一律按 §header.parentSession === 父会话 id§ 过滤：**不做
 * 启发式猜测**。读不到子会话日志就**不绑**——宁可让绑定缺席，也不给一个错的
 * id。
 *
 * @param state - 当前状态。
 * @param parent - 父会话。
 * @param resolve - 按 id 解析子会话的读取器。
 * @param candidates - 候选子会话（one-shot 回退）。
 * @returns 新状态；没有新绑定时是同一个引用。
 */
export function bindChildMandates(
  state: DispatchLedgerState,
  parent: SessionLike,
  resolve: (childId: string) => SessionLike | undefined,
  candidates: readonly SessionLike[] = [],
): DispatchLedgerState {
  const parentId = sessionIdOf(parent)
  const children: Record<string, ChildBinding> = { ...state.children }
  let changed = false

  const bind = (session: SessionLike | undefined, childId: string): void => {
    if (session === undefined) return
    // 血缘是硬条件：只有"直接父会话就是它"的会话才是本父的子代理。
    if (parentId === undefined) return
    if (parentSessionIdOfSession(session) !== parentId) return
    for (const header of heldMandatesOfSession(session)) {
      if (header.kind !== 'dispatch') continue
      const ns = mandateNamespaceKey(header)
      const run = state.runs[ns]
      if (run === undefined) continue
      const binding: ChildBinding = {
        ns,
        brief_id: header.brief_id,
        run_id: header.run_id,
        idem: header.idem,
        mandate_version: header.mandate_version,
        prompt_ref: header.prompt_ref,
        at: run.at,
      }
      const existing = children[childId]
      if (existing !== undefined && existing.ns === binding.ns) continue
      children[childId] = binding
      changed = true
    }
  }

  for (const child of catalogChildrenOfSession(parent)) {
    let session: SessionLike | undefined
    try {
      session = resolve(child.childId)
    } catch {
      session = undefined
    }
    bind(session, child.childId)
  }
  for (const session of candidates) {
    const childId = sessionIdOf(session)
    if (childId === undefined) continue
    bind(session, childId)
  }
  return changed ? { ...state, children } : state
}
