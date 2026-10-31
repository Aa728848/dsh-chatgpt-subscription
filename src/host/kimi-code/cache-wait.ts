import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'
import { CACHE_TTL_MS, MIN_TOKENS_TO_HINT, sessionLastActiveAt } from './cache-hint.ts'
import { sessionCacheState } from './session-cache-state.ts'

/** When an idle parent reaches its cache decision point (five minutes before TTL). */
export const CACHE_WAIT_DECISION_MS = 20 * 60 * 1000
/** Opt-in switch for one bounded warmup during a delegation batch. */
export const CACHE_WAIT_WARMUP_ENV = 'DSH_KIMI_CODE_CACHE_WAIT_WARMUP'
const MAX_TRACKED_SESSIONS = 256

export interface CacheWaitSession {
  readonly id: string
  requestHeader?(): { readonly config?: { readonly provider?: unknown } | undefined } | undefined
}

export interface CacheWaitEvent {
  readonly type?: unknown
  readonly data?: unknown
}

export interface CacheWaitAgent {
  readonly id?: unknown
  steer?(message: unknown): void
}

export interface CacheWaitActivity {
  readonly lastActiveAt?: number
  readonly totalTokens?: number
}

export interface CacheWaitTimer {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface CacheWaitAgents {
  get(id: unknown): CacheWaitAgent | undefined
}

export interface CacheWaitLogger {
  info?(message: string): void
  warn(message: string): void
}

export interface CacheWaitOptions {
  /** Allow one opt-in warmup for a large context. Disabled by default. */
  readonly warmup?: boolean
  readonly now?: () => number
  readonly timer?: CacheWaitTimer
  readonly agents?: CacheWaitAgents
  readonly activity?: (sessionId: string) => CacheWaitActivity | undefined
  readonly kimiSession?: (session: CacheWaitSession) => boolean
  readonly logger?: CacheWaitLogger
  readonly decisionMs?: number
  readonly ttlMs?: number
  readonly minWarmupTokens?: number
}

export interface CacheWaitEvaluation {
  readonly waiting: boolean
  readonly hasChildren: boolean
  readonly now: number
  readonly lastActiveAt?: number
  readonly totalTokens?: number
  readonly warmupEnabled: boolean
  readonly warmupUsed: boolean
  readonly decisionMs?: number
  readonly ttlMs?: number
  readonly minWarmupTokens?: number
}

export type CacheWaitAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'cold' }
  | { readonly kind: 'warmup' }
  | { readonly kind: 'schedule'; readonly delayMs: number }

/** Pure cache-wait policy; no child deadline or forced progress is involved. */
export function evaluateCacheWait(input: CacheWaitEvaluation): CacheWaitAction {
  if (!input.waiting || !input.hasChildren || input.lastActiveAt === undefined) return { kind: 'none' }
  if (!Number.isFinite(input.lastActiveAt) || !Number.isFinite(input.now)) return { kind: 'none' }
  const decisionMs = input.decisionMs ?? CACHE_WAIT_DECISION_MS
  const ttlMs = input.ttlMs ?? CACHE_TTL_MS
  const minWarmupTokens = input.minWarmupTokens ?? MIN_TOKENS_TO_HINT
  const idleMs = Math.max(0, input.now - input.lastActiveAt)
  if (idleMs >= ttlMs) return { kind: 'cold' }
  if (idleMs < decisionMs) return { kind: 'schedule', delayMs: decisionMs - idleMs }
  if (
    input.warmupEnabled
    && !input.warmupUsed
    && input.totalTokens !== undefined
    && Number.isFinite(input.totalTokens)
    && input.totalTokens >= minWarmupTokens
  ) return { kind: 'warmup' }
  return { kind: 'cold' }
}

/** The one opt-in message, built through the generation-safe harness factory. */
export function createCacheWaitWarmupMessage(): unknown {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'Automatic cache maintenance while delegated work continues. This is not a new task and must not change priorities or cause tool calls. Reply with one brief acknowledgment, then continue waiting for existing results. Do not request or manufacture progress from any subagent.',
    }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('Cache maintenance only; delegated work continues unchanged.'),
    },
  })
}

/** Whether the deployment explicitly opted into bounded warmup. */
export function cacheWaitWarmupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[CACHE_WAIT_WARMUP_ENV]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

interface WaitState {
  readonly children: Set<string>
  waiting: boolean
  handled: boolean
  warmupUsed: boolean
  timer?: unknown
  lastDecision?: 'cold' | 'warmup'
}

