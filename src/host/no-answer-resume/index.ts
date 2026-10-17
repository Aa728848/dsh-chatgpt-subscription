import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { PLUGIN_MESSAGE_SOURCE_KIND } from '../common/llm-compat.ts'
import { NO_ANSWER_PHRASE } from '../minimax-code/mapper.ts'

/**
 * Resume a turn that ended without an answer.
 *
 * One line's forced thinking can spend a whole response reasoning and then end
 * the turn with `end_turn`, leaving no text and no tool call. That line reports
 * it as a failure, which is honest but leaves the turn unfinished: the harness
 * has no representation for "the model stopped before it did anything", so the
 * caller sees a failed turn and nothing else.
 *
 * This hook closes that gap. It watches the `llm/stream` waterfall, recognises
 * that specific failure, and steers one continuation so the turn finishes.
 *
 * The steer has to land while the Agent is **idle**. `Agent.steer` splices into
 * the inbox and calls `wakeDriver`, and `wakeDriver` only opens a new turn from
 * `idle`: sent while a turn is still running it latches nothing and the message
 * sits unread. So the resume waits on `whenIdle()` rather than racing the turn
 * boundary — the collapse guard reaches the same place by cancelling first and
 * steering on a microtask, which is not available here because nothing is being
 * cancelled.
 *
 * @module
 */

/** The subset of `llm/stream` options this hook reads. */
export interface ResumeStreamOptions {
  /** Stamped by the agent loop on every request it builds. */
  readonly sessionId?: string | undefined
  /** Absent on an ordinary conversation request; set on an auxiliary call. */
  readonly purpose?: string | undefined
}

/** A chunk as it crosses the stream boundary; only the shape is read. */
export interface ResumeChunk {
  readonly type: string
  readonly text?: string | undefined
  readonly blockType?: string | undefined
  readonly reason?: {
    readonly kind?: string | undefined
    readonly failure?: { readonly code?: string | undefined; readonly message?: string | undefined } | undefined
  } | undefined
}

/** Live Agent methods the hook calls. Optional so an older shape stays loadable. */
export interface ResumeAgentLike {
  /** The Agent's session identity — the same value the loop stamps on requests. */
  readonly id?: unknown
  steer?(message: unknown): void
  /** Resolves once the Agent has no work in flight. */
  whenIdle?(): Promise<unknown>
}

/** The `llm/stream` waterfall listener this hook registers. */
export type ResumeStreamListener = (
  options: ResumeStreamOptions,
  next: () => AsyncIterable<ResumeChunk>,
) => AsyncIterable<ResumeChunk>

/** Configuration for {@link installNoAnswerResume}. */
export interface NoAnswerResumeOptions {
  /** Consecutive answerless turns resumed before giving up (default 2). */
  maxResumes?: number
  /** The continuation injected on each resume. */
  text?: string
}

/** {@link NoAnswerResumeOptions} with every default filled in. */
export interface ResolvedNoAnswerResumeOptions {
  maxResumes: number
  text: string
}

/** The continuation this hook injects, unless the deployment states its own. */
export const NO_ANSWER_RESUME =
  'Your previous response ended without an answer and without calling a tool. '
  + 'Continue from where you left off: either state the conclusion you already reached, '
  + 'or make the single next tool call that moves the task forward. Do not restart the analysis.'

export const DEFAULT_NO_ANSWER_RESUME_OPTIONS: ResolvedNoAnswerResumeOptions = {
  maxResumes: 2,
  text: NO_ANSWER_RESUME,
}

/**
 * The Context surface the hook needs, declared structurally so it loads on every
 * supported harness generation without importing generation-bound types.
 *
 * `get` is the read that reaches the Agent registry in a real host: the registry
 * is provided by a sibling fiber, and Cordis throws for a property this plugin did
 * not declare in its `inject` list.
 */
export interface NoAnswerResumeContext {
  on?: (
    event: 'llm/stream',
    listener: ResumeStreamListener,
    options?: { readonly global?: boolean },
  ) => unknown
  logger?: { info?(message: string): void; warn(message: string): void } | undefined
  get?(name: string): unknown
  readonly agents?: { get(id: unknown): unknown } | undefined
}

