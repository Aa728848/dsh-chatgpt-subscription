/**
 * `dispatch_ledger`：**只读**的账本查询工具。
 *
 * ## 静态性
 *
 * 工具描述与参数表都是**编译期常量**：不随会话变化、不随开关变化、不懒注册。
 * 工具在宿主装配时**一次性注册**，此后清单不再变动——会话中途少一个或多一个
 * 工具会破坏模型的工具记忆，也会让 Kimi 的前缀缓存漂移。
 *
 * ## 两种动作
 *
 * - `action:"self"`：这个会话自己的委派上下文——会话 id、父会话 id、当前策略
 *   描述符、自身持有的 Mandate、账本开放状态，以及**协议正文**。协议正文放在
 *   返回值与渲染文本的**尾部**：模型读到的最后一块就是协议，不必把它塞进
 *   persona（persona 的预算只有 18500 字符，已经用掉 17401）。
 * - `action:"ledger"`：账本条目，支持 session / tree 两种范围与若干过滤。
 *
 * ## 只读
 *
 * 工具**不追加任何会话事件**，也不改账本：折叠是纯函数，账本是日志的投影。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  mandateNamespaceKey,
  type MandateHeader,
} from './header.ts'
import {
  parentSessionIdOfSession,
  sessionIdOf,
} from './binding.ts'
import {
  bindChildMandates,
  dispatchLedgerCapacity,
  type DispatchLedgerState,
  type LedgerRun,
} from './ledger.ts'
import {
  ownMandateOf,
  type DispatchLedgerCache,
  type DispatchLedgerSessionLike,
  type DispatchLedgerSessions,
} from './guard.ts'
import type { DispatchPolicyDescriptor } from './policy.ts'
import { DISPATCH_MANDATE_PROTOCOL } from './protocol.ts'

/** 注册的工具名。冻结契约的一部分，不要改动。 */
export const DISPATCH_LEDGER_TOOL = 'dispatch_ledger'

/** 工具描述：编译期常量，≤240 字符，不含任何会话相关的内容。 */
export const DISPATCH_LEDGER_DESCRIPTION = 'Read the dispatch ledger of this session (mandate bookings, their '
  + 'state, and the child holding them), or read your own dispatch context and the v2 mandate '
  + 'protocol. Read-only: it never dispatches and never writes.'

/** 空计数器（会话缺席时的兜底）。 */
const EMPTY_COUNTERS = {
  unmandated: 0,
  malformed: 0,
  duplicates: 0,
  briefBusy: 0,
  policyStale: 0,
  orphanReports: 0,
  notHeld: 0,
}

/** 一次查询最多返回多少行。 */
export const DISPATCH_LEDGER_MAX_LIMIT = 200

/** 默认返回多少行。 */
export const DISPATCH_LEDGER_DEFAULT_LIMIT = 50

/** one-shot 候选会话的读取上限（防止 sessions.list 太大）。 */
export const DISPATCH_LEDGER_MAX_CANDIDATES = 512

/** 工具依赖。 */
export interface DispatchLedgerToolDeps {
  /** 共享的折叠缓存。 */
  readonly cache: DispatchLedgerCache
  /** 会话注册表（tree 范围与 one-shot 候选的来源）。 */
  readonly sessions?: () => DispatchLedgerSessions | undefined
  /** 当前会话的策略描述符。 */
  readonly policyFor?: (session: DispatchLedgerSessionLike) => DispatchPolicyDescriptor | undefined
  /**
   * 当前环境的提示词修订号（由宿主注入）。
   *
   * 模型**不能自拟**：它必须从本工具的 self 结果里原样抄进头部。未注入时
   * （standalone 测试宿主）本字段缺省，模型便无从抄起。
   */
  readonly promptRef?: string
}

/** 工具参数（静态）。 */
export interface DispatchLedgerToolArgs {
  /** 动作。 */
  readonly action?: string
  /** 范围。 */
  readonly scope?: string
  /** 工作项过滤。 */
  readonly brief_id?: string
  /** 运行过滤。 */
  readonly run_id?: string
  /** 幂等键过滤。 */
  readonly idem?: string
  /** 状态过滤。 */
  readonly state?: string
  /** 行数上限。 */
  readonly limit?: number
}

/** 一份"自身 Mandate"的值形状。 */
export type DispatchLedgerMandateValue = {
  /** 工作项 id。 */
  brief_id: string
  /** 运行 id。 */
  run_id: string
  /** 幂等键。 */
  idem: string
  /** 授权快照版本。 */
  mandate_version: number
  /** 提示词修订号。 */
  prompt_ref: string
  /** 策略引用。 */
  policy: { id: string; version: string; sha256: string }
  /** 原始任务的引用。 */
  task: string[]
  /** 结构化边界。 */
  boundary: string[]
  /** 允许的后续上下文。 */
  followup: string[]
  /** 血缘：接替的那一次运行。 */
  parent_mandate?: { brief_id: string; run_id: string; idem: string }
}

