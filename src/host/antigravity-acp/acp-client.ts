/**
 * Minimal ACP v1 client over stdio JSON-RPC.
 *
 * Why hand-written: the protocol surface this line needs is small and stable
 * (initialize / session\/* / a handful of notifications), and this repository's
 * rule is that a provider line adds no runtime dependency it cannot justify. The
 * official SDK would be a second protocol implementation inside a bundle that
 * already ships one transport per line; the frames below are transcribed from
 * the running server's own output, not from a specification draft.
 *
 * Two invariants shape this file:
 *
 * 1. **stdout carries protocol only.** Anything this process wants to say goes to
 *    stderr or nowhere. A stray `console.log` in a caller would corrupt the
 *    stream, so nothing here writes to stdout either.
 * 2. **A frame is a complete line.** NDJSON split across chunk boundaries is
 *    normal on a pipe; splitting on the newline is therefore not "good enough",
 *    it is the only correct rule, and a decoder must carry its remainder.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/acp-client
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** One JSON-RPC request id. */
export type AcpRequestId = number

/** One decoded protocol message. Unknown shapes stay opaque on purpose. */
export interface AcpMessage {
  jsonrpc?: string
  id?: AcpRequestId | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

/** How the client reaches the agent process. */
export interface AcpSpawnOptions {
  /** Absolute path to the executable. */
  command: string
  /** Arguments after the executable; `acp` is added by the caller. */
  args?: readonly string[]
  /** Working directory for the agent process. */
  cwd: string
  /** Extra environment entries layered over a scrubbed copy of this process's environment. */
  env?: Readonly<Record<string, string>>
  /** Grace after stdin EOF before the process is killed. */
  disposeEofGraceMs?: number
  /** Grace between the kill signal and a forced termination. */
  disposeGraceMs?: number
}

/** Handlers the session layers install on one connection. */
export interface AcpClientHandlers {
  /** A `session/update` notification, already unwrapped to its `update` payload. */
  onSessionUpdate?(sessionId: string, update: Record<string, unknown>): void
  /** A `session/request_permission` request; return the chosen option id or undefined to cancel. */
  onPermissionRequest?(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<string | undefined> | string | undefined
  /** Called once when the child exits, with the reason it will be reported as. */
  onExit?(detail: AcpExitDetail): void
  /** Called whenever bytes arrive, so a watchdog can tell a slow model from a dead pipe. */
  onActivity?(): void
}

/** Why the agent process is gone. */
export interface AcpExitDetail {
  /** Exit code when the process exited normally. */
  code?: number | null
  /** Signal when it was terminated. */
  signal?: string | null
  /** A bounded, human-readable tail of stderr; never contains a protocol frame. */
  stderrTail?: string
}

/** One ACP method failure, classified for the adapter's error mapping. */
export class AcpError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'AcpError'
    this.code = code
  }
}

/** Bound on the stderr tail kept for diagnostics. */
const STDERR_TAIL_BYTES = 2_048

/** Bound on one queued outbound frame; a caller cannot make the agent buffer without limit. */
const MAX_PENDING_REQUESTS = 64

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

/**
 * One live ACP connection.
 *
 * A connection is not reentrant: the adapter owns turn sequencing, and this class
 * only guarantees that a response settles its own request and that a notification
 * reaches its handler in arrival order.
 */