function pruneUndefined(options: NoAnswerResumeOptions): Partial<ResolvedNoAnswerResumeOptions> {
  const result: Partial<ResolvedNoAnswerResumeOptions> = {}
  if (options.maxResumes !== undefined) result.maxResumes = options.maxResumes
  if (options.text !== undefined) result.text = options.text
  return result
}

/**
 * Validate caller options fail-loud and fill in defaults.
 *
 * A resume budget below one would disable the hook while looking enabled, and an
 * empty continuation would wake the Agent with nothing to act on — both are
 * configuration mistakes worth failing on rather than silently ignoring.
 */
export function resolveNoAnswerResumeOptions(
  options: NoAnswerResumeOptions = {},
): ResolvedNoAnswerResumeOptions {
  const resolved = { ...DEFAULT_NO_ANSWER_RESUME_OPTIONS, ...pruneUndefined(options) }
  if (!Number.isInteger(resolved.maxResumes) || resolved.maxResumes < 1) {
    throw new Error(`no-answer-resume: invalid maxResumes ${String(resolved.maxResumes)} — must be an integer >= 1`)
  }
  if (typeof resolved.text !== 'string' || resolved.text.trim() === '') {
    throw new Error('no-answer-resume: invalid text — must be a non-empty string')
  }
  return resolved
}

/** The message a resume carries, with this package's own provenance. */
function createResumeMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_MESSAGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('The turn ended without an answer; it was resumed.'),
    },
  })
}

