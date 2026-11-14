/**
 * Provider-neutral tool-call repetition primitives.
 *
 * The detector knows nothing about model wire formats. Providers supply reminder
 * text and may opt into a hard handoff threshold; coordination tools are exempt
 * because they are expected to recur while real work continues.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortJsonValue(value[key])
  return out
}

/** Stable identity for one tool call, independent of object key order. */
export function canonicalToolCallKey(toolName: string, args: unknown): string {
  let json: string | undefined
  try {
    json = JSON.stringify(sortJsonValue(args))
  } catch {
    json = undefined
  }
  return toolName + ' ' + (json ?? String(args))
}

export interface ExactRepeatObservation {
  readonly key: string
  readonly count: number
}

export interface ExactRepeatTracker {
  observe(toolName: string, args: unknown): ExactRepeatObservation
  current(): ExactRepeatObservation | undefined
  reset(): void
}

/** One immediately-repeated action streak. A different action starts at one. */
export function createExactRepeatTracker(): ExactRepeatTracker {
  let current: ExactRepeatObservation | undefined
  return {
    observe(toolName, args) {
      const key = canonicalToolCallKey(toolName, args)
      current = {
        key,
        count: current?.key === key ? current.count + 1 : 1,
      }
      return current
    },
    current() { return current },
    reset() { current = undefined },
  }
}

