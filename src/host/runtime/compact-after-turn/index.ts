/**
 * One-shot "compact when this turn ends".
 * @module dsh-chatgpt-subscription/compact-after-turn
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  COMPACT_AFTER_TURN_PATH,
  type CompactAfterTurnErrorCode,
  type CompactAfterTurnOutcomeDto,
  type CompactAfterTurnPhase,
  type CompactAfterTurnStateDto,
} from '../../../shared/compact-after-turn.ts'
import { isSameOriginMutation } from '../../common/same-origin.ts'

/** Sessions remembered at once; the oldest settled ones are dropped first. */
const MAX_TRACKED_SESSIONS = 256
const MAX_BODY_BYTES = 4 * 1024

/** The slice of an Agent this controller reads. */
export interface CompactAfterTurnSession {
  readonly id?: unknown
  readonly requestHeader?: (() => { config?: { provider?: unknown } | undefined } | undefined) | undefined
}

export interface CompactAfterTurnAgent {
  readonly session?: CompactAfterTurnSession | undefined
  /**
   * The agent's own scope. A preset loads its compaction engine inside it, so
   * the engine is read from here rather than from the plugin's root scope.
   */
  readonly ctx?: { get?(name: string): unknown } | undefined
}

/** The slice of a session event this controller reads. */
export interface CompactAfterTurnEvent {
  readonly type?: unknown
  readonly data?: unknown
}

export interface CompactAfterTurnDeps {
  /**
   * The compaction entry for one agent (or for the Host, before any agent of
   * the session was seen); undefined when there is no engine to call.
   */
  readonly compactor: (agent: CompactAfterTurnAgent | undefined) => CompactNow | undefined
  /** Persistent per-line policy for an eligible delegated session. */
  readonly autoCompact?: (agent: CompactAfterTurnAgent) => boolean | Promise<boolean>
  readonly now?: () => number
  readonly logger?: { warn(message: string): void; info?(message: string): void } | undefined
  /** Defers the compaction out of the status listener; tests run it inline. */
  readonly defer?: (task: () => void) => void
}

export type CompactNow = (agent: CompactAfterTurnAgent, signal: AbortSignal) => Promise<unknown>

interface SessionState {
  phase: CompactAfterTurnPhase
  last: CompactAfterTurnOutcomeDto | null
  /** Reason kind of the latest `turn/end` seen while armed. */
  lastTurnEnd: string | null
  abort: AbortController | null
  /**
   * The agent left idle, or a turn opened, while this session's attempt was in
   * flight. Manual compaction runs as agent maintenance with the public status
   * kept `idle`, so either signal means a turn contended for the agent.
   */
  contended: boolean
  /** A `compaction/start` without its `compaction/end` was seen for this session. */
  compactionOpen: boolean
}

/** Refusal raised by {@link CompactAfterTurnController.setArmed}. */
export class CompactAfterTurnError extends Error {
  constructor(readonly code: CompactAfterTurnErrorCode, message: string) {
    super(message)
    this.name = 'CompactAfterTurnError'
  }
}

export class CompactAfterTurnController {
  private readonly sessions = new Map<string, SessionState>()
  /** The latest agent seen per session; its scope is where the engine lives. */
  private readonly agents = new Map<string, CompactAfterTurnAgent>()
  private readonly now: () => number
  private readonly defer: (task: () => void) => void
  private disposed = false

  constructor(private readonly deps: CompactAfterTurnDeps) {
    this.now = deps.now ?? Date.now
    this.defer = deps.defer ?? ((task) => { setTimeout(task, 0) })
  }

  /**
   * Whether the session can compact. A session whose agent was seen answers by
   * that agent's scope; one not seen yet (no turn since the Host started) is
   * taken as able, and an attempt without an engine is recorded as a failure.
   */
  available(sessionId: string): boolean {
    const agent = this.agents.get(sessionId)
    return agent === undefined || this.deps.compactor(agent) !== undefined
  }