/** An Agent's session identity as the plain string a request carries. */
function agentId(raw: unknown): string | undefined {
  const id = (raw as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

function asRegistry(value: unknown): { get(id: unknown): unknown } | undefined {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? value as { get(id: unknown): unknown }
    : undefined
}

/** The host's Agent registry, read defensively through both available routes. */
function agentRegistry(ctx: NoAnswerResumeContext): { get(id: unknown): unknown } | undefined {
  try {
    const registry = asRegistry(typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
    if (registry !== undefined) return registry
  } catch {
    // No reader on this host, or one that refuses the name: the property answers.
  }
  try {
    return asRegistry(ctx.agents)
  } catch {
    return undefined
  }
}

/** Error text for one warn line, without importing a generation-bound helper. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Whether one request is a conversation call this hook may resume. */
function conversationCall(request: ResumeStreamOptions): boolean {
  return request.purpose === undefined
}

/**
 * Whether one finish chunk is the answerless-turn failure this hook resumes.
 *
 * Matched on the code plus the phrase the reporting line exports, never on the
 * whole message: the rest of it carries diagnostics that may change.
 */
function isAnswerlessFailure(chunk: ResumeChunk): boolean {
  const reason = chunk.reason
  if (reason === undefined || reason.kind !== 'error') return false
  const failure = reason.failure
  if (failure === undefined || failure.code !== 'PROVIDER_ERROR') return false
  return typeof failure.message === 'string' && failure.message.includes(NO_ANSWER_PHRASE)
}

/** Whether a chunk proves the response carried something a reader can act on. */
function isVisible(chunk: ResumeChunk): boolean {
  if (chunk.type === 'tool-call-delta') return true
  return chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== ''
}

/** One session's resume bookkeeping. */
interface ResumeState {
  /** Answerless turns resumed in a row; reset by any turn that answers. */
  consecutive: number
}

/**
 * Install the answerless-turn resume hook on a Context.
 *
 * Inert unless the host exposes the event bus, so a harness without it keeps the
 * built-in behaviour instead of failing this plugin's load.
 *
 * @param ctx - plugin context.
 * @param options - see {@link NoAnswerResumeOptions}; validated fail-loud.
 * @returns a disposer removing the listener, or undefined when the host exposes
 *   no event bus.
 */
export function installNoAnswerResume(
  ctx: NoAnswerResumeContext,
  options: NoAnswerResumeOptions = {},
): (() => void) | undefined {
  const resolved = resolveNoAnswerResumeOptions(options)
  if (typeof ctx.on !== 'function') return undefined
  const sessions = new Map<string, ResumeState>()

  /**
   * The Agent that owns one request, or undefined when this host cannot name it.
   *
   * Read per resume, not once at install: a Cordis context throws when a service
   * is not injected yet, and this plugin may well load before the registry that
   * comes up moments later.
   */
  function resolveAgent(sessionId: string | undefined): ResumeAgentLike | undefined {
    if (sessionId === undefined) return undefined
    try {
      const registered = agentRegistry(ctx)?.get(sessionId)
      if (registered !== undefined && registered !== null) return registered as ResumeAgentLike
    } catch {
      // No registry, or one that refuses the id: there is no Agent to resume.
    }
    return undefined
  }

  function stateFor(sessionId: string | undefined): ResumeState {
    const key = sessionId ?? ''
    let state = sessions.get(key)
    if (state === undefined) {
      state = { consecutive: 0 }
      sessions.set(key, state)
    }
    return state
  }

  /**
   * Steer one continuation, once the Agent has no turn in flight.
   *
   * `whenIdle` is the whole point: a steer sent while the turn is still running
   * is spliced into the inbox with no wake latched behind it, so it would never
   * be read. A generation without `whenIdle` cannot be asked, so the resume is
   * attempted on a microtask and the log says the pickup is not guaranteed.
   */
  function resume(agent: ResumeAgentLike, attempt: number, sessionId: string | undefined): void {
    const fire = (): void => {
      try {
        agent.steer?.(createResumeMessage(resolved.text))
        ctx.logger?.info?.(
          `no-answer-resume: resumed attempt ${attempt}/${resolved.maxResumes} (session ${sessionId ?? 'unidentified'})`,
        )
      } catch (error) {
        ctx.logger?.warn(`no-answer-resume: could not queue the resume: ${describeError(error)}`)
      }
    }
    const idle = typeof agent.whenIdle === 'function' ? agent.whenIdle() : undefined
    if (idle === undefined) {
      ctx.logger?.warn(
        'no-answer-resume: this host cannot report when the Agent is idle; the resume may not be picked up',
      )
      queueMicrotask(fire)
      return
    }
    Promise.resolve(idle).then(fire, () => fire())
  }

  /**
   * Decide what one finished stream means for its session.
   *
   * A turn that answered clears the streak: the budget counts consecutive
   * answerless turns, so one bad turn in an otherwise healthy session does not
   * spend it.
   */
  function settle(sessionId: string | undefined, answered: boolean, answerless: boolean): void {
    if (!answerless) {
      if (answered) stateFor(sessionId).consecutive = 0
      return
    }
    const state = stateFor(sessionId)
    if (state.consecutive >= resolved.maxResumes) {
      ctx.logger?.warn(
        `no-answer-resume: gave up after ${state.consecutive} answerless turns in a row (session ${sessionId ?? 'unidentified'})`,
      )
      return
    }
    const agent = resolveAgent(sessionId)
    if (agent === undefined || typeof agent.steer !== 'function') {
      ctx.logger?.warn(
        `no-answer-resume: no Agent to resume (session ${sessionId ?? 'unidentified'})`,
      )
      return
    }
    state.consecutive += 1
    resume(agent, state.consecutive, sessionId)
  }

  function resumeStream(
    request: ResumeStreamOptions,
    next: () => AsyncIterable<ResumeChunk>,
  ): AsyncIterable<ResumeChunk> {
    return (async function* () {
      let answered = false
      let answerless = false
      try {
        for await (const chunk of next()) {
          if (isVisible(chunk)) answered = true
          if (chunk.type === 'finish' && isAnswerlessFailure(chunk)) answerless = true
          yield chunk
        }
      } finally {
        // Only a conversation call owns a turn worth resuming; compaction and
        // session-title calls are one-shot and have nothing to continue.
        if (conversationCall(request)) settle(request.sessionId, answered, answerless)
      }
    })()
  }

  const release = ctx.on('llm/stream', resumeStream, { global: true })
  return () => {
    releaseListener(release)
    sessions.clear()
  }
}

/** Cordis event handles are either a disposer function or a disposable object. */
function releaseListener(handle: unknown): void {
  if (typeof handle === 'function') {
    handle()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  disposable?.dispose?.()
}
