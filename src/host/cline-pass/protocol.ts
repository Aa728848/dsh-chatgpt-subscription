/**
 * Cline Pass wire protocol: pipeline detection, pin injection, failover
 * expansion, and error classification. Every function here is pure.
 *
 * The two pipelines spell a pin differently:
 * - **direct** (OpenRouter): top-level `provider.only/order/sort`.
 * - **planner** (Vercel AI Gateway): only `providerOptions.gateway.*` survives.
 *
 * Ported from the MIT-licensed `dsh-cline-pass` plugin's protocol module, whose
 * routing behavior reimplements the MIT-licensed `cline-pass-switcher` findings.
 *
 * @module dsh-chatgpt-subscription/cline-pass-protocol
 */
import { isClinePassAnonymousUpstream } from '../../shared/cline-pass-contracts.ts'
import { MAX_UPSTREAMS } from './types.ts'

/** Which pipeline the gateway routed one request through. */
export type ClinePipeline = 'direct' | 'planner'

/** One candidate request, after a pin has been expanded into try order. */
export interface PinAttempt {
  /** The channel to pin, or null for automatic routing. */
  upstream: string | null
  /** The remaining ordered candidates; used in `preferred` mode. */
  orderRest: string[]
  /** Channels that must never serve this request. */
  excludeList: string[]
  /** Strict writes `only`; preferred writes `order` as well. */
  strict: boolean
  /** Normalized sort metric, or null for none. */
  sort: string | null
  /** Required model capabilities, written only to the Vercel gateway spelling. */
  has?: readonly string[]
  /** `detected` restores the old single-spelling behavior. */
  spelling?: string
}

/** One model's stored pin configuration. */
export interface PinConfig {
  upstreams?: readonly string[]
  exclude?: readonly string[]
  pinMode?: string
  sort?: string
  has?: readonly string[]
  spelling?: string
}

/** What one response says about how the gateway routed it. */
export interface RoutingFacts {
  content: string | null
  toolCalls: unknown[]
  usage: unknown
  pipeline: ClinePipeline | null
  canonicalSlug: string | null
  finalProvider: string | null
  finalProviderName: string | null
  fallbacks: string[]
  plan: string
  /**
   * First-party DeepSeek fingerprint, when the answer carries one.
   *
   * `provider_metadata.deepseek.systemFingerprint` is the only field that
   * proves the answer came from first-party DeepSeek; the top-level
   * `system_fingerprint` is minted by the gateway per request and says
   * nothing about the upstream.
   */
  fingerprint: string | null
  /** Whether the serving channel is the gateway's anonymous contributor route. */
  anonymous: boolean
}

/** Written into the model observation store, so probe results are kept apart by pipeline. */
export interface PinModelMeta {
  upstreams?: string[]
  channels?: Partial<Record<ClinePipeline, string[]>>
  pipeline?: ClinePipeline | null
  /** The channel the last observed answer actually came from, when known. */
  lastProvider?: string | null
  /** The last answer's first-party DeepSeek fingerprint, when it carried one. */
  lastFingerprint?: string | null
}

/** One attempt's replayed identity. */
export interface PinAttemptOutcome {
  attempt: PinAttempt
  routing: { finalProvider: string | null } | null
}

/** Whether a pin was honored, or could not be judged. */
export type PinAdherence = 'adopted' | 'fallback' | 'not-adopted' | 'violated' | 'unresolved'

/**
 * The gateway wraps some answers in a `{ data: … }` envelope; unwrap it.
 * @param json - raw decoded response body.
 * @returns the OpenAI-shaped payload.
 */
export function unwrapEnvelope(json: unknown): Record<string, unknown> {
  if (isRecord(json) && isRecord(json.data) && json.data.choices !== undefined) {
    return json.data
  }
  return isRecord(json) ? json : {}
}

/** Turn any error-shaped value into display text. */
export function errorText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.message === 'string') return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Account authentication refusals, including responses with no useful body. */
export function isAuthenticationError(message: unknown, status?: number): boolean {
  const detail = String(message ?? '').replace(/[_-]/g, ' ')
  return status === 401 || status === 403 || /unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)
}

/**
 * Read the routing facts out of one completed gateway response.
 * @param json - raw decoded response body (enveloped or not).
 * @returns pipeline, canonical slug, chosen upstream and fallback list.
 */
