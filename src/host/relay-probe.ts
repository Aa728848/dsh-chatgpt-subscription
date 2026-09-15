/**
 * Read-only diagnostic probe for the child→parent subagent relay.
 *
 * The probe answers one question with evidence: when a continuable child tells
 * its parent it finished (`send_message` or the runtime settlement notice),
 * what did the parent's side actually do — was the message inserted into the
 * inbox, claimed, turned into a model request, and did that turn produce any
 * visible content? It observes durable session events plus the live Agent
 * snapshot and writes metadata-only lines: never prompt text, never file
 * contents, never credentials. The only message text it copies is a bounded
 * excerpt of a tool result that matches a known delivery-failure marker.
 *
 * It is inert unless {@link RELAY_PROBE_ENV} is truthy, it never throws into the
 * host (a diagnostic must not break the deployment), and it writes nothing but
 * the log file.
 *
 * @module dsh-chatgpt-subscription/relay-probe
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHomeDir } from './antigravity/token-store.ts'

/** Environment switch: any of `1`, `true`, `yes`, `on` enables the probe. */
export const RELAY_PROBE_ENV = 'DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE'

/** Environment override for the log path (default `$DSH_HOME/relay-probe.log`). */
export const RELAY_PROBE_FILE_ENV = 'DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE_FILE'

/** Default log file name inside the DSH home. */
export const RELAY_PROBE_FILE_NAME = 'relay-probe.log'

/** A probe log is truncated once it grows past this size. */
export const RELAY_PROBE_MAX_BYTES = 2 * 1024 * 1024

const SUMMARY_MAX = 120
const EXCERPT_MAX = 200
const DEFAULT_MAX_OBSERVED_SESSIONS = 64

/** Message source kinds that cross the child→parent delivery boundary. */
export const RELAY_SOURCE_KINDS: readonly string[] = [
  'agent-message',
  'subagent-settled',
  'subagent-report',
]

/** Tool names a child uses to report back to its parent. */
const CHILD_SEND_TOOLS: readonly string[] = ['send_message', 'report']

/** Phrases that mark a delivery the runtime refused. */
const DELIVERY_FAILURE_MARKERS: readonly string[] = [
  'direct parent is not live',
  'PARENT_UNAVAILABLE',
  'was not delivered',
  'is closing',
  'ACTIVATION_CLOSING',
]

/** One Session as this probe reads it. */
export interface ProbeSession {
  readonly id: string
  /** A real Session header carries many more fields; only two are read here. */
  readonly header?: {
    readonly origin?: unknown
    readonly parentSession?: unknown
    readonly [key: string]: unknown
  } | undefined
}

/** One durable session event as this probe reads it. */
export interface ProbeEvent {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: unknown
}

/** Live Agent fields this probe snapshots (never mutated). */
export interface ProbeAgent {
  readonly status?: unknown
  readonly inbox?: {
    readonly nextStep?: readonly unknown[]
    readonly nextTurn?: readonly unknown[]
  } | undefined
}

/** Registry lookup for the live Agent behind a Session id. */
export interface AgentsLookup {
  get(id: string): ProbeAgent | undefined
}

/** Where probe lines go. */
export interface RelayProbeSink {
  write(line: string): void
}

/** Construction inputs for {@link RelayProbe}. */
export interface RelayProbeOptions {
  readonly sink: RelayProbeSink
  readonly agents?: AgentsLookup | undefined
  readonly clock?: (() => number) | undefined
  readonly maxObservedSessions?: number | undefined
}

/** The Context surface {@link installRelayProbe} needs. */
export interface RelayProbeContext {
  on(event: 'session/event', listener: (session: ProbeSession, event: ProbeEvent) => void): unknown
  get?(name: string): unknown
  logger?: { info(message: string): void } | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Collapse to one bounded log-safe line. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Durable label for a Session: full ids so a captured line matches the GUI list. */
function sessionTag(session: ProbeSession | undefined): string {
  if (session === undefined) return 'session=?'
  const id = typeof session.id === 'string' && session.id !== '' ? session.id : '?'
  const origin = text(session.header?.origin)
  const parent = text(session.header?.parentSession)
  const parentTag = parent === undefined || parent === '' ? '' : ` parent=${parent}`
  return `session=${id}${parentTag}${origin === undefined ? '' : ` origin=${origin}`}`
}

/** Block-type histogram plus whether a message carries anything the user can see. */
function blocksSummary(content: unknown): string {
  if (!Array.isArray(content)) return 'blocks=none visible=no'
  const counts = new Map<string, number>()
  let visible = false
  let chars = 0
  for (const block of content) {
    const value = record(block)
    const type = text(value?.type) ?? 'unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
    if (type === 'tool-call') visible = true
    const body = text(value?.text)
    if (body !== undefined) {
      chars += body.length
      if (type === 'text' && body.trim().length > 0) visible = true
    }
  }
  const histogram = [...counts].map(([type, n]) => `${type}:${n}`).join(',')
  return `blocks=${histogram || 'none'} chars=${chars} visible=${visible ? 'yes' : 'no'}`
}

/**
 * Observes delivery boundaries and the parent turns they should produce.
 *
 * Every method is fail-open: an unexpected shape is dropped, never thrown.
 */
export class RelayProbe {
  private readonly observed = new Set<string>()
  private readonly started: number
  private readonly clock: () => number
  private readonly maxObserved: number
  private seen: number | undefined
  /** Count of observations dropped by the fail-open boundary. */
  failures = 0

