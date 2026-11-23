/**
 * Skip the automatic LLM session-title request on this plugin's own lines.
 *
 * DSH titles a fresh session by sending one extra auxiliary `llm/stream` call
 * (`purpose: 'session-title'`) through the conversation's own provider/model
 * after the first human message. Every subscription line in this plugin pays
 * for that call out of its own quota, and the user does not want it.
 *
 * The seam is `llm/stream`, the same one `compaction-route` uses: it wraps the
 * adapter dispatch, so returning without `next()` never reaches the provider
 * and spends nothing. The title service treats a request that yields no text as
 * an ordinary generation failure — it logs one warning and keeps the
 * deterministic first-message fallback title — so the sidebar keeps a real
 * title while no title request leaves the machine.
 *
 * Scope is the plugin's own lines: any other provider a user happens to have
 * configured keeps its titles untouched.
 *
 * @module dsh-chatgpt-subscription/session-title-guard
 */

/** The subset of `llm/stream` options this guard reads. */
export interface SessionTitleStreamOptions {
  readonly provider?: string | undefined
  /** `session-title` on the auxiliary title call; absent on a conversation turn. */
  readonly purpose?: string | undefined
}

/** A chunk as it crosses the stream boundary; only a terminal `finish` is produced. */
export interface SessionTitleChunk {
  readonly type: string
  readonly reason?: { readonly kind?: string | undefined } | undefined
}

/** The `llm/stream` waterfall listener this guard registers. */
export type SessionTitleStreamListener = (
  options: SessionTitleStreamOptions,
  next: () => AsyncIterable<SessionTitleChunk>,
) => AsyncIterable<SessionTitleChunk>

/** Services the guard needs, injected so the decision is testable without a host. */
export interface SessionTitleGuardDeps {
  /** The providers whose sessions skip the automatic title request. */
  readonly providers: readonly string[]
  /** Live switch, read per request so a settings change applies at once. */
  readonly enabled?: (() => boolean) | undefined
}

/** The context surface this guard needs, declared structurally per harness generation. */
export interface SessionTitleGuardContext {
  on?(
    event: 'llm/stream',
    listener: SessionTitleStreamListener,
    options?: { readonly global?: boolean },
  ): unknown
}

/** Live handle for teardown. */
export interface SessionTitleGuardHandle {
  dispose(): void
}

/**
 * Install the `llm/stream` listener that short-circuits title requests.
 *
 * Returns `undefined` when the host exposes no event bus, so a caller can skip
 * installation instead of failing the plugin's load.
 *
 * @param ctx - structural context: the event bus.
 * @param deps - the scoped providers and the live enable switch.
 * @returns the live handle, or `undefined` on a host without an event bus.
 */
export function installSessionTitleGuard(
  ctx: SessionTitleGuardContext,
  deps: SessionTitleGuardDeps,
): SessionTitleGuardHandle | undefined {
  const on = ctx.on
  if (typeof on !== 'function') return undefined
  const providers = new Set(deps.providers)
  const skipped: SessionTitleStreamListener = async function* skipTitle(options, next) {
    if (options.purpose !== 'session-title') return yield* next()
    if (options.provider === undefined || !providers.has(options.provider)) return yield* next()
    if (deps.enabled !== undefined && !deps.enabled()) return yield* next()
    // No `next()`: the adapter is never dispatched, so no title request is sent.
    // An empty `stop` stream makes the title provider reject cleanly and the
    // service keep its deterministic fallback title.
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const dispose = on('llm/stream', skipped, { global: true })
  return { dispose: () => { if (typeof dispose === 'function') dispose() } }
}