  state(sessionId: string): CompactAfterTurnStateDto {
    const state = this.sessions.get(sessionId)
    return {
      sessionId,
      phase: state?.phase ?? 'off',
      available: this.available(sessionId),
      last: state?.last ?? null,
    }
  }

  setArmed(sessionId: string, armed: boolean): CompactAfterTurnStateDto {
    const current = this.sessions.get(sessionId)
    if (current?.phase === 'compacting') {
      throw new CompactAfterTurnError('busy', 'A compaction is running for this session.')
    }
    if (armed) {
      if (!this.available(sessionId)) throw new CompactAfterTurnError('unavailable', 'This session has no compaction engine.')
      const state = this.ensure(sessionId)
      state.phase = 'armed'
      state.lastTurnEnd = null
    } else if (current !== undefined) {
      current.phase = 'off'
      current.lastTurnEnd = null
    }
    return this.state(sessionId)
  }

  /**
   * `session/event` listener: remembers how an armed session's turn ended, and
   * tracks the structural signals that classify a refused attempt as busy.
   */
  observe(session: { readonly id?: unknown } | undefined, event: CompactAfterTurnEvent | undefined): void {
    const id = sessionIdOf(session)
    if (id === undefined) return
    let state = this.sessions.get(id)
    if (state === undefined) {
      if (event?.type !== 'turn/end') return
      state = this.ensure(id)
    }
    switch (event?.type) {
      case 'compaction/start':
        state.compactionOpen = true
        return
      case 'compaction/end':
        state.compactionOpen = false
        return
      case 'turn/start':
        if (state.phase === 'compacting') state.contended = true
        return
      case 'turn/end':
        break
      default:
        return
    }
    const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
    state.lastTurnEnd = typeof reason === 'string' ? reason : 'completed'
  }

  /** `agent/status` listener: an armed session that just went idle compacts once. */
  onStatus(agent: CompactAfterTurnAgent | undefined, status: unknown): void {
    if (this.disposed || agent === undefined) return
    const id = sessionIdOf(agent.session)
    if (id === undefined) return
    this.agents.set(id, agent)
    const state = this.sessions.get(id)
    if (status !== 'idle') {
      if (state?.phase === 'compacting') state.contended = true
      return
    }
    // No turn has ended since the switch was armed: arming while idle waits for
    // the next turn instead of compacting on the spot.
    if (state === undefined || (state.phase !== 'armed' && state.phase !== 'off') || state.lastTurnEnd === null) return
    if (state.phase === 'off' && this.deps.autoCompact === undefined) return
    if (state.lastTurnEnd === 'aborted') {
      state.lastTurnEnd = null
      return
    }
    const compactNow = this.deps.compactor(agent)
    if (compactNow === undefined) {
      state.phase = 'off'
      state.lastTurnEnd = null
      state.last = { kind: 'failed', detail: 'This session has no compaction engine.', at: this.now() }
      return
    }
    const automatic = state.phase === 'off'
    state.phase = 'compacting'
    state.lastTurnEnd = null
    state.contended = false
    const abort = new AbortController()
    state.abort = abort
    this.defer(() => { void this.run(id, state, agent, compactNow, abort, automatic) })
  }