  constructor(private readonly options: RelayProbeOptions) {
    this.clock = options.clock ?? (() => Date.now())
    this.started = this.clock()
    this.maxObserved = Math.max(1, options.maxObservedSessions ?? DEFAULT_MAX_OBSERVED_SESSIONS)
  }

  /** Observe one durable session event. */
  observe(session: ProbeSession, event: ProbeEvent): void {
    try {
      this.step(session, event)
    } catch {
      this.failures += 1
    }
  }

  private step(session: ProbeSession, event: ProbeEvent): void {
    const type = text(event?.type)
    if (type === undefined) return
    const data = record(event.data)
    if (data === undefined) return
    switch (type) {
      case 'agent/inbox/spliced':
        this.onSplice(session, data)
        return
      case 'user/message':
        this.onUserMessage(session, data)
        return
      case 'tool/call':
        this.onToolCall(session, data)
        return
      case 'tool/result':
        this.onToolResult(session, data)
        return
      default:
        break
    }
    if (!this.observed.has(session.id)) return
    switch (type) {
      case 'turn/start':
        this.line(`turn-start turn=${count(data.turn) ?? '?'}`)
        return
      case 'turn/end':
        this.line(`turn-end turn=${count(data.turn) ?? '?'} reason=${this.turnReason(data.reason)}`)
        this.line(`agent-state ${this.agentState(session)}`)
        return
      case 'step/start':
        this.line(`step-start turn=${count(data.turn) ?? '?'} step=${count(data.step) ?? '?'}`)
        return
      case 'request/header':
        this.observedRequest(data)
        return
      case 'assistant/message': {
        const message = record(data.message)
        const source = record(message?.source)
        const model = source === undefined
          ? ''
          : ` model=${text(source.provider) ?? '?'}/${text(source.model) ?? '?'}`
        this.line(`assistant turn=${count(data.turn) ?? '?'} step=${count(data.step) ?? '?'}${model} ${blocksSummary(message?.content)}`)
        return
      }
      default:
        return
    }
  }

  /** A delivery entering (or leaving) the parent's inbox. */
  private onSplice(session: ProbeSession, data: Record<string, unknown>): void {
    const target = text(data.target) ?? '?'
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    const removed = count(data.removedCount) ?? 0
    const outcomes: string[] = []
    for (const entry of inserted) {
      const message = record(entry)
      const source = record(message?.source)
      const kind = text(source?.kind) ?? ''
      if (!RELAY_SOURCE_KINDS.includes(kind)) continue
      outcomes.push(`kind=${kind}${this.formTag(source)} msg=${text(message?.id) ?? '?'}`)
    }
    if (outcomes.length > 0) {
      this.watch(session)
      this.line(`inbox-insert ${sessionTag(session)} target=${target} pending=${this.pending(session)} ${outcomes.join(' ')}`)
      return
    }
    if (!this.observed.has(session.id)) return
    if (removed === 0 && inserted.length === 0) return
    const outcome = text(data.outcome)
    this.line(`inbox-splice ${sessionTag(session)} target=${target} inserted=${inserted.length} removed=${removed}${outcome === undefined ? '' : ` outcome=${outcome}`} pending=${this.pending(session)}`)
  }

  /** A message committed to the session surface — for a relay, the claim. */
  private onUserMessage(session: ProbeSession, data: Record<string, unknown>): void {
    const message = record(data.message)
    const source = record(message?.source)
    const kind = text(source?.kind) ?? '?'
    const boundary = RELAY_SOURCE_KINDS.includes(kind)
    if (boundary) this.watch(session)
    if (!boundary && !this.observed.has(session.id)) return
    const sender = text(source?.senderSessionId)
    const senderTag = sender === undefined || sender === '' ? '' : ` sender=${sender}`
    this.line(`user-committed ${sessionTag(session)} kind=${kind}${this.formTag(source)} msg=${text(message?.id) ?? '?'}${senderTag} turn=${count(data.turn) ?? '-'} ${blocksSummary(message?.content)} pending=${this.pending(session)}`)
    if (boundary) this.line(`agent-state ${this.agentState(session)}`)
  }

