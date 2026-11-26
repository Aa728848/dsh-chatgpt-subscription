/**
 * Session effort memory for auxiliary requests.
 *
 * The harness sends compaction summaries, Timeline reports and auto-review
 * calls without a reasoning effort, while the session's own turns may name one.
 * Most upstreams render the effort into the request they cache against, so an
 * auxiliary call at a different level re-reads the whole conversation cold: at
 * long context that is slow, expensive, or refused outright (Kimi answers 429).
 *
 * Only the main turn's NAMED effort is remembered, including its absence. A line
 * that fills an unnamed request from its own default then reproduces exactly
 * what the main turn sent, whether that default is a setting or nothing at all.
 */

/** The request fields this memory reads; every harness generation's options satisfy it. */
export interface EffortFollowRequest {
  readonly model: string
  readonly sessionId?: unknown
  readonly purpose?: unknown
  readonly reasoningEffort?: unknown
}

/** Purposes that are a different conversation and must neither read nor write the memory. */
const UNRELATED_PURPOSES: ReadonlySet<string> = new Set(['session-title'])

const DEFAULT_CAP = 500

interface RememberedEffort {
  readonly model: string
  /** The main turn's own value, kept as-is so its branded type survives the copy. */
  readonly effort: unknown
}

function namedEffort(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

/** Per-line memory of each session's latest main-turn model and named effort. */
export class SessionEffortMemory {
  private readonly entries = new Map<string, RememberedEffort>()

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  /**
   * Record a main turn, or give an unnamed auxiliary request the session's effort.
   *
   * @param options - the request as the harness sent it.
   * @param unrelated - true for a request that is structurally a separate
   *   conversation (a title request on a harness that states no purpose).
   * @returns the same object, or a copy carrying the followed effort.
   */
  follow<T extends EffortFollowRequest>(options: T, unrelated = false): T {
    const sessionKey = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
    if (sessionKey === '' || unrelated) return options
    const purpose = options.purpose
    if (typeof purpose === 'string' && UNRELATED_PURPOSES.has(purpose)) return options
    const named = namedEffort(options.reasoningEffort)

    if (purpose !== undefined && purpose !== null) {
      if (named !== undefined) return options
      const remembered = this.entries.get(sessionKey)
      if (remembered === undefined || remembered.model !== options.model || remembered.effort === undefined) return options
      return { ...options, reasoningEffort: remembered.effort }
    }

    // Delete-then-set refreshes recency, so the cap drops the least recently used session.
    this.entries.delete(sessionKey)
    this.entries.set(sessionKey, { model: options.model, effort: named })
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return options
  }
}