export function parseRouting(json: unknown): RoutingFacts {
  const payload = unwrapEnvelope(json)
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  // A non-streaming answer carries the routing block on `message`; a streaming
  // frame carries it on `delta` (the gateway appends it to a terminal frame,
  // after the content). Reading only `message` leaves every streamed request
  // with no serving-channel reading at all.
  const delta = isRecord(first.delta) ? first.delta : {}
  const metadata = [message, delta, payload].map(providerMetadataOf).find((entry) => entry !== null) ?? {}
  const gateway = isRecord(metadata.gateway) ? metadata.gateway : {}
  const direct = typeof payload.provider === 'string' ? payload.provider : null
  let routing: Record<string, unknown> = isRecord(gateway.routing) ? gateway.routing : {}
  if (typeof routing.finalProvider !== 'string') {
    // The gateway has moved this block between nestings before; hunt for it
    // rather than grow one case per observed shape. Wire JSON is acyclic, so
    // the depth cap is the only guard the walk needs.
    routing = huntRouting(payload) ?? routing
  }
  const finalProvider = typeof routing.finalProvider === 'string'
    ? routing.finalProvider
    : (direct === null ? null : slugify(direct))
  const canonicalSlug = typeof routing.canonicalSlug === 'string'
    ? routing.canonicalSlug
    : (typeof payload.model === 'string' && payload.model.includes('/') ? payload.model : null)
  return {
    content: typeof message.content === 'string' ? message.content : (typeof delta.content === 'string' ? delta.content : null),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : (Array.isArray(delta.tool_calls) ? delta.tool_calls : []),
    usage: payload.usage ?? null,
    pipeline: typeof routing.finalProvider === 'string' ? 'planner' : (direct === null ? null : 'direct'),
    canonicalSlug,
    finalProvider,
    finalProviderName: typeof routing.finalProvider === 'string' ? routing.finalProvider : direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === 'string' ? routing.planningReasoning : '',
    fingerprint: huntFingerprint(payload),
    anonymous: isClinePassAnonymousUpstream(finalProvider ?? '', canonicalSlug ?? ''),
  }
}

/** `provider_metadata` of one node, when present. */
function providerMetadataOf(node: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(node.provider_metadata) ? node.provider_metadata : null
}

/**
 * Depth-bounded hunt for the gateway's routing block anywhere in one payload.
 *
 * The fast paths (`message`/`delta`/`payload.provider_metadata.gateway`) are
 * checked by the caller first; this walk covers the nestings between the shapes
 * seen so far, so a frame the fast path does not know still yields its routing.
 */
