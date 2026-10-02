/**
 * Optional Responses-over-WebSocket transport for the ChatGPT line.
 *
 * The official client keeps one connection per session and reuses it across
 * turns, which removes a handshake and a round trip from every step of a tool
 * loop. That is a real win, but it is also a protocol this route has not
 * confirmed the subscription endpoint speaks, so the transport is opt-in:
 * nothing here changes the default SSE path, and any failure at all returns the
 * caller to SSE instead of failing the turn.
 *
 * Three rules keep that safe:
 *
 * - Connections are bound to the auth owner that opened them. A rotated account
 *   never reuses another account's connection or its incremental state.
 * - The circuit breaker is per session: repeated failures stop further attempts
 *   for a while, so a route that does not speak WebSocket costs one timeout
 *   rather than one per turn.
 * - Idle connections are recycled, because a pooled socket nothing closes keeps
 *   a host process alive and holds a session's state open.
 *
 * Incremental continuation and prewarm are deliberately NOT implemented here.
 * Both change what is sent, not just how, and both need the endpoint confirmed
 * before a tool call could be duplicated or lost.
 *
 * @module dsh-chatgpt-subscription/responses-websocket
 */

/** Minimal socket surface this transport needs; the global WebSocket satisfies it. */
export interface SocketLike {
  readonly readyState: number
  close(code?: number, reason?: string): void
}

/** Connection factory seam, so tests can supply a socket without a network. */
export type SocketFactory = (url: string, headers: Record<string, string>) => Promise<SocketLike>

export interface WebSocketTransportOptions {
  /** Endpoint the subscription backend serves WebSocket responses on. */
  url: string
  /** Headers a fresh connection is opened with; re-read per connection. */
  headers: () => Record<string, string>
  socketFactory: SocketFactory
  /** Recycle a socket idle this long. */
  idleTimeoutMs?: number
  /** Consecutive failures before further attempts are suppressed. */
  failureThreshold?: number
  /** How long the breaker stays open after the threshold is reached. */
  breakerCooldownMs?: number
}

interface SessionEntry {
  socket: SocketLike
  owner: string
  timer: ReturnType<typeof setTimeout> | undefined
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const DEFAULT_FAILURE_THRESHOLD = 2
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000

export class ResponsesWebSocketTransport {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly failures = new Map<string, { count: number; until: number }>()
  private readonly idleTimeoutMs: number
  private readonly failureThreshold: number
  private readonly breakerCooldownMs: number

  constructor(private readonly options: WebSocketTransportOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS
  }

  /** Sessions with an open socket right now. */
  get openSessions(): number {
    return this.sessions.size
  }

  /**
   * A socket for this session, or undefined when none can be had.
   *
   * Undefined is the normal answer, not an error: it means the caller should use
   * its ordinary transport. Every failure path resolves that way rather than
   * throwing, so a route that cannot use WebSocket behaves exactly as it did
   * before this existed.
   */
  async connect(sessionId: string, owner: string): Promise<SocketLike | undefined> {
    if (this.breakerOpen(sessionId)) return undefined
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      // Another account's socket is not this account's to reuse.
      if (existing.owner !== owner) this.close(sessionId)
      else {
        this.touch(sessionId, existing)
        this.noteSuccess(sessionId)
        return existing.socket
      }
    }

    try {
      const socket = await this.options.socketFactory(this.options.url, this.options.headers())
      const entry: SessionEntry = { socket, owner, timer: undefined }
      this.sessions.set(sessionId, entry)
      this.touch(sessionId, entry)
      this.noteSuccess(sessionId)
      return socket
    } catch {
      this.noteFailure(sessionId)
      return undefined
    }
  }

  /** Close and forget one session's socket. */
  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return
    this.sessions.delete(sessionId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    try {
      entry.socket.close()
    } catch {
      // A socket that is already gone needs no closing.
    }
  }

  /** Close every socket this transport opened. */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.close(sessionId)
  }

  /** Report a transport failure; the breaker decides about the next attempt. */
  noteFailure(sessionId: string): void {
    const state = this.failures.get(sessionId) ?? { count: 0, until: 0 }
    state.count += 1
    if (state.count >= this.failureThreshold) state.until = Date.now() + this.breakerCooldownMs
    this.failures.set(sessionId, state)
  }

  /** Failure bookkeeping for one session, for diagnostics. */
  failureState(sessionId: string): { count: number; until: number } | undefined {
    return this.failures.get(sessionId)
  }

  private noteSuccess(sessionId: string): void {
    this.failures.delete(sessionId)
  }

  /**
   * Whether further attempts for this session are currently suppressed.
   *
   * A read-only peek: it never clears expired state, so calling it cannot change
   * what the next attempt does. The connect path owns the transition.
   */
  isBreakerOpen(sessionId: string): boolean {
    const state = this.failures.get(sessionId)
    return state !== undefined && state.until > Date.now()
  }

  private breakerOpen(sessionId: string): boolean {
    const state = this.failures.get(sessionId)
    if (state === undefined) return false
    if (state.until > Date.now()) return true
    if (state.until === 0) return false
    // A real open window has now passed, so the route gets a fresh streak rather
    // than staying suppressed forever on one old failure.
    this.failures.set(sessionId, { count: 0, until: 0 })
    return false
  }

  private touch(sessionId: string, entry: SessionEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      this.close(sessionId)
    }, this.idleTimeoutMs)
    // A recycled timer must not be the only thing holding this host open.
    entry.timer.unref?.()
  }
}