/**
 * 一行账本条目。
 *
 * 可空字段一律写成 **null**（不是缺省）：返回值是 JSON 值，缺省字段在
 * 校验时是"可有可无"，null 是"确定没有"，对模型更省事。
 */
export type DispatchLedgerRow = {
  /** 工作项 id。 */
  brief_id: string
  /** 运行 id。 */
  run_id: string
  /** 幂等键。 */
  idem: string
  /** 命名空间键。 */
  ns: string
  /** 运行状态。 */
  state: string
  /** 释放原因。 */
  release: string | null
  /** 派发工具名。 */
  tool: string
  /** 第一次尝试的序号。 */
  seq: number
  /** 第一次尝试的时刻。 */
  at: number
  /** 是否已结算（没有未结算的尝试）。 */
  settled: boolean
  /** 尝试总数。 */
  attempts: number
  /** 提示词修订号。 */
  prompt_ref: string
  /** 授权快照版本。 */
  mandate_version: number
  /** 持有它的子会话 id。 */
  childId: string | null
  /** 收到的报告。 */
  report: { status: string; seq: number; at: number } | null
  /** 血缘：接替的那一次运行。 */
  parent_run: string | null
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
 * 读一个值里的非空字符串。
 * @param value - 候选值。
 * @returns 字符串；其它类型为 undefined。
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读一个调用方的会话。
 * @param agent - 调用方 agent。
 * @returns 会话；没有时 undefined。
 */
function sessionOfAgent(agent: unknown): DispatchLedgerSessionLike | undefined {
  if (!isRecord(agent)) return undefined
  const session = agent['session']
  if (!isRecord(session)) return undefined
  return session as DispatchLedgerSessionLike
}

/**
 * 把一份头部压成"自身 Mandate"的值形状。
 * @param header - 头部。
 * @returns 值；没有头部时 undefined。
 */
function mandateValueOf(header: MandateHeader | undefined): DispatchLedgerMandateValue | undefined {
  if (header === undefined) return undefined
  return {
    brief_id: header.brief_id,
    run_id: header.run_id,
    idem: header.idem,
    mandate_version: header.mandate_version,
    prompt_ref: header.prompt_ref,
    policy: { id: header.policy.id, version: header.policy.version, sha256: header.policy.sha256 },
    task: [...(header.task ?? [])],
    boundary: [...(header.boundary ?? [])],
    followup: [...(header.followup ?? [])],
    ...(header.parent_mandate === undefined || header.parent_mandate === null
      ? {}
      : { parent_mandate: { ...header.parent_mandate } }),
  }
}

/**
 * 收集一个会话的子会话候选（含 one-shot 的注册表扫描）。
 * @param sessions - 会话注册表。
 * @returns 候选会话。
 */
function candidatesOf(sessions: DispatchLedgerSessions | undefined): DispatchLedgerSessionLike[] {
  const list = sessions?.list
  if (typeof list !== 'function') return []
  let listed: unknown
  try {
    listed = list.call(sessions)
  } catch {
    return []
  }
  if (!Array.isArray(listed)) return []
  return listed.slice(0, DISPATCH_LEDGER_MAX_CANDIDATES) as DispatchLedgerSessionLike[]
}

/**
 * 收集一个会话的整棵委派树（自己 + 后代）。
 * @param session - 会话。
 * @param sessions - 会话注册表。
 * @returns 会话列表（自己在前）。
 */
function treeOf(
  session: DispatchLedgerSessionLike | undefined,
  sessions: DispatchLedgerSessions | undefined,
): DispatchLedgerSessionLike[] {
  if (session === undefined) return []
  const rootId = sessionIdOf(session)
  if (rootId === undefined) return [session]
  const all = [session, ...candidatesOf(sessions)]
  const childrenOf = new Map<string, DispatchLedgerSessionLike[]>()
  for (const candidate of all) {
    const parentId = parentSessionIdOfSession(candidate)
    if (parentId === undefined) continue
    const list = childrenOf.get(parentId) ?? []
    list.push(candidate)
    childrenOf.set(parentId, list)
  }
  const collected: DispatchLedgerSessionLike[] = [session]
  const queue = [rootId]
  const seen = new Set<string>([rootId])
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const child of childrenOf.get(current) ?? []) {
      const childId = sessionIdOf(child)
      if (childId === undefined || seen.has(childId)) continue
      seen.add(childId)
      collected.push(child)
      queue.push(childId)
    }
  }
  return collected
}

