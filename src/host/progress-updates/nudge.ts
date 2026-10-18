/**
 * 8 轮催促：在 `tools/post-execute` 上计数，连续且带工具调用、期间没有
 * progress_update 的轮次达到阈值时，给模型追加一条提醒。
 *
 * 两个刻意的设计：
 *
 * 1. **计数按会话维度**，不按 subagent 各自计数。这是有意修正 Kimi 的实现瑕疵：
 *    主 agent 和它派出的 subagent 各自记一份，谁都没到阈值，于是用户长时间收不到
 *    任何进展。这里把子会话归并到最近的顶层祖先，整棵委派树共用一个计数器。
 * 2. **按「步」而不是按「条工具结果」计数**。`tools/post-execute` 是每条工具结果
 *    各触发一次的：一次并行发三个工具、或一次 run_code 里嵌 N 个子调用，都只是
 *    同一个模型步，却会触发 N 次。用会话的 turnBoundary 投影里的 lastStepStartSeq
 *    去重，才是真正的「轮次」。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/nudge
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { NOTIFY_USER_TOOL } from './tool.ts'

/** 注入到模型上下文里的催促正文。 */
export const NUDGE_TEXT = [
  'You have made a run of tool calls without reporting progress to the user.',
  'If you are still in the middle of multi-step work, send one progress update now with the '
    + NOTIFY_USER_TOOL + ' tool:',
  'one short title line and the details in the body — what you have established so far, where things stand, '
    + 'and what you are doing next.',
  'Skip it when there is genuinely nothing new to report.',
].join(' ')

/** 催促上下文在消息来源上的 kind（供客户端与日志区分这类注入）。 */
export const NUDGE_SOURCE_KIND = 'progress-updates-nudge'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 进展更新模块的催促提醒。 */
    'progress-updates-nudge': { kind: 'progress-updates-nudge' } & { form?: 'notice', summary?: string }
  }
}

/**
 * 造一条催促上下文。
 * @param sequence - 本会话第几次催促，写进 notice 摘要便于日志辨认。
 * @returns 可直接放进 `additionalContexts` 的用户角色消息。
 */
export function createNudgeContext(sequence: number): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: NUDGE_TEXT }],
    source: {
      kind: NUDGE_SOURCE_KIND,
      form: 'notice',
      summary: `progress update nudge #${sequence}`,
    },
  })
}

/**
 * 事件里读得到的会话标识与血缘。
 */
export interface NudgeAgent {
  /** 调用方 agent 的会话 id。 */
  readonly id?: unknown
  /** 调用方会话记录（用于读 lineage）。 */
  readonly session?: NudgeSessionLike
}

/** 一条会话记录里本模块会读的部分（结构化类型，不绑定具体 SDK 版本）。 */
export interface NudgeSessionLike {
  readonly header?: {
    readonly id?: unknown
    readonly origin?: unknown
    readonly parentSession?: unknown
  }
}

/** 会话查找表：够把子会话回溯到顶层祖先即可。 */
export interface NudgeSessionLookup {
  get(id: string): { readonly header?: { readonly origin?: unknown, readonly parentSession?: unknown } } | undefined
}

/**
 * 找出一次工具调用所属的**计数会话**：子会话归并到最近的顶层祖先，整棵委派
 * 树共用一个计数器。
 * @param agent - 事件里的调用方 agent。
 * @param sessions - 会话查找表，缺省时退化为只认调用方自己的会话。
 * @returns 计数用的会话 id，无法判定时返回 undefined。
 */
export function counterSessionIdOf(
  agent: NudgeAgent | undefined,
  sessions?: NudgeSessionLookup,
): string | undefined {
  const own = stringOf(agent?.session?.header?.id) ?? stringOf(agent?.id)
  if (own === undefined) return undefined
  if (sessions === undefined) return own
  let current: string | undefined = own
  let header = agent?.session?.header
  // 血缘深度天然有限；上限只是防一条损坏的日志把这里变成死循环。
  for (let depth = 0; depth < 16 && current !== undefined; depth += 1) {
    const resolved = header ?? sessions.get(current)?.header
    if (resolved === undefined) return current
    const parentId = stringOf(resolved.parentSession)
    if (parentId === undefined) return current
    const parent = sessions.get(parentId)
    if (parent === undefined) return current
    header = parent.header
    current = parentId
  }
  return current
}

/**
 * 会话投影服务里本模块会读的那一个方法：agent-loop 注册的 `turnBoundary`。
 */
export interface TurnBoundaryLookup {
  stateOf(session: unknown, key: 'turnBoundary'):
    | { readonly lastStepStartSeq?: number | null }
    | undefined
}

/**
 * 读一次工具调用所属的「步」标识，用于把同一个模型步里的多条工具结果合并成一轮。
 *
 * 拿不到 turnBoundary（没有 agent-loop，或宿主不是真实会话）时返回 undefined，
 * 调用方退化为按工具结果计数——宁可多计，也不要漏掉催促。
 * @param agent - 事件里的调用方 agent。
 * @param projections - 会话投影服务，可选。
 * @returns 该步的唯一键，或 undefined。
 */
export function stepKeyOf(agent: NudgeAgent | undefined, projections?: TurnBoundaryLookup): string | undefined {
  if (projections === undefined) return undefined
  const session = agent?.session
  if (session === undefined) return undefined
  try {
    const boundary = projections.stateOf(session, 'turnBoundary')
    const seq = boundary?.lastStepStartSeq
    return typeof seq === 'number' ? `step:${seq}` : undefined
  } catch {
    // 投影不存在或已被拆除：退化为按工具结果计数。
    return undefined
  }
}

/**
 * 读一个未知字段为字符串。
 * @param value - 候选值。
 * @returns 字符串，或任何其它类型的 undefined。
 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
