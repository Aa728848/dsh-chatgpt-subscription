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

export interface ExactRepeatBreakerOptions {
  /** Reminder for a completed execution; undefined leaves the decision untouched. */
  readonly reminder: (count: number) => string | undefined
  /** Optional execution veto once the same call reaches this count. */
  readonly forceStopAt?: number
  readonly handoffReminder?: string
  readonly handoffVeto?: string
  readonly exemptTools?: readonly string[]
  /** Bound on remembered sessions; least-recently-written is evicted first. */
  readonly maxSessions?: number
}

export interface ExactRepeatBreaker {
  checkBeforeExecute(sessionId: string, toolName: string, args: unknown): string | undefined
  recordAfterExecute(sessionId: string, toolName: string, args: unknown): string | undefined
  resetSession(sessionId: string): void
}

interface RepeatState {
  tracker: ExactRepeatTracker
  count: number
  handoffActive: boolean
}

/**
 * Exact-repeat state machine shared by provider profiles. A missing forceStopAt
 * gives reminders only; no provider inherits Kimi's hard stop accidentally.
 */
export function createExactRepeatBreaker(options: ExactRepeatBreakerOptions): ExactRepeatBreaker {
  const sessions = new Map<string, RepeatState>()
  const maxSessions = options.maxSessions ?? 256
  const exempt = new Set(options.exemptTools ?? TOOL_RUNAWAY_EXEMPT_TOOLS)
  const stateOf = (sessionId: string): RepeatState => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { tracker: createExactRepeatTracker(), count: 0, handoffActive: false }
    }
    sessions.delete(sessionId)
    sessions.set(sessionId, state)
    if (sessions.size > maxSessions) {
      const oldest = sessions.keys().next()
      if (oldest.done !== true) sessions.delete(oldest.value)
    }
    return state
  }
  return {
    checkBeforeExecute(sessionId, toolName, args) {
      if (options.forceStopAt === undefined) return undefined
      const state = stateOf(sessionId)
      if (state.handoffActive) return options.handoffVeto ?? options.handoffReminder
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
    recordAfterExecute(sessionId, toolName, args) {
      if (exempt.has(toolName)) return undefined
      const state = stateOf(sessionId)
      if (state.handoffActive) return options.handoffReminder ?? options.reminder(state.count)
      state.count = state.tracker.observe(toolName, args).count
      if (options.forceStopAt !== undefined && state.count >= options.forceStopAt) {
        state.handoffActive = true
        return options.handoffReminder ?? options.reminder(state.count)
      }
      return options.reminder(state.count)
    },
    resetSession(sessionId) { sessions.delete(sessionId) },
  }
}