export interface CacheWaitSnapshot {
  readonly waiting: boolean
  readonly childCount: number
  readonly handled: boolean
  readonly warmupUsed: boolean
  readonly scheduled: boolean
  readonly lastDecision?: 'cold' | 'warmup'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function defaultTimer(): CacheWaitTimer {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs)
      handle.unref?.()
      return handle
    },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

function defaultActivity(sessionId: string): CacheWaitActivity | undefined {
  const durable = sessionCacheState.read(sessionId)
  const lastActiveAt = sessionLastActiveAt(sessionId) ?? durable?.lastActiveAt
  if (lastActiveAt === undefined) return undefined
  return { lastActiveAt, totalTokens: durable?.totalTokens }
}

function agentRegistry(ctx: {
  get?(name: string): unknown
  readonly agents?: CacheWaitAgents
}): CacheWaitAgents | undefined {
  try {
    const value = ctx.get?.('agents') ?? ctx.agents
    if (value !== null && typeof value === 'object' && typeof (value as CacheWaitAgents).get === 'function') {
      return value as CacheWaitAgents
    }
  } catch {
    // An older host without the registry simply cannot receive the optional warmup.
  }
  return undefined
}

/** Host-side cache-wait state machine. It never sends anything to a child. */
export class KimiCacheWaitController {
  private readonly states = new Map<string, WaitState>()
  private readonly parentByChild = new Map<string, string>()
  private readonly providerBySession = new Map<string, string>()
  private readonly now: () => number
  private readonly timer: CacheWaitTimer
  private readonly agents?: CacheWaitAgents
  private readonly activity: (sessionId: string) => CacheWaitActivity | undefined
  private readonly kimiSession?: (session: CacheWaitSession) => boolean
  private readonly warmup: boolean
  private readonly logger?: CacheWaitLogger
  private readonly decisionMs: number
  private readonly ttlMs: number
  private readonly minWarmupTokens: number
  private disposed = false

  constructor(private readonly options: CacheWaitOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.timer = options.timer ?? defaultTimer()
    this.agents = options.agents
    this.activity = options.activity ?? defaultActivity
    this.kimiSession = options.kimiSession
    this.warmup = options.warmup === true
    this.logger = options.logger
    this.decisionMs = options.decisionMs ?? CACHE_WAIT_DECISION_MS
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS
    this.minWarmupTokens = options.minWarmupTokens ?? MIN_TOKENS_TO_HINT
  }