/**
 * 把一条运行压成一行。
 * @param run - 运行记录。
 * @param childId - 持有它的子会话 id。
 * @returns 行。
 */
function rowOf(run: LedgerRun, childId: string | undefined): DispatchLedgerRow {
  return {
    brief_id: run.brief_id,
    run_id: run.run_id,
    idem: run.idem,
    ns: run.ns,
    state: run.state,
    release: run.release ?? null,
    tool: run.tool,
    seq: run.seq,
    at: run.at,
    settled: run.attemptTotals.unknown === 0,
    attempts: run.attemptTotals.total,
    prompt_ref: run.prompt_ref,
    mandate_version: run.mandate_version,
    childId: childId ?? null,
    report: run.report === undefined ? null : { ...run.report },
    parent_run: run.parent_run ?? null,
  }
}

/**
 * 判断一行是否通过过滤。
 * @param row - 行。
 * @param args - 过滤条件。
 * @returns 是否保留。
 */
function matchesFilters(row: DispatchLedgerRow, args: DispatchLedgerToolArgs): boolean {
  if (args.brief_id !== undefined && row.brief_id !== args.brief_id) return false
  if (args.run_id !== undefined && row.run_id !== args.run_id) return false
  if (args.idem !== undefined && row.idem !== args.idem) return false
  if (args.state !== undefined && args.state !== '') {
    if (args.state === 'unsettled') {
      if (row.settled) return false
    } else if (row.state !== args.state) {
      return false
    }
  }
  return true
}

/**
 * 构造 `dispatch_ledger` 工具。
 * @param deps - 依赖。
 * @returns 可注册的工具定义。
 */
