/**
 * Reasoning-collapse guard.
 *
 * A long reasoning stream can degenerate into repetition: it cycles through a
 * handful of short phrases ("Let me call. Go. Calling. Go.") without emitting a
 * tool call or concluding anything, and runs until the output-token ceiling
 * truncates it. One archived session burned 128,000 output tokens that way and
 * returned an empty answer.
 *
 * The guard scores n-gram uniqueness over a trailing window of reasoning text.
 * Healthy deliberation keeps nearly every n-gram unique and scores near zero; a
 * degenerate stream scores near one. On a hit it stops yielding chunks, so the
 * in-flight request ends, and lets the turn resume on a fresh step.
 *
 * Seam choice: the guard wraps `llm/stream`, not `agent/assistant-stream`.
 * `agent/assistant-stream` is emit-mode — it can observe but cannot stop a
 * stream — and it does not exist before harness 0.1.5, which would make the
 * guard a silent no-op on every generation this plugin supports below that.
 * `llm/stream` is a waterfall whose `(options, next) => AsyncIterable<StreamChunk>`
 * signature is byte-identical from 0.1.2-alpha.5 through 0.2.0-rc.1, and
 * returning early from the listener is what actually ends the stream.
 *
 * The guard subscribes to that waterfall and never reassigns `ctx.llm.stream`.
 * The harness publishes `stream` as a one-argument method that enters the
 * waterfall itself, so a property rewrite carrying a second `next` parameter
 * breaks every caller dispatching it as a method, and misses the prepared
 * call that skips the published method entirely.
 *
 * The guard rewrites nothing and appends nothing to the aborted attempt. Its
 * only model-visible input is the single resume message it queues afterwards,
 * on a fresh turn.
 *
 * Agent identity is read from the request, never remembered globally. The loop
 * stamps every request it builds with its `sessionId`, and `ctx.agents.get`
 * turns that back into the one Agent that owns the stream. Remembering "the
 * newest agent this process saw" instead was wrong twice over: a host runs one
 * Agent per session plus one per subagent, so the newest is usually a different
 * conversation, and `agent/created` fires once per Agent, so an Agent that
 * already existed when the guard installed was never reported at all. Both
 * cases cut the runaway and then resumed nothing, which reads to the user as a
 * conversation that simply stops mid-answer.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'

/**
 * The subset of `llm/stream` options this guard reads.
 *
 * `sessionId` is what binds a stream to the Agent that owns it, and
 * `purpose` tells a conversation call from an auxiliary one (compaction,
 * session title) that owns no turn to resume. Both are plain request fields:
 * the guard adds no generation-bound named import to learn them.
 */
export interface GuardStreamOptions {
  readonly model?: string | undefined
  readonly signal?: AbortSignal | undefined
  /** Stamped by the agent loop on every request it builds. */
  readonly sessionId?: string | undefined
  /** Absent on an ordinary conversation request; set on an auxiliary call. */
  readonly purpose?: string | undefined
}

/** A chunk as it crosses the stream boundary; only the reasoning delta is read. */
export interface GuardChunk {
  readonly type: string
  readonly text?: string | undefined
}

/** Live Agent methods the guard calls. Optional so an older shape stays loadable. */
export interface GuardAgentLike {
  /** The Agent's session identity — the same value the loop stamps on requests. */
  readonly id?: unknown
  cancel?(cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }): void
  steer?(message: unknown): void
}

/** The `llm/stream` waterfall listener the guard registers. */
export type GuardStreamListener = (
  options: GuardStreamOptions,
  next: () => AsyncIterable<GuardChunk>,
) => AsyncIterable<GuardChunk>

/** The `agent/created` / `agent/disposed` listener the guard registers. */
export type GuardAgentEventListener = (payload: { agent: unknown }) => void

/** Either listener {@link ReasoningCollapseContext.on} accepts. */
export type GuardListener = GuardStreamListener | GuardAgentEventListener

/** Listener options accepted by the harness event bus. */
export interface GuardListenerOptions {
  /** Receive the event regardless of context filter checks. */
  readonly global?: boolean
}

