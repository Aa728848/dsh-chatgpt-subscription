/**
 * DeepSeek V4.1 Flash 专属 Append-Only 紧凑状态锚点与 Effort 缓存诊断。
 *
 * ## 设计依据（arXiv:2609.19969）
 *
 * 1. **长链路目标与任务状态重申**：长链路步数累积、上下文跨越 180K/350K/550K/750K
 *    水位线、上下文压缩完成或遭遇工具连败时，在 `agent/pre-step` 尾部 Append-Only
 *    追加一段紧凑状态锚（目标、任务进度、活动文件），不改写前方前缀缓存。
 *    论文中的 `n_win = 128` 是每层 SWA 分支窗口与 Bounded Replay 的重放窗口，
 *    并非提示词长度上限；锚点保持紧凑是减少噪声与 token 开销的工程选择。
 * 2. **Section 5.1.4 `reasoning_effort` 前缀破缓存诊断**：
 *    `Reasoning Effort: {b}` 渲染在 `<|System|>` 最前端，会话中途已有较大上下文
 *    时切换档位会 100% 击穿整段前缀缓存。本模块在检测到长上下文会话中途改档时
 *    记录一条清晰的 `logger.warn`（绝不阻断用户显式操作）。
 *
 * ## 绝对隔离
 *
 * 仅当 `isDeepSeekV41FlashScope(payload.agent, payload.modelSelection)` 为真时激活；
 * 任何其它线路或其它模型直接原样返回 `next()` 结果，零触碰、零状态分配。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/state-anchor
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { isDeepSeekV41Flash, readScopeRoute } from './match.ts'

/** 尾部状态锚的消息来源 kind（本包自有，不冒充真实用户输入）。 */
export const DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND = 'deepseek-v41-flash-anchor'

/** 锚点文本固定开头（也用于检索意图分类器识别并跳过）。 */
export const DEEPSEEK_V41_FLASH_ANCHOR_PREFIX = '[V4.1-Flash State Anchor'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包仅对 DeepSeek V4.1 Flash 在长步/高水位/压缩/连败节点追加的紧凑状态锚。 */
    'deepseek-v41-flash-anchor': { kind: 'deepseek-v41-flash-anchor' } & { form?: 'notice'; summary?: string }
  }
}

/** 同一自主回合每隔多少步追加一次周期状态锚。 */
export const ANCHOR_STEP_INTERVAL = 10

/** 触发上下文水位锚定的估算 token 门槛（对应 CSA2 候选池竞争开始加剧的区间）。 */
export const ANCHOR_CONTEXT_WATERMARKS: readonly number[] = Object.freeze([
  180_000,
  350_000,
  550_000,
  750_000,
])

/** 连续工具失败达到该次数时，立即注入一次防自反馈重试死循环锚点。 */
export const ANCHOR_CONSECUTIVE_ERROR_THRESHOLD = 2

/** 估算上下文达到该阈值后再中途切换 `reasoningEffort`，发出 50x 破缓存诊断告警。 */
export const EFFORT_DRIFT_WARN_MIN_TOKENS = 32_000

/** 总目标摘要最大字符数，保持锚点紧凑（工程预算，非模型硬上限）。 */
const MAX_GOAL_CHARS = 120
/** 整条状态锚最大字符数；超出时依次压缩 FILES、TASKS，ALERT 与 GOAL 始终保留。 */
const MAX_ANCHOR_CHARS = 640
/** 任务状态中单项描述的最大字符数。 */
const MAX_TASK_ITEM_CHARS = 48
/** 状态锚保留的真实用户回合数，兼顾连续任务与旧任务消退。 */
const MAX_GOAL_TURNS = 3
/** 活动文件列表最大条目数。 */
const MAX_ACTIVE_FILES = 4
/** 单个文件名片段最大字符数。 */
const MAX_FILE_LABEL_CHARS = 36

interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

interface AgentLike {
  readonly id?: unknown
  readonly session?: {
    readonly events?: readonly SessionEventLike[]
    snapshotEvents?(): readonly SessionEventLike[]
  }
}

interface PreStepPayloadLike {
  readonly agent?: AgentLike
  readonly messages?: readonly unknown[]
  readonly turn?: unknown
  readonly step?: unknown
  readonly signal?: { readonly aborted?: boolean }
  readonly modelSelection?: unknown
}