  /** `agent/disposed` listener: a compaction must not outlive its agent. */
  onDisposed(agent: CompactAfterTurnAgent | undefined): void {
    const id = sessionIdOf(agent?.session)
    if (id === undefined) return
    this.sessions.get(id)?.abort?.abort(new Error('agent disposed'))
    if (this.agents.get(id) === agent) this.agents.delete(id)
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.sessions.values()) state.abort?.abort(new Error('plugin unloaded'))
    this.sessions.clear()
    this.agents.clear()
  }

  private async run(
    id: string,
    state: SessionState,
    agent: CompactAfterTurnAgent,
    compactNow: CompactNow,
    abort: AbortController,
    automatic: boolean,
  ): Promise<void> {
    let rearm = false
    // Our own attempt has not appended its marker yet, so an open one is foreign.
    const lockedBefore = state.compactionOpen
    try {
      if (abort.signal.aborted) throw abort.signal.reason
      if (automatic && !await this.deps.autoCompact?.(agent)) return
      const result = await compactNow(agent, abort.signal)
      state.last = { kind: result === null || result === undefined ? 'nothing' : 'compacted', at: this.now() }
      this.deps.logger?.info?.(`compact-after-turn: session ${id} ${state.last.kind}`)
    } catch (error) {
      if (!abort.signal.aborted && (errorCode(error) === 'busy' || state.contended || lockedBefore)) {
        // The session reopened before the engine got to it; try at the next idle.
        rearm = true
      } else {
        state.last = { kind: 'failed', detail: errorMessage(error), at: this.now() }
        this.deps.logger?.warn(`compact-after-turn: session ${id} failed: ${errorMessage(error)}`)
      }
    } finally {
      if (state.abort === abort) state.abort = null
      if (this.sessions.get(id) === state) {
        state.phase = rearm && !automatic ? 'armed' : 'off'
        // A busy refusal means a new turn is (or was just) open; its own
        // turn/end re-establishes the trigger.
        state.lastTurnEnd = null
      }
    }
  }

  private ensure(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state !== undefined) {
      // Refresh recency so the bound below drops the stalest entries.
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, state)
      return state
    }
    state = { phase: 'off', last: null, lastTurnEnd: null, abort: null, contended: false, compactionOpen: false }
    this.sessions.set(sessionId, state)
    if (this.sessions.size > MAX_TRACKED_SESSIONS) {
      for (const [key, value] of this.sessions) {
        if (this.sessions.size <= MAX_TRACKED_SESSIONS) break
        if (value.phase === 'off') this.sessions.delete(key)
      }
    }
    return state
  }
}

function sessionIdOf(session: { readonly id?: unknown } | undefined): string | undefined {
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

/** The Host surface {@link installCompactAfterTurn} needs; every member optional. */
export interface CompactAfterTurnHost {
  on?(event: string, listener: (...args: any[]) => void): unknown
  get?(name: string): unknown
  readonly webServer?: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void } | undefined
  readonly logger?: { warn(message: string): void; info?(message: string): void } | undefined
}

export interface CompactAfterTurnOptions {
  /** Persistent per-line policy for delegated sessions. */
  readonly autoCompact?: (agent: CompactAfterTurnAgent) => boolean | Promise<boolean>
  /**
   * The compaction engine as the caller's `inject(['compaction'])` scope holds
   * it. A plugin that does not declare the service cannot read it through a
   * plain `get`, so the entry point tracks it and hands it over here.
   */
  readonly engine?: () => unknown
}

interface CompactCommandRuntime {
  find(agent: CompactAfterTurnAgent, name: string): unknown
  execute(agent: CompactAfterTurnAgent, line: string, attachments: readonly [], signal: AbortSignal): Promise<{
    result?: { kind?: unknown; text?: unknown; sourceEventSeq?: unknown }
  } | undefined>
}

/**
 * Resolve manual compaction lazily. Preset services live in an isolated Cordis
 * realm that is NOT agent.ctx's realm; the preset registry shares only scoped
 * contributions such as /compact with the agent. Prefer that canonical command
 * and retain direct-engine lookup for older or non-preset Host compositions.
 */