/**
 * The Context surface the guard needs, declared structurally so it loads on
 * every supported harness generation without importing generation-bound types.
 */
export interface ReasoningCollapseContext {
  on?: (
    event: 'llm/stream' | 'agent/created' | 'agent/disposed',
    listener: GuardListener,
    options?: GuardListenerOptions,
  ) => unknown
  logger?: { warn(message: string): void } | undefined
  /**
   * The harness Agent registry, read once so a guard installed after an Agent
   * was created can still resolve it. A host without the service degrades to
   * the `agent/created` map rather than failing this plugin's load.
   */
  readonly agents?: { get(id: unknown): unknown } | undefined
}

/** Configuration for {@link installReasoningCollapseGuard}. */
export interface GuardOptions {
  /** Trailing reasoning characters scored per request (default 4096). */
  windowChars?: number
  /** Characters required before a score is computed (default 1500). */
  minWindowChars?: number
  /** Collapse score at or above which the stream is stopped (default 0.85). */
  threshold?: number
  /** N-gram size for both halves of the score (default 8). */
  ngramSize?: number
  /** Stops per turn before the guard stops resuming (default 3). */
  maxBreaksPerTurn?: number
  /** Minimum milliseconds between two stops (default 30000). */
  cooldownMs?: number
  /** Model ids to watch; empty watches every model. */
  includeModels?: string[]
  /** Injectable clock, so the cooldown is testable without a timer. */
  now?: () => number
}

/** Fully defaulted, validated options. */
export interface ResolvedGuardOptions {
  windowChars: number
  minWindowChars: number
  threshold: number
  ngramSize: number
  maxBreaksPerTurn: number
  cooldownMs: number
  includeModels: string[]
  now: () => number
}

export const DEFAULT_GUARD_OPTIONS: ResolvedGuardOptions = {
  windowChars: 4096,
  minWindowChars: 1500,
  threshold: 0.85,
  ngramSize: 8,
  maxBreaksPerTurn: 3,
  cooldownMs: 30000,
  includeModels: [],
  now: () => Date.now(),
}

function pruneUndefined(options: GuardOptions): Partial<ResolvedGuardOptions> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) result[key] = value
  }
  return result as Partial<ResolvedGuardOptions>
}

/**
 * Validate caller options fail-loud and fill in defaults. A threshold outside
 * (0,1), a minimum above the window, or a non-positive budget throws rather
 * than falling back to a value nobody chose.
 */
