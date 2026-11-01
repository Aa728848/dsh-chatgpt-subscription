/**
 * 「调度账本」的宿主装配：一次性注册只读工具 + 装一台执行期守卫。
 *
 * ## 装配纪律
 *
 * - 工具**一次性注册**：描述与参数表是编译期常量，会话中途不会多一个或少一个
 *   工具，模型的工具记忆与 Kimi 的前缀缓存都不受影响。
 * - 守卫只走 `ctx.tools.guard()`：工具声明面一个字节都不改。
 * - **不登记任何投影**：账本直接折会话日志（快照或按序号读），所以老宿主没有
 *   投影服务时功能照样完整。
 * - 开关复用现有的 `dispatchExecutionGuard` 设置，不新增设置项。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/index
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  createDispatchLedgerCache,
  installDispatchLedgerGuard,
  policyForSession,
  type DispatchLedgerCache,
  type DispatchLedgerSessionLike,
  type DispatchLedgerSessions,
} from './guard.ts'
import { createDispatchLedgerTool, DISPATCH_LEDGER_TOOL } from './tool.ts'
import type { DispatchPolicyDescriptor } from './policy.ts'

/** 宿主装配选项。 */
export interface DispatchLedgerHostOptions {
  /** 当前是否启用（每次执行都重读）。 */
  readonly enabled?: () => boolean
  /** 会话注册表（缺席时 tree 范围退化为当前会话）。 */
  readonly sessions?: () => DispatchLedgerSessions | undefined
  /** 当前会话的策略描述符；缺省时按会话自己记录的路由算。 */
  readonly policyFor?: (session: DispatchLedgerSessionLike) => DispatchPolicyDescriptor | undefined
  /** 视为"派发"的工具名。 */
  readonly dispatchTools?: readonly string[]
  /** 共享的折叠缓存（缺省时新建一个）。 */
  readonly cache?: DispatchLedgerCache
  /**
   * 当前环境的提示词修订号。
   *
   * 由宿主在**装配时**算好（对 preset 的稳定序列化文本取摘要）并注入：模型
   * 只能从工具的 self 结果里把它抄进头部，不允许自拟。守卫用同一个值校验
   * 派发头。
   */
  readonly promptRef?: string
}

/**
 * 把一份任意结构的对象序列化成**稳定文本**。
 *
 * 键按字典序排序，所以同一份内容在任何进程、任何代次宿主上都得到逐字相同
 * 的文本；§JSON.stringify§ 不排序，靠它算出来的摘要会随字面量的键顺序漂移。
 * @param value - 候选值。
 * @returns 稳定文本。
 */
export function canonicalPromptSourceText(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalPromptSourceText).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return '{'
    + keys.map(key => JSON.stringify(key) + ':' + canonicalPromptSourceText(record[key])).join(',')
    + '}'
}

/**
 * 判断一个值是不是普通记录对象。
 * @param value - 候选值。
 * @returns 是记录对象时 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读宿主上下文里的工具注册面。
 * @param ctx - 宿主上下文。
 * @returns 工具注册面；没有时 undefined。
 */
function toolsOf(ctx: unknown): {
  register?: (definition: ToolDefinition) => (() => void) | undefined
  guard?: (guard: (execution: unknown) => string | undefined) => (() => void) | undefined
} | undefined {
  if (!isRecord(ctx)) return undefined
  let tools: unknown
  try {
    tools = ctx['tools']
  } catch {
    tools = undefined
  }
  if (!isRecord(tools)) {
    const reader = (ctx as { get?: (name: string) => unknown }).get
    if (typeof reader !== 'function') return undefined
    try {
      tools = reader.call(ctx, 'tools')
    } catch {
      return undefined
    }
  }
  return isRecord(tools) ? tools as {
    register?: (definition: ToolDefinition) => (() => void) | undefined
    guard?: (guard: (execution: unknown) => string | undefined) => (() => void) | undefined
  } : undefined
}

/**
 * 装上调度账本：只读工具 + 执行期守卫。
 * @param ctx - 宿主上下文。
 * @param options - 装配选项。
 * @returns 拆除装配的函数。
 */
export function installDispatchLedger(
  ctx: unknown,
  options: DispatchLedgerHostOptions = {},
): () => void {
  const tools = toolsOf(ctx)
  if (tools === undefined) return () => undefined
  const cache = options.cache ?? createDispatchLedgerCache()
  // **统一的 safe resolver**：老宿主的 ctx.get('sessions') 可能抛错。读不到或
  // 抛错一律当成"没有 sessions 服务"——工具、策略与守卫共用同一个它，行为一致。
  const rawSessions = options.sessions
  const sessions = (): DispatchLedgerSessions | undefined => {
    if (rawSessions === undefined) return undefined
    try {
      const resolved = rawSessions()
      return resolved ?? undefined
    } catch {
      return undefined
    }
  }
  const dispatchTools = options.dispatchTools
  const policyFor = options.policyFor
    ?? ((session: DispatchLedgerSessionLike) => policyForSession(session, sessions(), dispatchTools))

  const tool = createDispatchLedgerTool({
    cache,
    sessions,
    policyFor,
    ...(options.promptRef === undefined ? {} : { promptRef: options.promptRef }),
  })
  const disposeTool = typeof tools.register === 'function'
    ? tools.register(tool)
    : undefined

  const disposeGuard = installDispatchLedgerGuard(ctx, {
    enabled: options.enabled,
    sessions,
    policyFor,
    ...(options.promptRef === undefined ? {} : { promptRef: options.promptRef }),
    ...(dispatchTools === undefined ? {} : { dispatchTools }),
    cache,
  })

  return () => {
    if (typeof disposeTool === 'function') disposeTool()
    if (typeof disposeGuard === 'function') disposeGuard()
  }
}

export { DISPATCH_LEDGER_TOOL }