function huntRouting(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = huntRouting(entry, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  const gateway = isRecord(record.gateway) ? record.gateway : null
  const routing = gateway !== null && isRecord(gateway.routing)
    ? gateway.routing
    : (isRecord(record.routing) ? record.routing : null)
  if (routing !== null && typeof routing.finalProvider === 'string') return routing
  for (const value of Object.values(record)) {
    const found = huntRouting(value, depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * Read the first-party DeepSeek fingerprint wherever `provider_metadata`
 * carries it. Absent means the answer did not prove a first-party upstream —
 * the anonymous contributor route carries no `deepseek` namespace at all.
 */
function huntFingerprint(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = huntFingerprint(entry, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = node as Record<string, unknown>
  const metadata = providerMetadataOf(record)
  if (metadata !== null) {
    const deepseek = isRecord(metadata.deepseek) ? metadata.deepseek : null
    if (deepseek !== null && typeof deepseek.systemFingerprint === 'string' && deepseek.systemFingerprint !== '') {
      return deepseek.systemFingerprint
    }
  }
  for (const value of Object.values(record)) {
    const found = huntFingerprint(value, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** Lowercase a display name into an upstream slug. */
export function slugify(value: unknown): string {
  return String(value).toLowerCase().replace(/\s+/g, '-')
}

/** OpenRouter's names for the three sort metrics. */
export const OPENROUTER_SORT: Readonly<Record<string, string>> = Object.freeze({ cost: 'price', ttft: 'latency', tps: 'throughput' })

/**
 * Channels the two routers spell differently, as `[planner, direct]` pairs.
 *
 * Z.AI is `zai` to the Vercel gateway and `z-ai` to OpenRouter. Writing one name
 * into both spellings matters: a request that lands on the direct pipeline
 * carries `provider.only` to OpenRouter, where an unknown provider is refused
 * rather than ignored.
 */
export const CHANNEL_ALIASES: ReadonlyArray<readonly [string, string]> = Object.freeze([['zai', 'z-ai']])

/**
 * Translate a channel name into the spelling one pipeline uses.
 * @param name - the configured channel name, in either spelling.
 * @param pipeline - `'planner'` or `'direct'`.
 * @returns the name that pipeline expects; unknown names pass through.
 */
export function channelNameFor(name: string, pipeline: ClinePipeline): string {
  const needle = normalizeSlug(name)
  for (const [planner, direct] of CHANNEL_ALIASES) {
    if (normalizeSlug(planner) === needle) return pipeline === 'direct' ? direct : planner
    if (normalizeSlug(direct) === needle) return pipeline === 'planner' ? planner : direct
  }
  return name
}

/**
 * Normalize a configured sort into a wire value or null.
 *
 * Two spellings mean "no sort" and both must be dropped before the request is
 * built: the settings schema stores an empty string, and `none` is the
 * documented "clear it" value. Neither is a metric, and the gateway rejects them
 * with HTTP 400.
 */
export function normalizeSort(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const sort = value.trim()
  return sort.length === 0 || sort === 'none' ? null : sort
}

/**
 * Normalize a configured pin mode to the one value the router compares against.
 * @param value - the configured pin mode, as stored.
 * @returns `'strict'` or `'preferred'`.
 */
export function normalizePinMode(value: unknown): 'strict' | 'preferred' {
  return String(value ?? '').trim().toLowerCase() === 'preferred' ? 'preferred' : 'strict'
}

/**
 * The channel vocabulary one spelling should be resolved against.
 *
 * The two pipelines sit behind different routers and publish different channel
 * lists, so the merged list is the wrong basis for an allow-list.
 */
function knownChannels(meta: PinModelMeta | undefined, pipeline: ClinePipeline): string[] {
  const scoped = meta?.channels?.[pipeline]
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  return Array.isArray(meta?.upstreams) ? meta.upstreams : []
}

/** A request body, before and after pin injection. */
type WireBody = Record<string, unknown>

/**
 * Write one attempt's upstream preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the exclude/ignore fields.
 *
 * Both spellings are written by default. A pin is honored only by the pipeline
 * that owns the spelling, and the pipeline a model runs on is decided by the
 * gateway and can differ between calls, so writing just the spelling the last
 * probe observed means the pin silently evaporates the moment that changes. Each
 * pipeline ignores the other's field, which is what makes writing both safe.
 * `spelling: 'detected'` restores the old single-spelling behavior.
 *
 * @returns a new body with the pin applied.
 */
export function injectPrefs(body: WireBody, meta: PinModelMeta | undefined, attempt: PinAttempt | undefined): WireBody {
  const next: WireBody = { ...body }
  if (attempt === undefined) return next
  const upstream = attempt.upstream
  const orderRest = attempt.orderRest ?? []
  const excludeList = attempt.excludeList ?? []
  const strict = attempt.strict !== false
  const sort = normalizeSort(attempt.sort)
  const has = (attempt.has ?? []).filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
  const excluded = excludeList.filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  const spell = (names: readonly string[], pipeline: ClinePipeline): string[] => names.map((name) => channelNameFor(name, pipeline))
  const gatewayAllow = excluded.length > 0 ? knownChannels(meta, 'planner').filter((name) => !excludedIds.has(normalizeSlug(name))) : null
  const openRouterAllow = excluded.length > 0 ? knownChannels(meta, 'direct').filter((name) => !excludedIds.has(normalizeSlug(name))) : null
  const pipeline = meta?.pipeline ?? null
  const both = attempt.spelling !== 'detected'
  const useGateway = both || pipeline === 'planner' || pipeline === null
  const useOpenRouter = both || pipeline === 'direct' || pipeline === null
  const gatewayUsable = useGateway && (upstream !== null || sort !== null || has.length > 0 || (gatewayAllow !== null && gatewayAllow.length > 0))
  // `ignore` is OpenRouter's own exclusion field: written alongside the
  // allow-list so an exclusion still bites when the allow-list cannot be
  // computed (no channel list yet) or has gone stale.
  const openRouterUsable = useOpenRouter && (upstream !== null || sort !== null || excluded.length > 0 || (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next
  if (gatewayUsable) {
    const gateway: Record<string, unknown> = {}
    if (upstream !== null) {
      if (strict) gateway.only = spell([upstream], 'planner')
      else {
        gateway.order = spell([upstream, ...orderRest], 'planner')
        if (gatewayAllow !== null && gatewayAllow.length > 0) gateway.only = spell(gatewayAllow, 'planner')
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = spell(gatewayAllow, 'planner')
    }
    if (sort !== null) gateway.sort = sort
    // `has` is a Vercel AI Gateway capability filter, not an OpenRouter field.
    // On models whose unfiltered pin is diverted to the anonymous fallback it
    // is also what makes the router honor `only` and name its providers again.
    if (has.length > 0) gateway.has = [...has]
    const providerOptions = isRecord(next.providerOptions) ? next.providerOptions : {}
    const currentGateway = isRecord(providerOptions.gateway) ? providerOptions.gateway : {}
    next.providerOptions = { ...providerOptions, gateway: { ...currentGateway, ...gateway } }
  }
  if (openRouterUsable) {
    const provider: Record<string, unknown> = isRecord(next.provider) ? { ...next.provider } : {}
    if (upstream !== null) {
      if (strict) provider.only = spell([upstream], 'direct')
      else {
        provider.order = spell([upstream, ...orderRest], 'direct')
        if (openRouterAllow !== null && openRouterAllow.length > 0) provider.only = spell(openRouterAllow, 'direct')
      }
    } else if (openRouterAllow !== null && openRouterAllow.length > 0) {
      provider.only = spell(openRouterAllow, 'direct')
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    if (excluded.length > 0) provider.ignore = spell(excluded, 'direct')
    next.provider = provider
  }
  return next
}

/**
 * Read back whether the router honored one attempt's pin.
 *
 * A 200 is not evidence that the pin was applied: an unknown or unavailable
 * `only` value is dropped by the router, which then serves the request from
 * another channel. The only honest test is the channel the response reports.
 */
export function pinAdherence(attempt: PinAttempt, routing: { finalProvider: string | null } | null | undefined): PinAdherence {
  const expected = attempt.upstream
  const excluded = (attempt.excludeList ?? [])
    .filter((name) => normalizeSlug(name) !== normalizeSlug(expected ?? ''))
    .map(normalizeSlug)
  const raw = routing?.finalProvider ?? null
  const actual = raw === null || raw === undefined || String(raw).length === 0 ? null : normalizeSlug(raw)
  // An excluded channel serving the request is a breach in every mode, and it
  // is the one failure nothing else can reveal: the response is a clean 200.
  if (actual !== null && excluded.includes(actual)) return 'violated'
  if (expected === null || expected === undefined || String(expected).length === 0) return 'unresolved'
  if (actual === null) return 'unresolved'
  if (actual === normalizeSlug(expected)) return 'adopted'
  if ((attempt.orderRest ?? []).map(normalizeSlug).includes(actual)) return 'fallback'
  return 'not-adopted'
}

/** Whether an adherence reading means the pin was honored, or cannot be judged. */
export function isAdherenceOk(adherence: PinAdherence): boolean {
  return adherence === 'adopted' || adherence === 'fallback' || adherence === 'unresolved'
}

/**
 * Name the configuration problems that make a pin impossible to honor.
 *
 * Both cases used to produce a request with no pin fields at all — that is,
 * "excluded" channels still in play, silently.
 *
 * @returns human-readable warnings, empty when the pin is expressible.
 */
export function pinWarnings(attempt: Pick<PinAttempt, 'upstream'> & { excludeList?: string[] }, meta: PinModelMeta | undefined): string[] {
  const upstream = attempt.upstream ?? null
  const warnings: string[] = []
  if (upstream !== null && upstream !== undefined && String(upstream).length > 0 && isClinePassAnonymousUpstream(upstream)) {
    warnings.push(`anonymousUpstream: ${upstream} is the gateway's anonymous contributor route — answers from it may be used for training and carry no zero-data-retention guarantee; pin it only when that is acceptable`)
  }
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (
    upstream !== null && upstream !== undefined && String(upstream).length > 0
    && !isClinePassAnonymousUpstream(upstream)
    && known.length > 0 && known.every((name) => isClinePassAnonymousUpstream(name))
  ) {
    warnings.push(`pinLikelyIgnored: every channel discovered for this model is the anonymous contributor route (${known.join(', ')}), which silently drops a pin and answers anyway — the request will likely be served by it regardless of ${upstream}`)
  }
  const excluded = (attempt.excludeList ?? []).filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  if (excluded.length === 0) return warnings
  if (known.length === 0) {
    return [...warnings, `excludeUnresolved: this model has no channel list yet, so ${excluded.join(', ')} could not be compiled into an allow-list — run cline_pass_probe for it`]
  }
  const remaining = known.filter((name) => !excludedIds.has(normalizeSlug(name)))
  if (remaining.length === 0 && upstream === null) {
    return [...warnings, `PIN_UNRESOLVED: every known channel is excluded (${known.join(', ')}), so the request falls back to the gateway's own routing`]
  }
  return warnings
}

/**
 * Expand one model's pin configuration into the ordered failover candidates.
 *
 * A model with a non-empty (post-exclusion) pin list is tried upstream by
 * upstream; a model without one is a single automatic candidate whose excludes
 * become an allow-list.
 */
export function buildAttempts(config: PinConfig): PinAttempt[] {
  const listed = (config.upstreams ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0)
  const exclude = (config.exclude ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0)
  const excluded = new Set(exclude.map(normalizeSlug))
  const wanted = listed.filter((name) => !excluded.has(normalizeSlug(name)))
  const strict = normalizePinMode(config.pinMode) === 'strict'
  const sort = normalizeSort(config.sort)
  const base: Omit<PinAttempt, 'upstream' | 'orderRest'> = { strict, sort, excludeList: exclude }
  const has = (config.has ?? []).filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
  if (has.length > 0) base.has = [...has]
  if (typeof config.spelling === 'string' && config.spelling.length > 0) base.spelling = config.spelling
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      upstream,
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, upstream: null, orderRest: [] }]
}

/**
 * Classify a pinned-request failure into one upstream availability verdict.
 * @returns `ok` (the channel answered), `limited`, `bad`, `auth`, or `unknown`.
 */
export function classifyUpstreamError(message: unknown): 'ok' | 'limited' | 'bad' | 'auth' | 'unknown' {
  const text = String(message ?? '')
  if (/empty response content/i.test(text)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(text)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(text)) return 'bad'
  if (isAuthenticationError(text)) return 'auth'
  return 'unknown'
}

/**
 * Recover the gateway's own upstream list from a routing-layer error.
 *
 * The probe channels an impossible `only` value, so the router fails before
 * spending a token and names every provider it could have used.
 */
export function extractAvailableProviders(message: unknown, pipeline: ClinePipeline | null): string[] | null {
  const text = String(message ?? '')
  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    return tokens.length > 0 ? tokens : null
  }
  if (pipeline === 'direct') {
    const start = text.indexOf('{')
    if (start < 0) return null
    try {
      const parsed = JSON.parse(text.slice(start)) as { error?: { metadata?: { available_providers?: unknown } } }
      const list = parsed?.error?.metadata?.available_providers
      return Array.isArray(list) && list.length > 0 ? list.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Read the tier-0 channel hint out of a planner's reasoning sentence.
 * @param plan - `provider_metadata.gateway.routing.planningReasoning`.
 */
export function parseTier0(plan: unknown): string[] {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(String(plan ?? ''))
  if (match === null) return []
  return [...new Set([match[1], ...match[2].split(/,\s*|\s+and\s+/).map((part) => part.trim()).filter(Boolean)])]
}

/**
 * Merge the upstream channels discovered by several means, keeping order and
 * dropping duplicates.
 * @param lists - candidate lists, highest confidence first.
 * @returns the merged, de-duplicated upstream slugs (capped at MAX_UPSTREAMS).
 */
export function mergeUpstreams(...lists: ReadonlyArray<readonly string[] | null | undefined>): string[] {
  const seen: string[] = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, MAX_UPSTREAMS)
}

/**
 * Normalize a model id for fuzzy OpenRouter catalog matching.
 * @param value - either id.
 * @returns the comparable form.
 */
export function normalizeSlug(value: unknown): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Whether a value is a non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