export function resolveGuardOptions(options: GuardOptions = {}): ResolvedGuardOptions {
  const resolved: ResolvedGuardOptions = { ...DEFAULT_GUARD_OPTIONS, ...pruneUndefined(options) }
  if (!Number.isInteger(resolved.windowChars) || resolved.windowChars < 1) {
    throw new Error(`reasoning-collapse-guard: invalid windowChars ${String(resolved.windowChars)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(resolved.ngramSize) || resolved.ngramSize < 2) {
    throw new Error(`reasoning-collapse-guard: invalid ngramSize ${String(resolved.ngramSize)} — must be an integer >= 2`)
  }
  if (!Number.isInteger(resolved.minWindowChars) || resolved.minWindowChars < 1) {
    throw new Error(`reasoning-collapse-guard: invalid minWindowChars ${String(resolved.minWindowChars)} — must be an integer >= 1`)
  }
  if (resolved.minWindowChars > resolved.windowChars) {
    throw new Error(`reasoning-collapse-guard: invalid minWindowChars ${resolved.minWindowChars} — must not exceed windowChars ${resolved.windowChars}`)
  }
  if (resolved.windowChars < resolved.ngramSize) {
    throw new Error(`reasoning-collapse-guard: windowChars ${resolved.windowChars} is smaller than ngramSize ${resolved.ngramSize}`)
  }
  if (!Number.isFinite(resolved.threshold) || resolved.threshold <= 0 || resolved.threshold >= 1) {
    throw new Error(`reasoning-collapse-guard: invalid threshold ${String(resolved.threshold)} — must be strictly between 0 and 1`)
  }
  if (!Number.isInteger(resolved.maxBreaksPerTurn) || resolved.maxBreaksPerTurn < 1) {
    throw new Error(`reasoning-collapse-guard: invalid maxBreaksPerTurn ${String(resolved.maxBreaksPerTurn)} — must be an integer >= 1`)
  }
  if (!Number.isInteger(resolved.cooldownMs) || resolved.cooldownMs < 0) {
    throw new Error(`reasoning-collapse-guard: invalid cooldownMs ${String(resolved.cooldownMs)} — must be an integer >= 0`)
  }
  if (!Array.isArray(resolved.includeModels) || resolved.includeModels.some(entry => typeof entry !== 'string')) {
    throw new Error('reasoning-collapse-guard: includeModels must be an array of strings')
  }
  if (typeof resolved.now !== 'function') {
    throw new Error('reasoning-collapse-guard: now must be a function')
  }
  return resolved
}

/**
 * `1 - uniqueNgrams / totalNgrams` over the window.
 *
 * Scored over the whole window: a degenerate stream repeats within its own
 * trailing characters, so scoring part of the window would dilute the signal.
 * @param window - trailing reasoning characters.
 * @param n - n-gram size.
 * @returns collapse score in [0,1]; 0 means every n-gram is unique.
 */
export function collapseScore(window: string, n: number): number {
  if (window.length < n) return 0
  const grams = new Set<string>()
  let total = 0
  for (let i = 0; i + n <= window.length; i++) {
    grams.add(window.slice(i, i + n))
    total++
  }
  if (total === 0) return 0
  return 1 - grams.size / total
}
export const RESUME_HINT =
  'Your previous reasoning became repetitive and was stopped before it finished. '
  + 'Resume from what you already established instead of restarting the analysis, '
  + 'and keep the rest of this response short.'

/** The second resume message, used once a resume has also collapsed. */
export const RESUME_HINT_STRICT =
  'Your reasoning has now repeated across two attempts. Do not re-derive the '
  + 'analysis a third time. Either state the conclusion you already reached, or '
  + 'make the single next tool call that moves the task forward. Keep this '
  + 'response to a few sentences.'

/** Per-agent breaker bookkeeping, carried across the attempts of one turn. */
interface BreakerState {
  breaksThisTurn: number
  /** `-1` until the first stop, so a fresh budget is never inside its own cooldown. */
  lastBreakAt: number
  exhausted: boolean
  resuming: boolean
}

function createBreakerState(): BreakerState {
  return { breaksThisTurn: 0, lastBreakAt: -Infinity, exhausted: false, resuming: false }
}

/**
 * The resume message the guard queues onto the kept inbox.
 *
 * It is built with the harness message factory and carries this package's own
 * source kind, because the harness rejects a message that is not fully
 * identified: a steer payload with no `id` is refused by
 * `assertMessageEventShape` (`session event … lacks an identified message`)
 * and one with no `source` by the same check (`… has invalid source`). Either
 * refusal is thrown from `session.append` at the very moment the guard's
 * microtask steers — after the abort has already been taken — so the failure
 * surfaced as a repairable-splice violation, the attempt was already cancelled,
 * and the turn ended with the user told nothing.
 *
 * `createUserMessage` is available on every supported generation, and the
 * `dsh-chatgpt-subscription` kind is this package's own entry in the
 * merge-extensible `MessageSourceMap`, so the resume carries real provenance
 * instead of impersonating a human turn.
 */
function createResumeMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('Reasoning collapsed; the attempt was stopped and resumed.'),
    },
  })
}

function appendWindow(current: string, addition: string, limit: number): string {
  const combined = current + addition
  return combined.length > limit ? combined.slice(-limit) : combined
}

/** An Agent's session identity as the plain string a request carries. */
function agentId(raw: unknown): string | undefined {
  const id = (raw as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * The host's Agent registry, read defensively.
 *
 * A Cordis service that was never injected reads as undefined and a host
 * without the service at all must not fail this plugin's load, so both the
 * property read and the later lookup are guarded.
 */
function agentRegistry(ctx: ReasoningCollapseContext): { get(id: unknown): unknown } | undefined {
  try {
    const registry = ctx.agents
    return typeof registry?.get === 'function' ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether one request is a conversation call the guard may stop and resume.
 *
 * The loop marks its own requests, but that marker is reached through a named
 * export this plugin cannot assume on every generation it supports, so the
 * guard reads the request's own `purpose` field instead: compaction and
 * session-title calls are one-shot, own no turn to resume, and a truncated one
 * is a hard error rather than a runaway. A generation that predates the field
 * leaves it undefined, which is the pre-existing behaviour.
 */
function conversationCall(request: GuardStreamOptions): boolean {
  return request.purpose === undefined
}

/** Error text for one warn line, without importing a generation-bound helper. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Install the reasoning-collapse guard on a Context.
 *
 * The guard is inert unless the host exposes the event bus, so a harness
 * without it keeps the built-in behaviour instead of failing this plugin's
 * load.
 *
 * Resuming needs the live Agent for `cancel` and `steer`, and no supported
 * generation hands the agent to `llm/stream`. The request does, though: every
 * request the loop builds carries its `sessionId`, so the guard resolves the
 * owning Agent per request through `ctx.agents.get`, falling back to the map
 * `agent/created` fills. The per-turn break budget stays keyed on the
 * request's own abort signal, which exists for a whole turn.
 *
 * @param ctx - plugin context.
 * @param options - see {@link GuardOptions}; validated fail-loud.
 * @returns a disposer removing every listener, or undefined when the host
 * exposes no event bus.
 */
export function installReasoningCollapseGuard(
  ctx: ReasoningCollapseContext,
  options: GuardOptions = {},
): (() => void) | undefined {
  const resolved = resolveGuardOptions(options)
  if (typeof ctx.on !== 'function') return undefined
  const watched = new Set(resolved.includeModels)
  const breakers = new WeakMap<object, BreakerState>()
  // Session id -> Agent, filled by the lifecycle events. A fallback for a host
  // that exposes no registry, never the primary lookup.
  const known = new Map<string, GuardAgentLike>()

  const releaseCreated = ctx.on('agent/created', (payload: { agent: unknown }) => {
    remember(payload.agent)
  })
  const releaseDisposed = ctx.on('agent/disposed', (payload: { agent: unknown }) => {
    const id = agentId(payload.agent)
    if (id !== undefined) known.delete(id)
  })
  const releaseStream = ctx.on('llm/stream', guardStream, { global: true })

  function remember(raw: unknown): void {
    const agent = raw as GuardAgentLike | null | undefined
    if (agent === undefined || agent === null) return
    const id = agentId(agent)
    if (id !== undefined) known.set(id, agent)
  }

  /**
   * The Agent that owns one guarded request, or undefined when this host
   * cannot name it.
   *
   * The registry is authoritative and is read first: it answers for an Agent
   * created before this guard was installed, which is exactly the Agent an
   * `agent/created` listener can never report. Falling back to the newest
   * Agent this process saw would cancel and resume a different conversation.
   */
  function resolveAgent(sessionId: string | undefined): GuardAgentLike | undefined {
    if (sessionId === undefined) return undefined
    try {
      // Read per break, not once at install: a Cordis context throws when a
      // service is not injected yet, and a plugin may well load before the
      // registry that comes up moments later.
      const registered = agentRegistry(ctx)?.get(sessionId)
      if (registered !== undefined && registered !== null) return registered as GuardAgentLike
    } catch {
      // No registry, or one that refuses the id: the event-filled map answers.
    }
    return known.get(sessionId)
  }

  function breakerFor(key: object): BreakerState {
    let state = breakers.get(key)
    if (state === undefined) {
      state = createBreakerState()
      breakers.set(key, state)
    }
    return state
  }

  function watchedModel(model: string | undefined): boolean {
    if (watched.size === 0) return true
    return model !== undefined && watched.has(model)
  }

  /**
   * Stop the attempt and queue at most one resume for the turn.
   *
   * The resume is queued on a microtask because cancellation may discard
   * steering submitted while a turn is still unwinding; by the time the
   * microtask runs the abort has settled, so the wake lands on a fresh turn that
   * inherits the kept inbox.
   *
   * With no Agent to address, the runaway is still cut — that half is the whole
   * point — and the log says so, because a break that cannot resume is
   * indistinguishable from a broken turn to the user.
   */
  function breakOff(
    state: BreakerState,
    score: number,
    agent: GuardAgentLike | undefined,
    sessionId: string | undefined,
  ): void {
    state.breaksThisTurn++
    state.lastBreakAt = resolved.now()
    ctx.logger?.warn(
      `reasoning-collapse-guard: stopped degenerate reasoning (score ${score.toFixed(3)}, `
      + `break ${state.breaksThisTurn}/${resolved.maxBreaksPerTurn}, `
      + `session ${sessionId ?? 'unidentified'}`
      + `${agent === undefined ? ', no agent to resume' : ''})`,
    )
    if (agent === undefined) return
    agent.cancel?.({ kind: 'hook', reason: 'reasoning-collapse-guard' }, { keepInbox: true })
    if (agent.steer === undefined || state.resuming) return
    state.resuming = true
    const text = state.breaksThisTurn >= 2 ? RESUME_HINT_STRICT : RESUME_HINT
    queueMicrotask(() => {
      state.resuming = false
      try {
        agent.steer?.(createResumeMessage(text))
      } catch (error) {
        // The break is already taken; a resume that cannot be built must not
        // vanish into an unhandled rejection on top of it.
        ctx.logger?.warn(`reasoning-collapse-guard: could not queue the resume: ${describeError(error)}`)
      }
    })
  }

  function guardStream(
    request: GuardStreamOptions,
    next: () => AsyncIterable<GuardChunk>,
  ): AsyncIterable<GuardChunk> {
    // The break budget is keyed on the request's own abort signal: it spans a
    // whole turn, so every attempt inside one turn shares a budget and a new
    // turn starts from a clean one. The static instance backs the rare request
    // that carries no signal.
    const key: object = request.signal ?? STATIC_KEY
    const state = breakerFor(key)
    if (state.exhausted || !watchedModel(request.model) || !conversationCall(request)) return next()
    // Resolved once per attempt: the owning Agent is a property of the
    // request, so it cannot change between chunks of one stream.
    const agent = resolveAgent(request.sessionId)

    async function* guarded(): AsyncIterable<GuardChunk> {
      let window = ''
      for await (const chunk of next()) {
        // A new content block closes the previous one. The window resets here so
        // an attempt retried inside the same turn is scored on its own output.
        if (chunk.type === 'block-start') window = ''
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          window = appendWindow(window, chunk.text, resolved.windowChars)
          if (window.length >= resolved.minWindowChars
            && resolved.now() - state.lastBreakAt >= resolved.cooldownMs) {
            const score = collapseScore(window, resolved.ngramSize)
            if (score >= resolved.threshold) {
              if (state.breaksThisTurn >= resolved.maxBreaksPerTurn) {
                state.exhausted = true
              } else {
                breakOff(state, score, agent, request.sessionId)
                // Returning here is what ends the in-flight stream: the harness
                // never receives a finish chunk for the truncated attempt.
                return
              }
            }
          }
        }
        yield chunk
      }
    }

    return guarded()
  }

  return () => {
    releaseListener(releaseStream)
    releaseListener(releaseCreated)
    releaseListener(releaseDisposed)
    known.clear()
  }
}

/** Shared key for the rare request that carries no abort signal. */
const STATIC_KEY: object = {}

/** Cordis event handles are either a disposer function or a disposable object. */
function releaseListener(handle: unknown): void {
  if (typeof handle === 'function') {
    handle()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  disposable?.dispose?.()
}