interface PreStepDecisionLike {
  readonly kind?: string
  readonly messages?: readonly unknown[]
  readonly [key: string]: unknown
}

interface ToolExecutionLike {
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: unknown
  readonly parent?: unknown
}

interface ToolExecutionResultLike {
  readonly isError?: unknown
}

interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown, options?: unknown): unknown
  off?(name: string, listener: (...args: never[]) => unknown): unknown
  logger?: { warn?(message: string, ...rest: unknown[]): void }
}

interface AnchorSessionState {
  /** 最新一个用户回合的目标（同回合插话已合并，后补充的在后）。 */
  goal: string
  /** 更早回合的目标，仅作参考；有任务清单时不渲染。 */
  earlierGoal: string
  goalTurns: Array<{ turn: number; goal: string }>
  stepsInTurn: number
  lastAnchoredStep: number
  crossedWatermarkIndex: number
  consecutiveToolErrors: number
  lastErrorTool: string | undefined
  errorAnchorPending: boolean
  activeFiles: string[]
  /** 最近一次 `todo_write` 归纳出的紧凑任务进度。 */
  taskLine: string
  /** 上下文压缩完成后，下一步立即重新锚定。 */
  compactionAnchorPending: boolean
  lastEffort: string | undefined
  lastEffortWarnedTransition: string | undefined
  /** 仅当没有原生 token 数据时使用的保守累计字符估算。 */
  observedChars: number
}

export interface StateAnchorOptions {
  /** 活引用读取器；返回 false 时彻底旁路。默认 true。 */
  readonly enabled?: () => boolean
  /** 可选自定义步数周期（测试用，默认 10）。 */
  readonly stepInterval?: number
  /** 可选自定义水位表（测试用）。 */
  readonly contextWatermarks?: readonly number[]
  /** 可选自定义连败阈值（测试用，默认 2）。 */
  readonly consecutiveErrorThreshold?: number
  /** 可选上下文 token 估算覆盖（测试用）。 */
  readonly estimateContextTokens?: (agent: unknown, observedChars: number) => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isEnabled(read: (() => boolean) | undefined): boolean {
  if (read === undefined) return true
  try {
    return read() !== false
  } catch {
    return false
  }
}

function createSessionState(): AnchorSessionState {
  return {
    goal: '',
    earlierGoal: '',
    goalTurns: [],
    stepsInTurn: 0,
    lastAnchoredStep: 0,
    crossedWatermarkIndex: -1,
    consecutiveToolErrors: 0,
    lastErrorTool: undefined,
    errorAnchorPending: false,
    activeFiles: [],
    taskLine: '',
    compactionAnchorPending: false,
    lastEffort: undefined,
    lastEffortWarnedTransition: undefined,
    observedChars: 0,
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
    }
  }
  return parts.join('\n')
}

function isNoticeMessage(message: unknown): boolean {
  if (!isRecord(message)) return true
  if (message['role'] !== 'user') return true
  const source = isRecord(message['source']) ? message['source'] : undefined
  if (source !== undefined) {
    const form = source['form']
    const kind = source['kind']
    if (form === 'notice') return true
    if (typeof kind === 'string' && (
      kind === DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND
      || kind === 'tool'
      || kind === 'runtime-context'
      || kind === 'agent-instructions'
      || kind === 'skill-catalog'
      || kind === 'compact-checkpoint'
      || kind === 'progress-updates-language'
      || kind === 'team-board-notice'
      || kind === 'timeline-cache-notice'
      || kind === 'dsh-chatgpt-subscription'
      || kind === 'minimax-direct-call-reminder'
      || kind === 'minimax-runaway-guard'
    )) {
      return true
    }
  }
  const text = extractTextFromContent(message['content']).trimStart()
  if (text.length === 0) return true
  if (
    text.startsWith('<system-reminder')
    || text.startsWith('Current runtime context.')
    || text.startsWith(DEEPSEEK_V41_FLASH_ANCHOR_PREFIX)
  ) {
    return true
  }
  return false
}

/** 是否为真实用户输入（排除运行时通知、状态锚与插件提醒）。 */
export function isRealUserMessage(message: unknown): boolean {
  return !isNoticeMessage(message)
}