export function createDispatchLedgerTool(deps: DispatchLedgerToolDeps): ToolDefinition {
  return defineTool({
    name: DISPATCH_LEDGER_TOOL,
    description: DISPATCH_LEDGER_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['self', 'ledger'],
        description: 'self: your own dispatch context and the v2 mandate protocol. '
          + 'ledger: the bookings recorded for this session or its delegation tree.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'tree'],
        description: 'ledger only: session = this session; tree = this session plus its descendant subagents.',
      },
      brief_id: { type: 'string', description: 'ledger only: keep only this work item.' },
      run_id: { type: 'string', description: 'ledger only: keep only this run.' },
      idem: { type: 'string', description: 'ledger only: keep only this idempotency key.' },
      state: {
        type: 'string',
        enum: ['booked', 'completed', 'blocked', 'released', 'denied', 'unsettled'],
        description: 'ledger only: keep only runs in this state.',
      },
      limit: { type: 'number', description: 'ledger only: max rows (1-200, default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          parentSessionId: { type: 'string' },
          prompt_ref: { type: 'string' },
          scope: { type: 'string' },
          policy: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              version: { type: 'string', required: true },
              sha256: { type: 'string', required: true },
            },
          },
          mandate: {
            type: 'object',
            additionalProperties: false,
            properties: {
              brief_id: { type: 'string', required: true },
              run_id: { type: 'string', required: true },
              idem: { type: 'string', required: true },
              mandate_version: { type: 'number', required: true },
              prompt_ref: { type: 'string', required: true },
              policy: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  version: { type: 'string', required: true },
                  sha256: { type: 'string', required: true },
                },
              },
              task: { type: 'array' },
              boundary: { type: 'array' },
              followup: { type: 'array' },
              parent_mandate: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  brief_id: { type: 'string', required: true },
                  run_id: { type: 'string', required: true },
                  idem: { type: 'string', required: true },
                },
              },
            },
          },
          open: {
            type: 'object',
            additionalProperties: false,
            properties: {
              runs: { type: 'number', required: true },
              briefs: { type: 'number', required: true },
              runsFull: { type: 'boolean', required: true },
              briefsFull: { type: 'boolean', required: true },
            },
          },
          entries: { type: 'array' },
          truncated: { type: 'boolean' },
          counters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              unmandated: { type: 'number', required: true },
              malformed: { type: 'number', required: true },
              duplicates: { type: 'number', required: true },
              briefBusy: { type: 'number', required: true },
              policyStale: { type: 'number', required: true },
              orphanReports: { type: 'number', required: true },
              notHeld: { type: 'number', required: true },
            },
          },
          protocol: { type: 'string' },
        },
      },
      render(_args, value): ContentBlock[] {
        const record = value as Record<string, unknown>
        if (record['action'] === 'self') {
          const mandate = record['mandate'] as Record<string, unknown> | undefined
          const policy = record['policy'] as Record<string, unknown> | undefined
          const head = [
            'session ' + String(record['sessionId'])
            + (record['parentSessionId'] === undefined
              ? ''
              : ' (parent ' + String(record['parentSessionId']) + ')'),
            'policy ' + String(policy?.['id'] ?? 'none') + ' ' + String(policy?.['version'] ?? '')
            + ' sha256 ' + String(policy?.['sha256'] ?? ''),
            'prompt_ref (copy into a dispatch header): '
            + String(record['prompt_ref'] ?? 'not provided by this host'),
            mandate === undefined
              ? 'mandate: none held by this session'
              : 'mandate: brief ' + String(mandate['brief_id']) + ' run ' + String(mandate['run_id'])
              + ' idem ' + String(mandate['idem']) + ' prompt_ref ' + String(mandate['prompt_ref']),
            'open: ' + JSON.stringify(record['open'] ?? {}),
          ].join('\n')
          // 协议正文在**尾部**：模型读到的最后一块就是协议。
          return [{ type: 'text', text: head + '\n\n' + DISPATCH_MANDATE_PROTOCOL }]
        }
        const entries = (record['entries'] ?? []) as DispatchLedgerRow[]
        const lines = entries.map(entry => [
          entry.brief_id + '/' + entry.run_id + '/' + entry.idem,
          entry.state,
          entry.settled ? 'settled' : 'unsettled',
          'attempts ' + entry.attempts,
          entry.childId === undefined ? '' : 'child ' + entry.childId,
        ].join('  '))
        const head = lines.length === 0
          ? 'no dispatch ledger entries'
          : lines.join('\n')
        return [{
          type: 'text',
          text: head + '\n\nRun dispatch_ledger {action:"self"} for the v2 mandate protocol.',
        }]
      },
    },
    async execute(args, exec) {
      const session = sessionOfAgent(exec.agent)
      const sessionId = session === undefined ? '' : (sessionIdOf(session) ?? '')
      const action = args.action === 'ledger' ? 'ledger' : 'self'
      if (action === 'self') {
        const state: DispatchLedgerState = session === undefined
          ? { ledger: 2, runs: {}, briefs: {}, children: {}, pending: {}, counters: EMPTY_COUNTERS }
          : deps.cache.fold(session)
        const policy = deps.policyFor?.(session ?? { id: '' })
        const capacity = dispatchLedgerCapacity(state)
        const parentSessionId = session === undefined ? undefined : parentSessionIdOfSession(session)
        // 协议正文是**最后一个键**：value 与 render 的尾部都是协议。
        return {
          action: 'self',
          sessionId,
          ...(parentSessionId === undefined ? {} : { parentSessionId }),
          ...(policy === undefined
            ? {}
            : { policy: { id: policy.id, version: policy.version, sha256: policy.sha256 } }),
          ...(deps.promptRef === undefined ? {} : { prompt_ref: deps.promptRef }),
          ...(mandateValueOf(ownMandateOf(session)) === undefined
            ? {}
            : { mandate: mandateValueOf(ownMandateOf(session)) }),
          open: {
            runs: capacity.runs,
            briefs: capacity.briefs,
            runsFull: capacity.runsFull,
            briefsFull: capacity.briefsFull,
          },
          protocol: DISPATCH_MANDATE_PROTOCOL,
        }
      }
      const scope = args.scope === 'tree' ? 'tree' : 'session'
      const sessions = deps.sessions?.()
      const targets = scope === 'tree' ? treeOf(session, sessions) : (session === undefined ? [] : [session])
      const rows: DispatchLedgerRow[] = []
      const counters = session === undefined ? EMPTY_COUNTERS : deps.cache.fold(session).counters
      for (const target of targets) {
        const state = deps.cache.fold(target)
        const bound = bindChildMandates(
          state,
          target,
          childId => sessions?.get(childId),
          candidatesOf(sessions),
        )
        const childByRun = new Map<string, string>()
        for (const [childId, binding] of Object.entries(bound.children)) childByRun.set(binding.ns, childId)
        for (const run of Object.values(bound.runs)) {
          const row = rowOf(run, childByRun.get(run.ns))
          if (matchesFilters(row, args)) rows.push(row)
        }
      }
      rows.sort((left, right) => right.seq - left.seq)
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(DISPATCH_LEDGER_MAX_LIMIT, Math.trunc(args.limit)))
        : DISPATCH_LEDGER_DEFAULT_LIMIT
      const truncated = rows.length > requested
      const limited = truncated ? rows.slice(0, requested) : rows
      return {
        action: 'ledger',
        sessionId,
        scope,
        entries: limited,
        truncated,
        counters,
      }
    },
  })
}
