/**
 * One contested provider route, claimed the same way by every line this plugin
 * adds.
 *
 * Each line registers an adapter for a provider id another adapter family may
 * already own — the generic pi-ai provider configured with the same endpoint is
 * the usual rival. Registration is all-or-nothing and DSH rejects a duplicate
 * route, so a claim takes the route when it is free, reports the conflict when
 * it is not, and claims it again as soon as the owner releases it.
 *
 * A composition without the event seam (or a reduced test context) still serves
 * the route; only the automatic claim on release is unavailable.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

/** `ctx.llm.registerAdapter`, the seam every line claims its route through. */
type RegisterAdapter = LlmRuntime['registerAdapter']

/** The harness adapter type `registerAdapter` accepts, without naming any adapter class. */
type ProviderRouteAdapter = Parameters<RegisterAdapter>[1]

/** What a successful claim returns: the disposer this plugin releases on unload. */
type ProviderRouteRegistration = ReturnType<RegisterAdapter>

/** Live claim of one provider route, as the line's status route reads it. */
export interface ProviderRouteClaim {
  /** Whether this plugin currently owns the route. */
  serving(): boolean
  /** Why the route is served by another adapter, or `null` while this plugin owns it. */
  conflict(): string | null
  /** Release the update watch (if any) and then the registration handle, in that order. */
  dispose(): void
}

/**
 * Claim one provider route for this plugin and keep claiming it.
 *
 * The route is taken immediately, and every `llm/adapters-updated` reports the
 * claim again — it is a no-op while the registration is held, and takes the
 * route back once another owner releases it. A rejected claim is remembered
 * rather than thrown, because the line whose route table asks through
 * {@link ProviderRouteClaim.conflict} still has to render.
 * @param ctx - The plugin context owning the `llm` service and the event seam.
 * @param options - The route id, the display label the two log lines name, and the adapter serving it.
 * @returns The claim's state and its disposer.
 */
export function claimProviderRoute(
  ctx: Context,
  options: {
    /** The provider route id this plugin contends for. */
    providerId: string
    /** Display label for that line, interpolated into both lifecycle log lines. */
    label: string
    /** The adapter instance to register for the route. */
    adapter: ProviderRouteAdapter
    /**
     * Whether to re-claim the route on `llm/adapters-updated` (default `true`).
     * The Ollama line passes `false`: it has never watched the event, so it
     * keeps its single claim at setup.
     */
    watch?: boolean
  },
): ProviderRouteClaim {
  let registration: ProviderRouteRegistration | undefined
  let conflict: string | null = null

  const claim = (): void => {
    if (registration !== undefined) return
    try {
      registration = ctx.llm.registerAdapter([options.providerId], options.adapter)
      if (conflict !== null) {
        ctx.logger.info(`[dsh-chatgpt-subscription] ${options.label} route "${options.providerId}" is now served by this plugin`)
      }
      conflict = null
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(
        `[dsh-chatgpt-subscription] provider route "${options.providerId}" is already owned by another adapter; `
        + `${options.label} models keep being served by that one until its configuration is removed (${conflict})`,
      )
    }
  }
  claim()
  const watch = options.watch === false || typeof ctx.on !== 'function'
    ? undefined
    : ctx.on('llm/adapters-updated', () => {
        claim()
      })

  return {
    serving: () => registration !== undefined,
    conflict: () => conflict,
    dispose: () => {
      releaseHandle(watch)
      registration?.()
      registration = undefined
    },
  }
}

/** Cordis event handles are either a disposer function or a disposable object. */
function releaseHandle(handle: unknown): void {
  if (typeof handle === 'function') {
    (handle as () => void)()
    return
  }
  const disposable = handle as { dispose?: () => void } | null | undefined
  disposable?.dispose?.()
}