/** Coordination calls that must not break or inflate an action streak. */
export const TOOL_RUNAWAY_EXEMPT_TOOLS: readonly string[] = Object.freeze([
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

export function isToolRunawayExemptTool(toolName: string): boolean {
  return TOOL_RUNAWAY_EXEMPT_TOOLS.includes(toolName)
}

export interface ToolRunawayGuardConfig {
  readonly toolRunawayGuard?: boolean | { get(): boolean | undefined }
}

/** Read the live global switch; legacy Kimi-only installs without it stay on. */
export function resolveToolRunawayGuardEnabled(config?: ToolRunawayGuardConfig): boolean {
  const field = config?.toolRunawayGuard
  if (field !== null && typeof field === 'object') {
    try { return field.get() !== false } catch { return true }
  }
  return field !== false
}

/** 失控守卫能识别的信号。 */
export type ToolRunawaySignalKind =
  | 'exact_action_repeat'
  | 'same_error_family'
  | 'polling_repeat'
  | 'abab_action_cycle'

/** 一次工具执行的可观察事实。 */
export interface ToolRunawayObservation {
  /** 工具名。 */
  readonly toolName: string
  /** 已解析的参数。 */
  readonly arguments?: unknown
  /** 这次执行是否失败。 */
  readonly isError?: boolean
  /** 工具自己报的结构化错误码。 */
  readonly errorCode?: string
  /** 失败文本。 */
  readonly errorText?: string
  /** 成功结果文本（轮询判定用）。 */
  readonly resultText?: string
}

/** 一条要注入模型的提醒。 */
export interface ToolRunawayReminder {
  /** 信号种类。 */
  readonly kind: ToolRunawaySignalKind
  /** 连击次数。 */
  readonly occurrences: number
  /** 提醒正文。 */
  readonly text: string
}

/** 守卫观察到的一次信号。 */
export interface ToolRunawaySignal {
  /** 信号种类。 */
  readonly kind: ToolRunawaySignalKind
  /** 连击次数。 */
  readonly occurrences: number
  /** 涉及的工具名。 */
  readonly toolName: string
}

/** 工具级失控守卫。 */
export interface ToolRunawayGuard {
  /**
   * 观察一次工具执行。
   * @param observation - 这一次执行的可观察事实。
   * @returns 要注入的提醒（每轮至多一条），没有时为 undefined。
   */
  observe(observation: ToolRunawayObservation): ToolRunawayReminder | undefined
  /** 清空连击计数与「本轮已提醒」标记（新的一轮用户输入 / agent 拆除时调用）。 */
  reset(): void
  /** 到目前为止观察到的信号。 */
  readonly signals: readonly ToolRunawaySignal[]
}

/** 失控守卫选项。 */
export interface ToolRunawayGuardOptions {
  /** 连击多少次才提醒（默认 3）。 */
  readonly remindAfterOccurrences?: number
}

/** 失控守卫的默认连击阈值：第三次重复/同族报错/不变轮询时给出提醒。 */
export const DEFAULT_REMIND_AFTER_OCCURRENCES = 3

/** 轮询类工具名（后台任务的结果读取）。 */
export const POLLING_TOOL_NAMES: readonly string[] = Object.freeze(['job_output', 'task_output'])

const TURN_ONLY_SUFFIX =
  ' This is a temporary runtime reminder for the current Turn only, not a user preference or a durable rule; do not save this reminder or generalize it into Memory, Skills, or other persistent instruction files for future Turns or sessions.'

/** 渲染「同一个动作立刻重复」提醒。 */
export function renderExactActionRepeatReminder(occurrences: number): string {
  return `[runaway guard] The immediately repeated tool action has now occurred ${occurrences} times with the same arguments. Do not repeat it unchanged. Inspect the results already available, then either change strategy with a concrete expected state change, or report the blocker. Repetition alone does not establish that the task is complete or impossible.${TURN_ONLY_SUFFIX}`
}

/** 渲染「同一族错误连续发生」提醒。 */
export function renderSameErrorFamilyReminder(occurrences: number): string {
  return `[runaway guard] The same tool error family has now occurred ${occurrences} times in a row. Do not retry the same route unchanged. Diagnose the cause, change one controlled variable or switch route. Do not infer that the entire task has failed from this signal.${TURN_ONLY_SUFFIX}`
}

/** 渲染「反复轮询同一个后台任务」提醒。 */
export function renderPollingRepeatReminder(occurrences: number): string {
  const count = occurrences === 3 ? 'Three' : String(occurrences)
  return [
    '<system-reminder>',
    `${count} task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.`,
    'This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.',
    '</system-reminder>',
  ].join('\n')
}

/** 规范化错误文本，去掉会漂移的数字/id/时间戳，取它的「族」。 */
export function normalizeToolErrorFamily(text: string | undefined): string {
  if (text === undefined || text === '') return 'unknown'
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.replace(/\d+/g, '#').slice(0, 200)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 判断一次工具执行结果是否失败。 */
export function isToolErrorResult(result: unknown): boolean {
  return isRecord(result) && result['isError'] === true
}

/** 读一次工具执行结果里的结构化错误码。 */
export function toolErrorCodeOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const error = result['error']
  if (!isRecord(error)) return undefined
  const info = error['info']
  if (isRecord(info)) {
    const infoCode = nonEmptyString(info['code'])
    if (infoCode !== undefined) return infoCode
  }
  return nonEmptyString(error['code'])
}

/** 读一次工具执行结果里的全部文本块。 */
export function toolResultTextOf(result: unknown): string {
  if (!isRecord(result)) return ''
  const content = result['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text') parts.push(nonEmptyString(block['text']) ?? '')
  }
  return parts.join('\n')
}

/** 读一次工具执行结果里的失败文本（无 `error.message` 且为错误结果时回退读取文本内容）。 */
export function toolErrorTextOf(result: unknown): string | undefined {
  if (isRecord(result)) {
    const error = result['error']
    if (isRecord(error)) {
      const msg = nonEmptyString(error['message'])
      if (msg !== undefined) return msg
    }
  }
  if (!isToolErrorResult(result)) return undefined
  const text = toolResultTextOf(result)
  return text === '' ? undefined : text
}

/** 从一次工具执行与结果中构造失控检测观察量。 */
export function observationFromToolExecution(
  toolName: string,
  args: unknown,
  result?: unknown,
): ToolRunawayObservation {
  return {
    toolName,
    arguments: args,
    isError: isToolErrorResult(result),
    errorCode: toolErrorCodeOf(result),
    errorText: toolErrorTextOf(result),
    resultText: toolResultTextOf(result),
  }
}

function isPollingObservation(toolName: string, args: unknown): boolean {
  if (!POLLING_TOOL_NAMES.includes(toolName)) return false
  const record = isPlainRecord(args) ? args : undefined
  // wait=true 是「等它结束」，不是空轮询；它打断轮询连击。
  return record?.['wait'] !== true
}

/**
 * 造一台单会话工具级失控守卫。
 *
 * 三种可提醒信号（顺序即提醒优先级）：
 * 1. `same_error_family` —— 同一个工具连续报同一族错误；
 * 2. `exact_action_repeat` —— 同一次动作（同名 + 同参数）立刻重复；
 * 3. `polling_repeat` —— 连续轮询同一个后台任务而输出没变。
 */
export function createToolRunawayGuard(options: ToolRunawayGuardOptions = {}): ToolRunawayGuard {
  const threshold = options.remindAfterOccurrences ?? DEFAULT_REMIND_AFTER_OCCURRENCES

  const exactActionRepeats = createExactRepeatTracker()
  const errorStreaks = new Map<string, { toolName: string; count: number }>()
  const pollingStreaks = new Map<string, { key: string; count: number }>()
  const recentActions: string[] = []
  let activeAbabKey: string | undefined
  let reminderAttempted = false
  const signals: ToolRunawaySignal[] = []

  const record = (kind: ToolRunawaySignalKind, occurrences: number, toolName: string): void => {
    signals.push({ kind, occurrences, toolName })
  }

  return {
    observe(observation: ToolRunawayObservation): ToolRunawayReminder | undefined {
      const toolName = observation.toolName
      const actionKey = canonicalToolCallKey(toolName, observation.arguments)
      const countsAsAction = !POLLING_TOOL_NAMES.includes(toolName)

      if (countsAsAction) {
        const action = exactActionRepeats.observe(toolName, observation.arguments)
        record('exact_action_repeat', action.count, toolName)
      }

      if (countsAsAction) {
        recentActions.push(actionKey)
        if (recentActions.length > 4) recentActions.shift()
        if (recentActions.length === 4) {
          const [a, b, c, d] = recentActions
          if (a !== undefined && b !== undefined && a !== b && a === c && b === d) {
            const episode = `${a}\u0000${b}`
            if (activeAbabKey !== episode) {
              activeAbabKey = episode
              record('abab_action_cycle', 2, toolName)
            }
          } else {
            activeAbabKey = undefined
          }
        }
      }

      if (observation.isError === true) {
        const family = observation.errorCode ?? normalizeToolErrorFamily(observation.errorText)
        const key = `${toolName}\u0000${family}`
        const previous = errorStreaks.get(key)
        const count = previous === undefined ? 1 : previous.count + 1
        errorStreaks.set(key, { toolName, count })
        record('same_error_family', count, toolName)
      } else {
        for (const [key, entry] of [...errorStreaks]) {
          if (entry.toolName === toolName) errorStreaks.delete(key)
        }
      }

      if (isPollingObservation(toolName, observation.arguments)) {
        const key = `${canonicalToolCallKey(toolName, observation.arguments)}\u0000${observation.resultText ?? ''}`
        const previous = pollingStreaks.get(toolName)
        const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1
        pollingStreaks.set(toolName, { key, count })
        record('polling_repeat', count, toolName)
      } else {
        pollingStreaks.delete(toolName)
      }

      if (reminderAttempted) return undefined

      const errorCandidate = [...errorStreaks.values()].find(entry => entry.count >= threshold)
      if (errorCandidate !== undefined) {
        reminderAttempted = true
        return {
          kind: 'same_error_family',
          occurrences: errorCandidate.count,
          text: renderSameErrorFamilyReminder(errorCandidate.count),
        }
      }
      const actionStreak = exactActionRepeats.current()
      if (countsAsAction && actionStreak !== undefined && actionStreak.count >= threshold) {
        reminderAttempted = true
        return {
          kind: 'exact_action_repeat',
          occurrences: actionStreak.count,
          text: renderExactActionRepeatReminder(actionStreak.count),
        }
      }
      const pollingCandidate = [...pollingStreaks.values()].find(entry => entry.count >= threshold)
      if (pollingCandidate !== undefined) {
        reminderAttempted = true
        return {
          kind: 'polling_repeat',
          occurrences: pollingCandidate.count,
          text: renderPollingRepeatReminder(pollingCandidate.count),
        }
      }
      return undefined
    },
    reset(): void {
      exactActionRepeats.reset()
      errorStreaks.clear()
      pollingStreaks.clear()
      recentActions.length = 0
      activeAbabKey = undefined
      reminderAttempted = false
    },
    get signals(): readonly ToolRunawaySignal[] {
      return signals
    },
  }
}

export interface ExactRepeatBreakerOptions {
  /** Reminder for a completed execution; undefined leaves the decision untouched. */
  readonly reminder: (count: number) => string | undefined
  /** Optional execution veto once the same call reaches this count. */
  readonly forceStopAt?: number
  /** Threshold for `same_error_family` and `polling_repeat` reminders; defaults to 3. */
  readonly errorAndPollingThreshold?: number
  readonly handoffReminder?: string
  readonly handoffVeto?: string
  readonly exemptTools?: readonly string[]
  /** Bound on remembered sessions; least-recently-written is evicted first. */
  readonly maxSessions?: number
}

export type ExactRepeatExecutionObservation = Omit<ToolRunawayObservation, 'toolName' | 'arguments'>

export interface ExactRepeatBreaker {
  checkBeforeExecute(sessionId: string, toolName: string, args: unknown): string | undefined
  recordAfterExecute(
    sessionId: string,
    toolName: string,
    args: unknown,
    observation?: ExactRepeatExecutionObservation,
  ): string | undefined
  resetSession(sessionId: string): void
}

interface RepeatState {
  tracker: ExactRepeatTracker
  count: number
  handoffActive: boolean
  errorStreaks: Map<string, { toolName: string; count: number }>
  pollingStreaks: Map<string, { key: string; count: number }>
}

/**
 * Exact-repeat + deterministic zero-progress (same error family / unchanged polling)
 * state machine shared by provider profiles. A missing forceStopAt gives reminders only;
 * no provider inherits Kimi's hard stop accidentally.
 */
export function createExactRepeatBreaker(options: ExactRepeatBreakerOptions): ExactRepeatBreaker {
  const sessions = new Map<string, RepeatState>()
  const maxSessions = options.maxSessions ?? 256
  const exempt = new Set(options.exemptTools ?? TOOL_RUNAWAY_EXEMPT_TOOLS)
  const errorAndPollingThreshold = options.errorAndPollingThreshold ?? DEFAULT_REMIND_AFTER_OCCURRENCES
  const stateOf = (sessionId: string): RepeatState => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        tracker: createExactRepeatTracker(),
        count: 0,
        handoffActive: false,
        errorStreaks: new Map(),
        pollingStreaks: new Map(),
      }
    }
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next()
      if (oldest.done !== true) sessions.delete(oldest.value)
    }
    return state
  }
  const updateErrorStreaks = (
    state: RepeatState,
    toolName: string,
    observation: ExactRepeatExecutionObservation,
  ): number => {
    if (observation.isError === true) {
      const family = observation.errorCode ?? normalizeToolErrorFamily(observation.errorText)
      const key = `${toolName}\u0000${family}`
      const previous = state.errorStreaks.get(key)
      const count = previous === undefined ? 1 : previous.count + 1
      state.errorStreaks.set(key, { toolName, count })
      return count
    }
    for (const [key, entry] of [...state.errorStreaks]) {
      if (entry.toolName === toolName) state.errorStreaks.delete(key)
    }
    return 0
  }
  return {
    checkBeforeExecute(sessionId, toolName, args) {
      if (options.forceStopAt === undefined) return undefined
      const state = stateOf(sessionId)
      if (state.handoffActive) return options.handoffVeto ?? options.handoffReminder
      // 后台任务输出读取不进同参连击与强停；正常递增输出或 wait=true 不该被误拦。
      if (POLLING_TOOL_NAMES.includes(toolName)) return undefined
      const key = canonicalToolCallKey(toolName, args)
      // A pre-execute check must not advance the streak. It only recognises that
      // the next occurrence of the CURRENT key reaches the veto boundary.
      if (state.tracker.current()?.key === key && state.count + 1 >= options.forceStopAt) {
        state.count += 1
        state.handoffActive = true
        return options.handoffVeto ?? options.handoffReminder
      }
      return undefined
    },
    recordAfterExecute(sessionId, toolName, args, observation) {
      if (exempt.has(toolName)) return undefined
      const state = stateOf(sessionId)
      if (state.handoffActive) return options.handoffReminder ?? options.reminder(state.count)

      if (POLLING_TOOL_NAMES.includes(toolName) && observation !== undefined) {
        const errorCount = updateErrorStreaks(state, toolName, observation)
        const isPolling = isPollingObservation(toolName, args)
        let pollCount = 0
        if (isPolling) {
          const key = `${canonicalToolCallKey(toolName, args)}\u0000${observation.resultText ?? ''}`
          const previous = state.pollingStreaks.get(toolName)
          pollCount = previous !== undefined && previous.key === key ? previous.count + 1 : 1
          state.pollingStreaks.set(toolName, { key, count: pollCount })
        } else {
          state.pollingStreaks.delete(toolName)
        }
        if (observation.isError === true && errorCount >= errorAndPollingThreshold) {
          return renderSameErrorFamilyReminder(errorCount)
        }
        if (isPolling && pollCount >= errorAndPollingThreshold) {
          return renderPollingRepeatReminder(pollCount)
        }
        return undefined
      }

      if (!POLLING_TOOL_NAMES.includes(toolName)) {
        state.pollingStreaks.clear()
      }

      state.count = state.tracker.observe(toolName, args).count
      if (options.forceStopAt !== undefined && state.count >= options.forceStopAt) {
        state.handoffActive = true
        return options.handoffReminder ?? options.reminder(state.count)
      }

      const errorCount = observation !== undefined ? updateErrorStreaks(state, toolName, observation) : 0
      const exactReminder = options.reminder(state.count)
      if (exactReminder !== undefined) return exactReminder
      if (errorCount >= errorAndPollingThreshold) return renderSameErrorFamilyReminder(errorCount)
      return undefined
    },
    resetSession(sessionId) { sessions.delete(sessionId) },
  }
}