  /** Observe one durable Session event. */
  observe(session: CacheWaitSession, event: CacheWaitEvent): void {
    if (this.disposed) return
    try {
      const type = text(event.type)
      if (type === undefined) return
      const data = record(event.data)
      if (type === 'request/header') {
        const provider = text(record(record(data?.header)?.config)?.provider)
        if (provider !== undefined) this.providerBySession.set(session.id, provider)
        return
      }
      if (type === 'subagent/catalog') {
        const childId = text(data?.childId)
        if (childId === undefined || childId === session.id) return
        const state = this.stateFor(session.id)
        const newChild = !state.children.has(childId)
        state.children.add(childId)
        this.parentByChild.set(childId, session.id)
        if (newChild) {
          state.warmupUsed = false
          state.handled = false
        }
        this.reconcile(session, state)
        return
      }
      if (type === 'subagent/end') {
        this.removeChild(text(data?.id))
        return
      }
      if (type === 'user/message') {
        const source = record(record(data?.message)?.source)
        if (text(source?.kind) === 'subagent-settled') this.removeChild(text(source?.senderSessionId))
        return
      }
      const state = this.stateFor(session.id)
      if (type === 'turn/start') {
        state.waiting = false
        this.clearTimer(state)
        return
      }
      if (type === 'turn/end') {
        // A natural child report follows this same path: the parent handles it,
        // produces real model activity, and the next turn/end re-arms from that
        // later timestamp. No synthetic checkpoint is needed.
        state.waiting = true
        state.handled = false
        this.reconcile(session, state)
      }
    } catch (error) {
      this.logger?.warn(`kimi-cache-wait: ignored an invalid event: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Forget a disposed Agent and any parent/child links it owned. */
  disposeAgent(agent: CacheWaitAgent): void {
    const id = text(agent.id)
    if (id === undefined) return
    this.dropState(id)
    this.removeChild(id)
    this.providerBySession.delete(id)
  }

  /** Test/diagnostic view; no mutable state escapes. */
  snapshot(sessionId: string): CacheWaitSnapshot {
    const state = this.states.get(sessionId)
    return {
      waiting: state?.waiting ?? false,
      childCount: state?.children.size ?? 0,
      handled: state?.handled ?? false,
      warmupUsed: state?.warmupUsed ?? false,
      scheduled: state?.timer !== undefined,
      ...(state?.lastDecision === undefined ? {} : { lastDecision: state.lastDecision }),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) this.clearTimer(state)
    this.states.clear()
    this.parentByChild.clear()
    this.providerBySession.clear()
  }

  private stateFor(sessionId: string): WaitState {
    const existing = this.states.get(sessionId)
    if (existing !== undefined) {
      this.states.delete(sessionId)
      this.states.set(sessionId, existing)
      return existing
    }
    const state: WaitState = { children: new Set(), waiting: false, handled: false, warmupUsed: false }
    this.states.set(sessionId, state)
    if (this.states.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.states.keys().next()
      if (oldest.done !== true) this.dropState(oldest.value)
    }
    return state
  }

  private dropState(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    this.clearTimer(state)
    for (const child of state.children) this.parentByChild.delete(child)
    this.states.delete(sessionId)
  }

  private removeChild(childId: string | undefined): void {
    if (childId === undefined) return
    const parent = this.parentByChild.get(childId)
    if (parent === undefined) return
    this.parentByChild.delete(childId)
    const state = this.states.get(parent)
    if (state === undefined) return
    state.children.delete(childId)
    if (state.children.size === 0) this.clearTimer(state)
  }

  private clearTimer(state: WaitState): void {
    if (state.timer === undefined) return
    this.timer.clear(state.timer)
    state.timer = undefined
  }

  private isKimiSession(session: CacheWaitSession): boolean {
    if (this.kimiSession !== undefined) return this.kimiSession(session)
    try {
      const current = text(session.requestHeader?.()?.config?.provider)
      if (current !== undefined) return current === 'kimi-code'
    } catch {
      // Fall through to the latest durable header/activity evidence.
    }
    const latest = this.providerBySession.get(session.id)
    if (latest !== undefined) return latest === 'kimi-code'
    return this.activity(session.id)?.lastActiveAt !== undefined
  }

  private reconcile(session: CacheWaitSession, state: WaitState): void {
    this.clearTimer(state)
    if (this.disposed || !state.waiting || state.handled || state.children.size === 0) return
    if (!this.isKimiSession(session)) return
    const activity = this.activity(session.id)
    if (activity === undefined) return
    const action = evaluateCacheWait({
      waiting: state.waiting,
      hasChildren: state.children.size > 0,
      now: this.now(),
      lastActiveAt: activity.lastActiveAt,
      totalTokens: activity.totalTokens,
      warmupEnabled: this.warmup,
      warmupUsed: state.warmupUsed,
      decisionMs: this.decisionMs,
      ttlMs: this.ttlMs,
      minWarmupTokens: this.minWarmupTokens,
    })
    if (action.kind === 'none') return
    if (action.kind === 'schedule') {
      state.timer = this.timer.set(() => {
        state.timer = undefined
        this.reconcile(session, state)
      }, action.delayMs)
      return
    }
    state.handled = true
    state.lastDecision = action.kind
    if (action.kind === 'cold') return

    state.warmupUsed = true
    try {
      const agent = this.agents?.get(session.id)
      if (agent?.steer === undefined) throw new Error('the parent Agent is not available for warmup')
      agent.steer(createCacheWaitWarmupMessage())
      this.logger?.info?.(`kimi-cache-wait: queued one bounded warmup for session ${session.id}`)
    } catch (error) {
      // One failed warmup is terminal for this delegation batch; the next real
      // turn performs the ordinary cold recovery instead of retrying here.
      this.logger?.warn(`kimi-cache-wait: warmup skipped for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export interface KimiCacheWaitContext {
  on?(event: string, listener: (first: any, second?: any) => void): unknown
  get?(name: string): unknown
  readonly agents?: CacheWaitAgents
  readonly logger?: CacheWaitLogger
}

/** Install the host listener. Older hosts without the event bus remain inert. */
export function installKimiCacheWait(
  ctx: KimiCacheWaitContext,
  options: CacheWaitOptions = {},
): (() => void) | undefined {
  if (typeof ctx.on !== 'function') return undefined
  const agents = options.agents ?? agentRegistry(ctx)
  const controller = new KimiCacheWaitController({ ...options, agents })
  const disposers = [
    ctx.on('session/event', (session: CacheWaitSession, event: CacheWaitEvent) => controller.observe(session, event)),
    ctx.on('agent/disposed', ({ agent }: { agent: CacheWaitAgent }) => controller.disposeAgent(agent)),
  ]
  return () => {
    controller.dispose()
    for (const handle of disposers) {
      if (typeof handle === 'function') (handle as () => void)()
      else (handle as { dispose?: () => void } | null | undefined)?.dispose?.()
    }
  }
}