  /** A child attempting to report to its parent. */
  private onToolCall(session: ProbeSession, data: Record<string, unknown>): void {
    const message = record(data.message)
    if (!Array.isArray(message?.content)) return
    for (const block of message.content) {
      const value = record(block)
      if (text(value?.type) !== 'tool-call') continue
      const name = text(value?.name) ?? ''
      if (!CHILD_SEND_TOOLS.includes(name)) continue
      this.line(`child-send ${sessionTag(session)} tool=${name} call=${text(value?.id) ?? '?'}`)
    }
  }

  /** A tool result that may be a refused delivery. */
  private onToolResult(session: ProbeSession, data: Record<string, unknown>): void {
    const message = record(data.message)
    if (!Array.isArray(message?.content)) return
    for (const block of message.content) {
      const value = record(block)
      if (value === undefined || text(value.type) !== 'tool-result') continue
      const body = this.toolResultText(value.content)
      const marker = DELIVERY_FAILURE_MARKERS.find(candidate => body.includes(candidate))
      if (marker === undefined) continue
      this.line(`child-send-failed ${sessionTag(session)} call=${text(value.toolCallId) ?? '?'} marker=${JSON.stringify(marker)} excerpt=${JSON.stringify(oneLine(body, EXCERPT_MAX))}`)
    }
  }

  private toolResultText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const block of content) {
      const value = record(block)
      const body = text(value?.text)
      if (body !== undefined) parts.push(body)
    }
    return parts.join(' ')
  }

  private observedRequest(data: Record<string, unknown>): void {
    const header = record(data.header)
    const config = record(header?.config)
    if (config === undefined) return
    const series = data.startsSeries === true ? ' startsSeries=yes' : ''
    this.line(`request provider=${text(config.provider) ?? '?'} model=${text(config.model) ?? '?'} reason=${text(data.reason) ?? '-'}${series}`)
  }

  private turnReason(reason: unknown): string {
    const value = record(reason)
    if (value === undefined) return oneLine(String(reason ?? '?'), SUMMARY_MAX)
    const kind = text(value.kind) ?? '?'
    const failure = record(value.error)
    if (failure === undefined) return kind
    const code = text(failure.code) ?? '?'
    const message = text(failure.message)
    return message === undefined ? `${kind} code=${code}` : `${kind} code=${code} message=${JSON.stringify(oneLine(message, SUMMARY_MAX))}`
  }

  private formTag(source: Record<string, unknown> | undefined): string {
    if (source === undefined) return ''
    const form = text(source.form)
    const summary = text(source.summary)
    const plugin = text(source.plugin)
    return `${form === undefined ? '' : ` form=${form}`}${plugin === undefined ? '' : ` plugin=${plugin}`}${summary === undefined ? '' : ` summary=${JSON.stringify(oneLine(summary, SUMMARY_MAX))}`}`
  }

  /** Live snapshot of the Agent behind this Session, when it is resident. */
  private agentState(session: ProbeSession): string {
    const agent = this.options.agents?.get(session.id)
    if (agent === undefined) return `${sessionTag(session)} resident=no`
    const status = text(agent.status) ?? '?'
    return `${sessionTag(session)} resident=yes status=${status} pending=${agent.inbox === undefined ? '?' : `nextStep:${agent.inbox.nextStep?.length ?? 0},nextTurn:${agent.inbox.nextTurn?.length ?? 0}`}`
  }

  private pending(session: ProbeSession): string {
    const agent = this.options.agents?.get(session.id)
    if (agent?.inbox === undefined) return 'nextStep:?,nextTurn:?'
    return `nextStep:${agent.inbox.nextStep?.length ?? 0},nextTurn:${agent.inbox.nextTurn?.length ?? 0}`
  }

  private watch(session: ProbeSession): void {
    if (this.observed.has(session.id)) return
    if (this.observed.size >= this.maxObserved) {
      const oldest = this.observed.values().next()
      if (!oldest.done) this.observed.delete(oldest.value)
    }
    this.observed.add(session.id)
  }

  private line(line: string): void {
    const elapsed = Math.max(0, this.clock() - this.started)
    const stamp = new Date(this.clock()).toISOString()
    try {
      this.options.sink.write(`${stamp} +${elapsed}ms ${line}`)
    } catch {
      this.failures += 1
    }
  }

  /** One startup line so a captured file says which process wrote it. */
  head(path: string): void {
    this.line(`probe-start pid=${process.pid} path=${JSON.stringify(path)}`)
  }

  /** Sessions currently under observation. */
  get observedCount(): number {
    return this.observed.size
  }

  /** Event sequence number of the last observed event, when present. */
  mark(seq: unknown): void {
    const value = count(seq)
    if (value !== undefined) this.seen = value
  }

  /** Last observed durable sequence number, when the log carried one. */
  get lastSeq(): number | undefined {
    return this.seen
  }
}

