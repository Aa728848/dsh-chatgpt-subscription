/**
 * Route an automatic compaction summary to a model other than the one that
 * built the conversation.
 *
 * A host computes the summary on the conversation's own model unless its
 * compaction config names another route. That config is preset-owned, so this
 * plugin cannot offer it as a setting; it re-routes the call one layer down,
 * at the `llm/stream` waterfall, where a compaction request is identifiable by
 * its `purpose` and every preset passes through.
 *
 * Three rules shape the listener:
 *
 * - **Refuse before sending what cannot work.** A video block has no wire
 *   fallback on a target that does not take video, so the request would fail
 *   after paying for it. The payload is inspected first and the conversation
 *   model keeps the call instead.
 * - **Buffer, then fall back.** A host turns an adapter throw into a terminal
 *   `finish` chunk instead of an exception, and a half-written summary is
 *   worthless, so the alternate attempt is collected first. Only a complete one
 *   is released downstream; anything else falls back to the conversation model
 *   and is recorded, because a fallback the operator cannot see is a cost they
 *   did not agree to.
 * - **Do not impose an output cap.** The host asks for 65 536 tokens of summary
 *   by default; the official client sends no cap at all and lets the route
 *   decide, so the cap is dropped for the re-routed call.
 *
 * The setting itself is now scoped to one line. It is presented on the Kimi Code
 * tab, so only a session whose own provider is `scopeProvider` (kimi-code) is
 * ever re-routed: every other line's compaction passes through untouched, no
 * matter what target is configured. The candidate directory still spans every
 * line, because a kimi-code summary may legitimately be written elsewhere.
 *
 * @module dsh-chatgpt-subscription/compaction-route
 */

import {
  compactionRoutesImages,
  compactionSkipReason,
  type CompactionPayloadNeeds,
  type CompactionRouteTarget,
  type CompactionSkipReason,
  type CompactionTargetFacts,
} from '../../shared/compaction-route.ts'

/** The subset of `llm/stream` options this router reads or replaces. */
export interface CompactionStreamOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /** `compaction` on an auxiliary summary call; absent on a conversation turn. */
  readonly purpose?: string | undefined
  /** Output cap the host attaches; dropped on a re-routed call. */
  readonly maxTokens?: number | undefined
  readonly messages?: readonly CompactionMessage[] | undefined
  readonly tools?: readonly unknown[] | undefined
  readonly sessionId?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** One request message, narrowed to the content blocks the router inspects. */
export interface CompactionMessage {
  readonly content?: readonly CompactionBlock[] | undefined
}

/** One content block; only its type is read. */
export interface CompactionBlock {
  readonly type?: string | undefined
}

/** A chunk as it crosses the stream boundary; only the finish reason is read. */
export interface CompactionChunk {
  readonly type: string
  readonly reason?: { readonly kind?: string | undefined } | undefined
}

/** The `llm/stream` waterfall listener this router registers. */
export type CompactionStreamListener = (
  options: CompactionStreamOptions,
  next: () => AsyncIterable<CompactionChunk>,
) => AsyncIterable<CompactionChunk>

/** One entry of the provider model directory, as the decision needs it. */
export interface CompactionModelInfo {
  readonly provider: string
  readonly id: string
  readonly inputModalities?: readonly string[] | undefined
}

/** What the last compaction attempt did, for the settings surface. */
export type CompactionRouteOutcome =
  | {
    readonly kind: 'routed'
    readonly provider: string
    readonly model: string
    readonly at: number
    /** The payload carried images the target cannot take inline. */
    readonly imagesProjected: boolean
  }
  | {
    readonly kind: 'fell-back'
    readonly provider: string
    readonly model: string
    readonly at: number
    readonly reason: string
  }
  | {
    readonly kind: 'skipped'
    readonly at: number
    readonly reason: CompactionSkipReason
  }

/** Services the router needs, injected so the decision is testable without a host. */
export interface CompactionRouteDeps {
  /** Issue one request through the LLM service, re-entering the waterfall. */
  readonly stream: (options: CompactionStreamOptions) => AsyncIterable<CompactionChunk>
  /**
   * The only provider whose sessions may be re-routed.
   *
   * A session on any other provider is released untouched, whatever
   * `readTarget` reports: this setting is offered on one line's settings page,
   * so it must not spend another line's quota or change another line's output.
   */
  readonly scopeProvider: string
  /** The live target; read per request so a settings change applies at once. */
  readonly readTarget: () => CompactionRouteTarget | null
  /** Provider directory lookup; absent leaves every target admissible. */
  readonly listModels?: ((provider: string) => Promise<readonly CompactionModelInfo[]>) | undefined
}

/** The context surface this router needs, declared structurally per harness generation. */
export interface CompactionRouteContext {
  on?(
    event: 'llm/stream',
    listener: CompactionStreamListener,
    options?: { readonly global?: boolean },
  ): unknown
  logger?: { warn(message: string): void } | undefined
}

/** Live handle: the last outcome for a settings card, plus teardown. */
export interface CompactionRouteHandle {
  status(): CompactionRouteOutcome | null
  dispose(): void
}

/** How long one provider's model directory is reused. */
const MODEL_CACHE_MS = 60_000