/** 把 `todo_write` 参数归纳成紧凑进度行：完成数/总数、进行中与下一项。 */
export function summarizeTodos(args: unknown): string | undefined {
  if (!isRecord(args) || !Array.isArray(args['todos'])) return undefined
  const todos = args['todos'].filter(isRecord)
  if (todos.length === 0) return ''
  const label = (todo: Record<string, unknown>): string => {
    const text = typeof todo['content'] === 'string' ? todo['content'].replace(/\s+/g, ' ').trim() : ''
    return text.length <= MAX_TASK_ITEM_CHARS ? text : text.slice(0, MAX_TASK_ITEM_CHARS - 3).trimEnd() + '...'
  }
  const done = todos.filter(todo => todo['status'] === 'completed').length
  const now = todos.find(todo => todo['status'] === 'in_progress')
  const pending = todos.find(todo => todo['status'] === 'pending')
  const parts = [`${done}/${todos.length} done`]
  if (now !== undefined && label(now).length > 0) parts.push(`NOW: ${label(now)}`)
  if (pending !== undefined && label(pending).length > 0) parts.push(`NEXT: ${label(pending)}`)
  return parts.join(' | ')
}

/** 把原始用户目标清洗成紧凑的一行摘要，去除附带 reminder。 */
export function compactGoalSummary(raw: string): string {
  const reminderAt = raw.search(/<system-reminder\b|Current runtime context\./)
  const stripped = (reminderAt < 0 ? raw : raw.slice(0, reminderAt))
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= MAX_GOAL_CHARS) return stripped
  return stripped.slice(0, MAX_GOAL_CHARS - 3).trimEnd() + '...'
}

/** 合并用户补充时保留原目标开头和最新消息，避免总长度截断把新约束吃掉。 */
export function mergeGoalUpdate(current: string, update: string): string {
  if (current.length === 0) return compactGoalSummary(update)
  const compactedUpdate = compactGoalSummary(update)
  if (compactedUpdate.length === 0) return current
  const combined = compactGoalSummary(`${current} | ${compactedUpdate}`)
  if (combined.endsWith(compactedUpdate)) return combined

  const suffix = ` | ${compactedUpdate}`
  const prefixBudget = combined.length - suffix.length
  if (prefixBudget < 4) return compactedUpdate
  const prefix = current.slice(0, prefixBudget - 3).trimEnd()
  return prefix.length > 0 ? `${prefix}...${suffix}` : compactedUpdate
}

function findRealUserGoals(messages: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(messages)) return []
  const goals: string[] = []
  for (const message of messages) {
    if (isNoticeMessage(message)) continue
    const text = compactGoalSummary(extractTextFromContent((message as Record<string, unknown>)['content']))
    if (text.length > 0) goals.push(text)
  }
  return goals
}

function shortFileLabel(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').trim()
  if (normalized.length <= MAX_FILE_LABEL_CHARS) return normalized
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    if (tail.length <= MAX_FILE_LABEL_CHARS) return '.../' + tail
  }
  return '...' + normalized.slice(-(MAX_FILE_LABEL_CHARS - 3))
}

function extractTargetFile(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of ['path', 'file_path', 'filePath', 'target', 'file', 'AbsolutePath', 'Path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return shortFileLabel(value)
    }
  }
  return undefined
}

function recordActiveFile(state: AnchorSessionState, file: string): void {
  const existing = state.activeFiles.indexOf(file)
  if (existing >= 0) state.activeFiles.splice(existing, 1)
  state.activeFiles.push(file)
  if (state.activeFiles.length > MAX_ACTIVE_FILES) {
    state.activeFiles.splice(0, state.activeFiles.length - MAX_ACTIVE_FILES)
  }
}