export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder = new StringDecoder('utf8')
  private readonly pending = new Map<AcpRequestId, PendingRequest>()
  private remainder = ''
  private nextId = 1
  private closed = false
  private stderrTail = ''
  private handlers: AcpClientHandlers
  private readonly disposeEofGraceMs: number
  private readonly disposeGraceMs: number
  private exitDetail: AcpExitDetail | undefined

  constructor(options: AcpSpawnOptions, handlers: AcpClientHandlers = {}) {
    this.handlers = handlers
    this.disposeEofGraceMs = options.disposeEofGraceMs ?? 6_000
    this.disposeGraceMs = options.disposeGraceMs ?? 3_000
    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...scrubbedEnvironment(), ...options.env },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.handlers.onActivity?.()
      this.consume(this.decoder.write(chunk))
    })
    this.child.stdout.on('end', () => {
      this.consume(this.decoder.end())
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    this.child.on('error', (error) => this.failAll(error))
    this.child.on('exit', (code, signal) => {
      this.exitDetail = {
        code,
        signal,
        ...(this.stderrTail === '' ? {} : { stderrTail: redactStderr(this.stderrTail) }),
      }
      this.closed = true
      this.failAll(new AcpError(`Antigravity ACP process exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`))
      this.handlers.onExit?.(this.exitDetail)
    })
  }

  /** Whether the underlying process is still running. */
  get alive(): boolean {
    return !this.closed
  }

  /**
   * Replace the handlers for the next turn.
   *
   * A warm process outlives the turn that started it, and every turn owns its own
   * update queue and bridge. Re-binding is how a pooled connection is handed to
   * the next turn without leaking the previous turn's queue into it.
   *
   * @param handlers - the next turn's callbacks.
   */
  rebind(handlers: AcpClientHandlers): void {
    this.handlers = handlers
  }

  /** The exit facts, once the process is gone. */
  get exit(): AcpExitDetail | undefined {
    return this.exitDetail
  }

  /**
   * Send one request and resolve with its `result`.
   *
   * @param method - ACP method name.
   * @param params - Method parameters.
   * @param signal - Caller cancellation; aborting rejects this request only.
   * @returns The `result` payload, opaque to this class.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpError('Antigravity ACP process is not running'))
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AcpError('Too many in-flight Antigravity ACP requests', -32603))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id)
        reject(abortError())
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Send one notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.closed) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Stop the process.
   *
   * Closing stdin first gives the agent its documented shutdown path; only a
   * process that does not exit inside the grace is signalled. Both graces are
   * bounded so a wedged child cannot hold a turn forever.
   */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failAll(new AcpError('Antigravity ACP connection closed'))
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    try {
      this.child.stdin.end()
    } catch {
      // Already gone; the exit promise below still settles.
    }
    if (await settlesWithin(exited, this.disposeEofGraceMs)) return
    try {
      this.child.kill()
    } catch {
      // Escalation below is unconditional.
    }
    if (await settlesWithin(exited, this.disposeGraceMs)) return
    try {
      this.child.kill('SIGKILL')
    } catch {
      // Nothing left to escalate to.
    }
  }

  private write(message: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private consume(text: string): void {
    if (text === '') return
    this.remainder += text
    for (;;) {
      const index = this.remainder.indexOf('\n')
      if (index < 0) break
      const line = this.remainder.slice(0, index).trim()
      this.remainder = this.remainder.slice(index + 1)
      if (line === '') continue
      let message: AcpMessage
      try {
        message = JSON.parse(line) as AcpMessage
      } catch {
        // A malformed line is a protocol violation, not a licence to kill the
        // process: the server may have appended a diagnostic. It is counted but
        // not echoed - the raw frame could carry anything.
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: AcpMessage): void {
    if (typeof message.method === 'string' && message.id !== undefined) {
      void this.handleServerRequest(message.method, message.id, message.params)
      return
    }
    if (typeof message.method === 'string') {
      if (message.method === 'session/update') {
        const params = asRecord(message.params)
        const sessionId = asString(params?.sessionId)
        const update = asRecord(params?.update)
        if (sessionId !== undefined && update !== undefined) this.handlers.onSessionUpdate?.(sessionId, update)
      }
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (message.error !== undefined) {
      pending.reject(new AcpError(message.error.message ?? 'Antigravity ACP request failed', message.error.code))
      return
    }
    pending.resolve(message.result)
  }

  private async handleServerRequest(method: string, id: AcpRequestId | string, params: unknown): Promise<void> {
    if (method !== 'session/request_permission') {
      // Anything this client does not implement is refused explicitly; silently
      // ignoring it would leave the agent waiting on a response forever.
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported ACP request: ${method}` } })
      return
    }
    const record = asRecord(params) ?? {}
    const sessionId = asString(record.sessionId) ?? ''
    let optionId: string | undefined
    try {
      optionId = await this.handlers.onPermissionRequest?.(sessionId, record)
    } catch {
      optionId = undefined
    }
    if (optionId === undefined) {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
      return
    }
    this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId } } })
  }

  private failAll(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

function abortError(): Error {
  const error = new Error('Antigravity ACP request was cancelled')
  error.name = 'AbortError'
  return error
}

/** Resolve after the promise or the budget, whichever comes first. */
function settlesWithin(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, budgetMs)
    timer.unref?.()
    void promise.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * A copy of this process's environment without credentials.
 *
 * The agent authenticates itself and must not inherit a provider key from the
 * host's own environment; the caller may still layer explicit entries on top.
 */
function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/key|token|secret|password|credential/i.test(key)) continue
    env[key] = value
  }
  return env
}

function redactStderr(text: string): string {
  return text.replace(/([A-Za-z0-9_\-]{24,})/g, '[redacted]').slice(-STDERR_TAIL_BYTES)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
