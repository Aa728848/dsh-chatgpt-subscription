/**
 * 直接检索工具的导航意图判定。
 *
 * 只有最新一条真实用户消息明确表达定位/列举/搜索意图，且没有编辑、审查、
 * 验证或全量审计要求时才返回 true。读不到事件、文本为空或意图冲突一律 false。
 * 这层刻意保守：它宁可让检索投影不生效，也不把需要完整源码的任务压成大纲。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/retrieval-intent
 */

/** 新独立开关覆盖的工具；其它工具仍走原有 cacheWarmup 路径。 */
export const CACHE_WARMUP_RETRIEVAL_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'web_fetch',
  'grep',
  'glob',
])

interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

interface RetrievalAgentLike {
  readonly session?: {
    readonly events?: readonly SessionEventLike[]
    snapshotEvents?(): readonly SessionEventLike[]
  }
}

/** 编辑、审查、验证与全量诉求优先于导航词：出现即保留原文。 */
const SOURCE_WORK_INTENT = /(?:实现|修改|修复|编辑|重构|审查|评审|审计|检查|核对|验证|测试|诊断|全量|完整检查|fix|implement|edit|refactor|review|audit|verify|test|change|update|write|patch|diagnose)/i

/** 明确的导航/列举诉求；普通“读取”“了解”“解释”不足以触发投影。 */
const NAVIGATION_INTENT = /(?:定位|查找|搜索|列出|有哪些|哪里|何处|概览|导航|近期更新|locate|find|list|where|overview|search)/i

function eventsOf(agent: unknown): readonly SessionEventLike[] {
  const session = (typeof agent === 'object' && agent !== null
    ? agent as RetrievalAgentLike
    : undefined)?.session
  if (session === undefined) return []
  if (Array.isArray(session.events)) return session.events
  try {
    const events = session.snapshotEvents?.()
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/** 从用户事件已知的几种文本形状中取正文；其它字段不递归，避免把参数当意图。 */
function messageText(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) {
    return data.map((entry) => messageText(entry)).filter((entry) => entry !== '').join('\n')
  }
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  const direct = record.text
  if (typeof direct === 'string') return direct
  const content = record.content
  if (typeof content === 'string' || Array.isArray(content)) return messageText(content)
  const message = record.message
  if (message !== undefined && message !== data) return messageText(message)
  return ''
}

/**
 * 最新用户消息是否明确属于导航任务。
 * @param agent - 工具执行事件里的 agent。
 * @returns 只有明确导航且无源码工作信号时为 true。
 */
export function cacheWarmupNavigationIntentOf(agent: unknown): boolean {
  const events = eventsOf(agent)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'user/message') continue
    const rawText = messageText(event.data)
    // DSH 可能在真实用户请求后附系统提醒、运行时上下文与仓库指引；这些不是意图。
    const reminderAt = rawText.search(/<system-reminder\b|Current runtime context\./)
    const text = (reminderAt < 0 ? rawText : rawText.slice(0, reminderAt)).trim()
    // DSH 会在真实请求后追加 reminder-only 的 user/message；跳过它继续向前找。
    if (text === '') continue
    if (SOURCE_WORK_INTENT.test(text)) return false
    return NAVIGATION_INTENT.test(text)
  }
  return false
}