function compactorOf(host: CompactAfterTurnHost, options: CompactAfterTurnOptions, agent: CompactAfterTurnAgent | undefined): CompactNow | undefined {
  if (agent !== undefined) {
    try {
      const commands = host.get?.('commands') as CompactCommandRuntime | undefined
      if (typeof commands?.find === 'function' && typeof commands.execute === 'function'
        && commands.find(agent, 'compact') !== undefined) {
        return async (target, signal) => {
          const execution = await commands.execute(target, '/compact', [], signal)
          const result = execution?.result
          if (result === undefined) throw new CompactAfterTurnError('unavailable', 'This session has no compact command.')
          if (result.kind === 'success') return result.sourceEventSeq === undefined ? null : result
          const message = typeof result.text === 'string' ? result.text : 'Manual compaction failed.'
          // The public command result carries human text rather than
          // ManualCompactionError.code. The controller classifies busy from
          // the events it observes; matching the current wording is only an
          // extra hint for a refusal those events did not reveal.
          const busy = message.includes('active compaction') || message.includes('not idle')
          throw Object.assign(new Error(message), { code: busy ? 'busy' : 'summary' })
        }
      }
    } catch {
      // An older Host may not expose the command runtime; try the engine below.
    }
  }

  let engine: unknown
  try {
    engine = agent?.ctx?.get?.('compaction') ?? options.engine?.() ?? host.get?.('compaction')
  } catch {
    // A context that refuses the lookup has no engine for this plugin.
    return undefined
  }
  const compactNow = (engine as { compactNow?: unknown } | undefined)?.compactNow
  if (typeof compactNow !== 'function') return undefined
  return (agent, signal) => (compactNow as (agent: unknown, signal: AbortSignal) => Promise<unknown>).call(engine, agent, signal)
}

/** Install the listeners and the route; returns the disposer (undefined on a Host without an event bus). */
export function installCompactAfterTurn(host: CompactAfterTurnHost, options: CompactAfterTurnOptions = {}): (() => void) | undefined {
  if (typeof host.on !== 'function') return undefined
  const controller = new CompactAfterTurnController({
    compactor: (agent) => compactorOf(host, options, agent),
    autoCompact: options.autoCompact,
    logger: host.logger,
  })
  const handles = [
    host.on('session/event', (session: { id?: unknown }, event: CompactAfterTurnEvent) => controller.observe(session, event)),
    host.on('agent/status', (payload: { agent?: CompactAfterTurnAgent; status?: unknown } | undefined) => controller.onStatus(payload?.agent, payload?.status)),
    host.on('agent/disposed', (payload: { agent?: CompactAfterTurnAgent } | undefined) => controller.onDisposed(payload?.agent)),
  ]
  const disposeRoute = host.webServer?.register({ kind: 'exact', path: COMPACT_AFTER_TURN_PATH, handler: createCompactAfterTurnHandler(controller) })
  return () => {
    controller.dispose()
    disposeRoute?.()
    for (const handle of handles) {
      if (typeof handle === 'function') (handle as () => void)()
      else (handle as { dispose?: () => void } | null | undefined)?.dispose?.()
    }
  }
}

/** `GET ?session=<id>` reads, `POST { sessionId, armed }` writes (same-origin only). */
export function createCompactAfterTurnHandler(controller: CompactAfterTurnController) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method === 'GET') {
        const sessionId = new URL(request.url ?? '/', 'http://dsh.local').searchParams.get('session') ?? ''
        if (sessionId === '') return refuse(response, 400, 'bad-request', 'A session query parameter is required.')
        return send(response, 200, { ok: true, value: controller.state(sessionId) })
      }
      if (request.method === 'POST') {
        if (!isSameOriginMutation(request)) return refuse(response, 403, 'forbidden', 'Cross-origin request refused.')
        const body = await readJson(request)
        const sessionId = (body as { sessionId?: unknown } | null)?.sessionId
        const armed = (body as { armed?: unknown } | null)?.armed
        if (typeof sessionId !== 'string' || sessionId === '' || typeof armed !== 'boolean') {
          return refuse(response, 400, 'bad-request', 'Expected { sessionId: string, armed: boolean }.')
        }
        return send(response, 200, { ok: true, value: controller.setArmed(sessionId, armed) })
      }
      response.setHeader('allow', 'GET, POST')
      return refuse(response, 405, 'bad-request', 'Method not allowed.')
    } catch (error) {
      if (error instanceof CompactAfterTurnError) {
        return refuse(response, error.code === 'busy' ? 409 : 503, error.code, error.message)
      }
      return refuse(response, 400, 'bad-request', errorMessage(error))
    }
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function refuse(response: ServerResponse, status: number, code: CompactAfterTurnErrorCode, message: string): void {
  send(response, status, { ok: false, error: { code, message } })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? null : JSON.parse(text)
}