/** 轻量估算会话当前上下文 token 数（零强依赖，跨代安全）。 */
export function defaultEstimateContextTokens(agent: unknown, observedChars: number): number {
  let chars = observedChars
  if (isRecord(agent) && isRecord(agent['session'])) {
    const session = agent['session'] as { events?: readonly SessionEventLike[]; snapshotEvents?: () => readonly SessionEventLike[] }
    let events: readonly SessionEventLike[] | undefined
    if (Array.isArray(session.events)) {
      events = session.events
    } else if (typeof session.snapshotEvents === 'function') {
      try {
        const snap = session.snapshotEvents()
        if (Array.isArray(snap)) events = snap
      } catch {
        events = undefined
      }
    }
    if (events !== undefined && events.length > 0) {
      let eventChars = 0
      for (const event of events) {
        const data = event?.data
        if (!isRecord(data)) continue
        const msg = isRecord(data['message']) ? data['message'] : data
        const content = msg['content']
        if (typeof content === 'string') {
          eventChars += content.length
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue
            if (typeof block['text'] === 'string') eventChars += block['text'].length
            else if (typeof block['arguments'] === 'string') eventChars += block['arguments'].length
          }
        }
      }
      if (eventChars > chars) chars = eventChars
    }
  }
  // 混合代码/中英文保守按 3.5 字符 ≈ 1 token 估算。
  return Math.floor(chars / 3.5)
}

function formatApproxTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** 状态锚触发原因。 */
export type StateAnchorTrigger = 'periodic' | 'watermark' | 'compaction' | 'consecutive-errors'

/**
 * 渲染紧凑状态锚正文，整体不超过 {@link MAX_ANCHOR_CHARS}。
 *
 * 预算优先级：头部、ALERT、GOAL、RULE 始终保留；剩余空间依次给 TASKS、EARLIER，再按新到旧给 FILES。
 * GOAL 只含最新回合；更早回合标注为仅供参考，且有任务清单时由 TASKS 承接连续性而不再渲染。
 */
export function renderStateAnchorText(input: {
  readonly step: number
  readonly approxTokens: number
  readonly reason: StateAnchorTrigger
  readonly goal: string
  readonly earlierGoal?: string | undefined
  readonly tasks?: string | undefined
  readonly activeFiles: readonly string[]
  readonly consecutiveErrors: number
  readonly lastErrorTool?: string | undefined
}): string {
  const header = `${DEEPSEEK_V41_FLASH_ANCHOR_PREFIX} | step=${input.step} | ctx~${formatApproxTokens(input.approxTokens)} | trigger=${input.reason}]`
  const goalLine = input.goal.length > 0 ? `GOAL: ${input.goal}` : undefined
  const toolLabel = input.lastErrorTool ? ` (${input.lastErrorTool})` : ''
  const alertLine = input.reason === 'consecutive-errors'
    ? `ALERT: ${input.consecutiveErrors} consecutive tool failures${toolLabel}. Do NOT retry the same approach; switch to minimal verification or inspect the root definition.`
    : undefined
  const hasTasks = input.tasks !== undefined && input.tasks.length > 0
  const earlier = !hasTasks && input.earlierGoal !== undefined ? input.earlierGoal : ''
  const ruleLine = earlier.length > 0
    ? 'RULE: GOAL is the latest request and later parts override earlier ones; EARLIER is context only and loses on any conflict; verify via tools/PTC instead of long speculation; finish once acceptance criteria pass.'
    : 'RULE: GOAL is the latest request and later parts override earlier ones; verify via tools/PTC instead of long speculation; finish once acceptance criteria pass.'

  const fixed = [header, goalLine, alertLine, ruleLine].filter((line): line is string => line !== undefined)
  let remaining = MAX_ANCHOR_CHARS - fixed.reduce((sum, line) => sum + line.length + 1, 0)

  let tasksLine: string | undefined
  if (input.tasks !== undefined && input.tasks.length > 0) {
    const full = `TASKS: ${input.tasks}`
    if (full.length + 1 <= remaining) tasksLine = full
    else if (remaining - 1 >= 'TASKS: '.length + 8) tasksLine = full.slice(0, remaining - 4).trimEnd() + '...'
    if (tasksLine !== undefined) remaining -= tasksLine.length + 1
  }

  let earlierLine: string | undefined
  if (earlier.length > 0) {
    const prefix = 'EARLIER (context only): '
    const full = `${prefix}${earlier}`
    if (full.length + 1 <= remaining) earlierLine = full
    else if (remaining - 1 >= prefix.length + 8) earlierLine = full.slice(0, remaining - 4).trimEnd() + '...'
    if (earlierLine !== undefined) remaining -= earlierLine.length + 1
  }

  let filesLine: string | undefined
  const kept: string[] = []
  for (let i = input.activeFiles.length - 1; i >= 0; i -= 1) {
    const candidate = `FILES: ${[input.activeFiles[i]!, ...kept].join(', ')}`
    if (candidate.length + 1 > remaining) break
    kept.unshift(input.activeFiles[i]!)
    filesLine = candidate
  }

  const lines = [header]
  if (goalLine !== undefined) lines.push(goalLine)
  if (tasksLine !== undefined) lines.push(tasksLine)
  if (earlierLine !== undefined) lines.push(earlierLine)
  if (filesLine !== undefined) lines.push(filesLine)
  if (alertLine !== undefined) lines.push(alertLine)
  lines.push(ruleLine)
  return lines.join('\n')
}

function createAnchorMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('DeepSeek V4.1 Flash long-horizon state anchor'),
    },
  })
}

function subscribe(
  host: EventHostLike | undefined,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  if (typeof host?.on !== 'function') return undefined
  const attempts: readonly unknown[] = [{ global: true }, undefined]
  for (const options of attempts) {
    try {
      const handle = options === undefined
        ? host.on(event, listener)
        : host.on(event, listener, options)
      if (typeof handle === 'function') return handle as () => void
      if (handle !== null && typeof handle === 'object' && typeof (handle as { dispose?: unknown }).dispose === 'function') {
        return () => { (handle as { dispose(): void }).dispose() }
      }
      return () => {
        try {
          host.off?.(event, listener)
        } catch {
          // 忽略已移除监听。
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 安装仅对 DeepSeek V4.1 Flash 生效的紧凑状态锚点与 Effort 缓存诊断器。
 */
export function installDeepSeekV41FlashStateAnchor(
  ctx: unknown,
  options: StateAnchorOptions = {},
): () => void {
  const host = typeof ctx === 'object' && ctx !== null ? (ctx as EventHostLike) : undefined
  const stepInterval = Math.max(1, options.stepInterval ?? ANCHOR_STEP_INTERVAL)
  const watermarks = options.contextWatermarks ?? ANCHOR_CONTEXT_WATERMARKS
  const errorThreshold = Math.max(1, options.consecutiveErrorThreshold ?? ANCHOR_CONSECUTIVE_ERROR_THRESHOLD)
  const estimateTokens = options.estimateContextTokens ?? defaultEstimateContextTokens

  const states = new WeakMap<object, AnchorSessionState>()
  const statesBySessionId = new Map<string, AnchorSessionState>()
  let disposed = false

  const stateFor = (agent: unknown, sessionId?: string): AnchorSessionState | undefined => {
    if (sessionId !== undefined) {
      let existing = statesBySessionId.get(sessionId)
      if (existing === undefined) {
        existing = createSessionState()
        statesBySessionId.set(sessionId, existing)
      }
      if (typeof agent === 'object' && agent !== null) states.set(agent, existing)
      return existing
    }
    if (typeof agent !== 'object' || agent === null) return undefined
    let existing = states.get(agent)
    if (existing === undefined) {
      existing = createSessionState()
      states.set(agent, existing)
    }
    return existing
  }

  const onPreStep = async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike | undefined>,
  ): Promise<PreStepDecisionLike | undefined> => {
    const decision = await next()
    if (disposed || decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true || !isEnabled(options.enabled)) return decision

    const route = readScopeRoute(payload?.agent, payload?.modelSelection)
    if (!isDeepSeekV41Flash(route.model, route.provider)) return decision

    const state = stateFor(payload?.agent, route.sessionId)
    if (state === undefined) return decision

    const incoming = Array.isArray(decision.messages)
      ? decision.messages
      : Array.isArray(payload?.messages)
        ? payload.messages
        : []

    for (const msg of incoming) {
      if (isRecord(msg)) {
        state.observedChars += extractTextFromContent(msg['content']).length
      }
    }

    const approxTokens = estimateTokens(payload?.agent, state.observedChars)

    // 1. 检测会话中途 reasoningEffort 变动引发的 50x 前缀缓存失效风险（仅告警，不拦截）。
    if (route.reasoningEffort !== undefined) {
      if (
        state.lastEffort !== undefined
        && state.lastEffort !== route.reasoningEffort
        && approxTokens >= EFFORT_DRIFT_WARN_MIN_TOKENS
      ) {
        const transition = `${state.lastEffort}->${route.reasoningEffort}`
        if (state.lastEffortWarnedTransition !== transition) {
          state.lastEffortWarnedTransition = transition
          try {
            host?.logger?.warn?.(
              `[dsh-chatgpt-subscription] DeepSeek V4.1 Flash reasoningEffort changed (${transition}) `
              + `at ~${formatApproxTokens(approxTokens)} context tokens`
              + (route.sessionId ? ` (session ${route.sessionId})` : '')
              + '; changing effort mid-session rewrites the leading system prefix and invalidates the 50x KV prefix cache. '
              + 'Keep reasoningEffort static within one long session and route lower/higher effort work to subagents.',
            )
          } catch {
            // 日志失败不影响主流程。
          }
        }
      }
      state.lastEffort = route.reasoningEffort
    }

    // 2. 同回合插话合并；新回合保留最近三个真实用户目标，最新消息优先避让截断。
    const currentTurn = typeof payload?.turn === 'number' ? payload.turn : undefined
    const newGoals = findRealUserGoals(incoming)
    if (newGoals.length > 0) {
      const incomingGoal = newGoals.reduce(mergeGoalUpdate, '')
      if (currentTurn === undefined) {
        state.goalTurns = [{ turn: 0, goal: incomingGoal }]
      } else {
        const existing = state.goalTurns.find(entry => entry.turn === currentTurn)
        if (existing === undefined) state.goalTurns.push({ turn: currentTurn, goal: incomingGoal })
        else existing.goal = mergeGoalUpdate(existing.goal, incomingGoal)
        if (state.goalTurns.length > MAX_GOAL_TURNS) {
          state.goalTurns.splice(0, state.goalTurns.length - MAX_GOAL_TURNS)
        }
      }
      // 最新回合才是当前指令；更早回合只作参考，避免被否定或无关的旧命令盖过新命令。
      state.goal = state.goalTurns[state.goalTurns.length - 1]?.goal ?? incomingGoal
      state.earlierGoal = state.goalTurns.slice(0, -1).reduce((goal, entry) => mergeGoalUpdate(goal, entry.goal), '')
      state.stepsInTurn = 0
      state.lastAnchoredStep = 0
      state.consecutiveToolErrors = 0
      state.lastErrorTool = undefined
      state.errorAnchorPending = false
      return decision
    }

    state.stepsInTurn += 1

    // 若之前尚未捕获目标（例如中途接管会话），从历史事件补抓最近一条真实用户目标。
    if (state.goal.length === 0 && isRecord(payload?.agent) && isRecord(payload.agent.session)) {
      const session = payload.agent.session
      let events: readonly SessionEventLike[] | undefined
      if (Array.isArray(session.events)) events = session.events
      else if (typeof session.snapshotEvents === 'function') {
        try { events = session.snapshotEvents() } catch { events = undefined }
      }
      if (events !== undefined) {
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const ev = events[i]
          if (ev?.type !== 'user/message' || !isRecord(ev.data)) continue
          const msg = isRecord(ev.data['message']) ? ev.data['message'] : { role: 'user', content: ev.data['content'] ?? ev.data['text'] }
          if (isNoticeMessage(msg)) continue
          const recovered = compactGoalSummary(extractTextFromContent(msg['content']))
          if (recovered.length > 0) {
            state.goal = recovered
            state.earlierGoal = ''
            state.goalTurns = [{ turn: currentTurn ?? 0, goal: recovered }]
            break
          }
        }
      }
    }

    // 3. 检查三大克制触发条件（优先级：连败防卡死 > 水位首次跨越 > 步数周期）。
    let trigger: StateAnchorTrigger | undefined
    let nextWatermarkIndex = state.crossedWatermarkIndex
    for (let i = state.crossedWatermarkIndex + 1; i < watermarks.length; i += 1) {
      if (approxTokens >= watermarks[i]!) nextWatermarkIndex = i
    }

    if (state.errorAnchorPending && state.consecutiveToolErrors >= errorThreshold) {
      trigger = 'consecutive-errors'
      state.errorAnchorPending = false
    } else if (state.compactionAnchorPending) {
      trigger = 'compaction'
      state.compactionAnchorPending = false
      if (nextWatermarkIndex > state.crossedWatermarkIndex) state.crossedWatermarkIndex = nextWatermarkIndex
    } else if (nextWatermarkIndex > state.crossedWatermarkIndex) {
      trigger = 'watermark'
      state.crossedWatermarkIndex = nextWatermarkIndex
    } else if (
      state.stepsInTurn >= stepInterval
      && state.stepsInTurn - state.lastAnchoredStep >= stepInterval
    ) {
      trigger = 'periodic'
    }

    if (trigger === undefined) return decision

    // 避免同一条消息列表已被其它路径加过锚点。
    if (incoming.some(msg => isRecord(msg) && isRecord(msg['source']) && msg['source']['kind'] === DEEPSEEK_V41_FLASH_ANCHOR_SOURCE_KIND)) {
      return decision
    }

    state.lastAnchoredStep = state.stepsInTurn
    const text = renderStateAnchorText({
      step: state.stepsInTurn,
      approxTokens,
      reason: trigger,
      goal: state.goal,
      earlierGoal: state.earlierGoal,
      tasks: state.taskLine,
      activeFiles: state.activeFiles,
      consecutiveErrors: state.consecutiveToolErrors,
      lastErrorTool: state.lastErrorTool,
    })
    const existingMessages = Array.isArray(decision.messages) ? decision.messages : []
    return {
      ...decision,
      messages: [...existingMessages, createAnchorMessage(text)],
    }
  }

  const onPostExecute = async (
    exec: ToolExecutionLike,
    result: ToolExecutionResultLike,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const decision = await next()
    if (disposed || !isEnabled(options.enabled)) return decision
    const route = readScopeRoute(exec?.agent)
    if (!isDeepSeekV41Flash(route.model, route.provider)) return decision

    const state = stateFor(exec?.agent, route.sessionId)
    if (state === undefined) return decision

    // Code Mode 中 todo_write 以嵌套调用出现，任务进度同样需要采集。
    const failed = result?.isError === true || (isRecord(decision) && decision['kind'] === 'block')
    if (!failed && exec?.name === 'todo_write') {
      const tasks = summarizeTodos(exec.arguments)
      if (tasks !== undefined) state.taskLine = tasks
    }
    if (exec?.parent !== undefined) return decision

    const targetFile = extractTargetFile(exec?.arguments)
    if (targetFile !== undefined) recordActiveFile(state, targetFile)

    if (failed) {
      state.consecutiveToolErrors += 1
      state.lastErrorTool = typeof exec?.name === 'string' ? exec.name : undefined
      if (state.consecutiveToolErrors >= errorThreshold) {
        state.errorAnchorPending = true
      }
    } else {
      state.consecutiveToolErrors = 0
      state.lastErrorTool = undefined
      state.errorAnchorPending = false
    }
    return decision
  }

  const onDisposed = (payload: { readonly agent?: unknown } | undefined): void => {
    const route = readScopeRoute(payload?.agent)
    if (route.sessionId !== undefined) statesBySessionId.delete(route.sessionId)
  }

  // 压缩完成后历史被摘要替换，下一步立即重申目标与任务状态。
  const onSessionEvent = (session: { readonly id?: unknown } | undefined, event: { readonly type?: unknown } | undefined): void => {
    if (disposed || event?.type !== 'compaction/end') return
    const id = session?.id
    if (typeof id !== 'string') return
    const state = statesBySessionId.get(id)
    if (state !== undefined) state.compactionAnchorPending = true
  }

  const offPreStep = subscribe(host, 'agent/pre-step', onPreStep as never)
  const offPostExec = subscribe(host, 'tools/post-execute', onPostExecute as never)
  const offDisposed = subscribe(host, 'agent/disposed', onDisposed as never)
  const offSessionEvent = subscribe(host, 'session/event', onSessionEvent as never)

  return () => {
    if (disposed) return
    disposed = true
    for (const off of [offPreStep, offPostExec, offDisposed, offSessionEvent]) {
      try {
        off?.()
      } catch {
        // 忽略单点卸载异常。
      }
    }
    statesBySessionId.clear()
  }
}