/**
 * Install the `llm/stream` listener.
 *
 * Returns `undefined` when the host exposes no event bus, so a caller can skip
 * installation instead of failing the plugin's load.
 *
 * @param ctx - structural context: the event bus and a logger.
 * @param deps - the LLM stream, the scoped provider, the live target, and the
 *   optional directory.
 * @returns the live handle, or `undefined` on a host without an event bus.
 */
export function installCompactionRoute(
  ctx: CompactionRouteContext,
  deps: CompactionRouteDeps,
): CompactionRouteHandle | undefined {
  const on = ctx.on
  if (typeof on !== 'function') return undefined
  let outcome: CompactionRouteOutcome | null = null
  // Marks a request this listener already re-routed, so the nested call it
  // issues does not route itself again.
  const rerouted = new WeakSet<object>()
  const directory = new Map<string, { at: number; models: readonly CompactionModelInfo[] }>()

  const factsFor = async (target: CompactionRouteTarget): Promise<CompactionTargetFacts> => {
    if (deps.listModels === undefined) return {}
    const now = Date.now()
    const cached = directory.get(target.provider)
    const models = cached !== undefined && now - cached.at < MODEL_CACHE_MS
      ? cached.models
      : await deps.listModels(target.provider).catch(() => [])
    if (cached === undefined || now - cached.at >= MODEL_CACHE_MS) {
      directory.set(target.provider, { at: now, models })
    }
    const entry = models.find(model => model.id === target.model)
    return entry === undefined ? {} : { modalities: entry.inputModalities }
  }

  const listener: CompactionStreamListener = async function* routeByStream(options, next) {
    if (options.purpose !== 'compaction' || rerouted.has(options)) return yield* next()
    const target = deps.readTarget()
    if (target === null) return yield* next()
    if (target.provider === options.provider && target.model === options.model) return yield* next()
    // Scope gate: a session on another line is released here, before the
    // directory is read, so the setting costs that line nothing at all.
    if (options.provider !== deps.scopeProvider) return yield* next()
    const facts = await factsFor(target)
    const needs = payloadNeeds(options)
    const skip = compactionSkipReason(facts, needs)
    if (skip !== undefined) {
      outcome = { kind: 'skipped', at: Date.now(), reason: skip }
      ctx.logger?.warn(
        `[dsh-chatgpt-subscription] compaction kept on ${String(options.provider)}/${String(options.model)}: `
        + `${target.provider}/${target.model} ${skip}`,
      )
      return yield* next()
    }
    const reroutedOptions = withoutOutputCap(options, target)
    rerouted.add(reroutedOptions)
    const attempt = await collect(() => deps.stream(reroutedOptions))
    if (attempt.ok) {
      outcome = {
        kind: 'routed',
        provider: target.provider,
        model: target.model,
        at: Date.now(),
        imagesProjected: needs.image && !compactionRoutesImages(facts),
      }
      for (const chunk of attempt.chunks) yield chunk
      return
    }
    outcome = {
      kind: 'fell-back',
      provider: options.provider ?? '',
      model: options.model ?? '',
      at: Date.now(),
      reason: attempt.reason,
    }
    ctx.logger?.warn(
      `[dsh-chatgpt-subscription] compaction fell back to ${String(options.provider)}/${String(options.model)}: `
      + `${target.provider}/${target.model} failed with ${attempt.reason}`,
    )
    return yield* next()
  }

  const dispose = on('llm/stream', listener, { global: true })
  return {
    status: () => outcome,
    dispose: () => { if (typeof dispose === 'function') dispose() },
  }
}

/**
 * Read what the payload actually carries.
 * @param options - the compaction request.
 * @returns whether it carries an image or a video block.
 */
export function payloadNeeds(options: CompactionStreamOptions): CompactionPayloadNeeds {
  let image = false
  let video = false
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.type === 'image') image = true
      else if (block.type === 'video') video = true
    }
  }
  return { image, video }
}

/**
 * Build the request for the chosen target: the same conversation, no output cap.
 * @param options - the original compaction request.
 * @param target - the route to send it to.
 * @returns a detached request object.
 */
export function withoutOutputCap(
  options: CompactionStreamOptions,
  target: CompactionRouteTarget,
): CompactionStreamOptions {
  const { maxTokens: _dropped, ...rest } = options
  return { ...rest, provider: target.provider, model: target.model }
}

type CollectResult =
  | { readonly ok: true; readonly chunks: readonly CompactionChunk[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Run one attempt to completion, keeping its chunks only when it finished
 * cleanly.
 *
 * The stream is opened inside the try, not before it: an adapter that rejects
 * before yielding anything (an exhausted quota, a rejected credential) throws
 * from the call itself, and that is the same fallback case as a failed stream.
 */
async function collect(open: () => AsyncIterable<CompactionChunk>): Promise<CollectResult> {
  const chunks: CompactionChunk[] = []
  let finishKind: string | undefined
  try {
    for await (const chunk of open()) {
      chunks.push(chunk)
      if (chunk.type === 'finish') finishKind = chunk.reason?.kind
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (finishKind === undefined) return { ok: false, reason: 'the stream ended without a finish chunk' }
  if (finishKind === 'error' || finishKind === 'aborted') return { ok: false, reason: finishKind }
  return { ok: true, chunks }
}