/** Where the probe reads a fallback value from, beside the process environment. */
export interface RelayProbeEnvOptions {
  /**
   * An env-file consulted after the process environment. Defaults to no file so
   * a caller (or a test) never reads configuration behind the injected
   * environment's back; {@link relayProbeEnvFile} names the deployment default.
   */
  readonly envFile?: string | null
  /** DSH home used for the default log path and env file. */
  readonly home?: string
}

/** The deployment's env file, `$DSH_HOME/.env`, as the proxy settings already read it. */
export function relayProbeEnvFile(home: string = dshHomeDir()): string {
  return join(home, '.env')
}

/**
 * Read one probe key from the process environment, then from the env file.
 * The key is always one of this module's own constants, so it is safe to
 * interpolate into the lookup pattern.
 * @param key - constant probe key.
 * @param env - environment to read first.
 * @param options - optional env-file fallback and DSH home.
 * @returns the trimmed value, or undefined when neither source sets one.
 */
export function relayProbeEnvValue(
  key: string,
  env: Record<string, string | undefined>,
  options: RelayProbeEnvOptions = {},
): string | undefined {
  const direct = env[key]?.trim()
  if (direct !== undefined && direct !== '') return direct
  if (options.envFile === undefined || options.envFile === null) return undefined
  try {
    if (!existsSync(options.envFile)) return undefined
    const content = readFileSync(options.envFile, 'utf8')
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*["']?([^"'\\r\\n]*)["']?\\s*$`, 'm')
    const value = content.match(pattern)?.[1]?.trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Whether the environment enables the probe. */
export function relayProbeEnabled(
  env: Record<string, string | undefined> = process.env,
  options: RelayProbeEnvOptions = {},
): boolean {
  const raw = relayProbeEnvValue(RELAY_PROBE_ENV, env, options)?.toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/** Resolve the probe log path from the environment. */
export function relayProbeLogPath(
  env: Record<string, string | undefined> = process.env,
  options: RelayProbeEnvOptions = {},
): string {
  const override = relayProbeEnvValue(RELAY_PROBE_FILE_ENV, env, options)
  return override ?? join(options.home ?? dshHomeDir(), RELAY_PROBE_FILE_NAME)
}

/** Append-only file sink that truncates itself past a size cap. */
export function createFileRelayProbeSink(
  options: { path: string; maxBytes?: number },
): RelayProbeSink {
  const maxBytes = options.maxBytes ?? RELAY_PROBE_MAX_BYTES
  let ready = false
  return {
    write(line: string): void {
      try {
        if (!ready) {
          mkdirSync(dirname(options.path), { recursive: true })
          ready = true
        }
        const size = statSync(options.path, { throwIfNoEntry: false })?.size ?? 0
        if (size > maxBytes) writeFileSync(options.path, '', 'utf8')
        appendFileSync(options.path, `${line}\n`, 'utf8')
      } catch {
        // A diagnostic sink must never break the host process.
      }
    },
  }
}

/**
 * Subscribe the probe to durable session events.
 * @param ctx - host context (or its probe-facing subset).
 * @param options - sink, optional agent lookup, and optional clock.
 * @returns the disposer that detaches the listener.
 */
export function installRelayProbe(
  ctx: RelayProbeContext,
  options: RelayProbeOptions & { path?: string },
): () => void {
  const agents = options.agents ?? (ctx.get?.('agents') as AgentsLookup | undefined)
  const probe = new RelayProbe(agents === undefined ? options : { ...options, agents })
  probe.head(options.path ?? '(unknown)')
  const listener = (session: ProbeSession, event: ProbeEvent): void => {
    probe.observe(session, event)
  }
  const handle = ctx.on('session/event', listener)
  return () => {
    if (typeof handle === 'function') {
      (handle as () => void)()
      return
    }
    const disposable = handle as { dispose?: () => void } | null | undefined
    disposable?.dispose?.()
  }
}
