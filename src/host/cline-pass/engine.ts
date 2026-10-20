/**
 * The Cline Pass engine: pinned request chains with pre-first-token failover,
 * probing, validation, and account verification. It owns every probe network
 * call, so the adapter, the settings routes and the management tools apply
 * identical pinning semantics.
 *
 * Failover contract: a candidate is abandoned only while nothing has been
 * delivered yet. A non-2xx, a transport failure, or an error payload before the
 * first content delta moves to the next candidate; once a chunk has been
 * produced the stream is the answer, and a later failure is reported as such.
 *
 * @module dsh-chatgpt-subscription/cline-pass-engine
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  chatCompletion,
  fetchGatewayCatalog,
  fetchOfficialModels,
  openChatStream,
  openRouterEndpoints,
} from './client.ts'
import {
  buildAttempts,
  channelNameFor,
  classifyUpstreamError,
  errorText,
  extractAvailableProviders,
  injectPrefs,
  isAuthenticationError,
  isAdherenceOk,
  mergeUpstreams,
  parseRouting,
  parseTier0,
  pinAdherence,
  pinWarnings,
  unwrapEnvelope,
  type PinAttempt,
  type PinConfig,
  type PinModelMeta,
} from './protocol.ts'
import { DEFAULT_BASE_URL, VALIDATE_CONCURRENCY, type ClinePassCatalogScan, type ClinePassPinSettings } from './types.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassAccountPool } from './account-pool.ts'
import { bearerFor } from './token-store.ts'

/** One resolved account, as the engine hands it to a request or a probe. */
export interface ClinePassAccount {
  id: string
  name: string
  key: string
  baseURL: string
}

/** One pinned request's outcome. */
export interface ClinePassAttemptOutcome {
  attempt: PinAttempt
  account: ClinePassAccount
  status: number
  ok: boolean
  json: Record<string, unknown>
  text: string
  ms: number
  routing: ReturnType<typeof parseRouting>
  adherence: ReturnType<typeof pinAdherence> | null
  warnings: string[]
  error: string
}

export interface ClinePassEngineOptions {
  fetchFn: typeof fetch
  accountPool: ClinePassAccountPool
  store: ClinePassStore
  /** The stored pin plus the route-wide spelling policy. */
  pinFor(model: string): PinConfig
  /** The route's default gateway, used when an account names none. */
  baseURL(): string
  logger?: { warn(message: string, ...args: unknown[]): void }
  attemptTimeoutMs?: number
  probeTimeoutMs?: number
}

/**
 * The engine. All methods are safe to call while the pool is serving live
 * traffic; probes take an account through the same rotation as a request.
 */
export class ClinePassEngine {
  constructor(private readonly options: ClinePassEngineOptions) {}

  private get fetchFn(): typeof fetch {
    return this.options.fetchFn
  }

  private get store(): ClinePassStore {
    return this.options.store
  }

  /** The account a request would use right now, without consuming a rotation slot. */
  async resolveAccount(exclude: ReadonlySet<string> = new Set()): Promise<ClinePassAccount> {
    const effective = await this.options.accountPool.getEffectiveCredential(exclude, this.fetchFn)
    const credentials = effective.credentials
    return {
      id: effective.account.id,
      name: effective.account.alias || effective.account.id,
      key: bearerFor(credentials),
      // An account's own gateway wins; an empty one means the route's default.
      baseURL: credentials.baseURL && credentials.baseURL.trim() !== '' ? credentials.baseURL.trim() : this.options.baseURL(),
    }
  }

  /** The pin plus the route-wide spelling policy, as a request will send it. */
  pinConfigFor(model: string): PinConfig {
    return {
      upstreams: this.pinOf(model).upstreams,
      exclude: this.pinOf(model).exclude,
      pinMode: this.pinOf(model).pinMode,
      sort: this.pinOf(model).sort,
      spelling: this.options.pinFor(model).spelling,
    }
  }

  /** The configured pin for one model, read through the live settings file. */
  pinOf(model: string): ClinePassPinSettings {
    const pin = this.options.pinFor(model)
    return {
      upstreams: (pin.upstreams ?? []).map(String),
      exclude: (pin.exclude ?? []).map(String),
      pinMode: pin.pinMode === 'preferred' ? 'preferred' : 'strict',
      sort: typeof pin.sort === 'string' ? pin.sort : '',
    }
  }

  /**
   * One pinned request, non-streaming.
   * @returns the decoded payload plus the facts the pin was judged on.
   */
  async attemptChat(
    model: string,
    body: Record<string, unknown>,
    attempt: PinAttempt,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ClinePassAttemptOutcome> {
    const account = await this.resolveAccount()
    const meta = this.store.metaOf(model) as PinModelMeta
    const pinned = injectPrefs(body, meta, attempt)
    const started = Date.now()
    const result = await chatCompletion({
      fetchFn: this.fetchFn,
      baseURL: account.baseURL || DEFAULT_BASE_URL,
      apiKey: account.key,
      body: pinned,
      signal,
      timeoutMs: timeoutMs ?? this.options.attemptTimeoutMs ?? 180_000,
    })
    const payload = unwrapEnvelope(result.json)
    const failed = result.ok !== true || (payload.error !== undefined && payload.choices === undefined)
    const routing = failed ? parseRouting({}) : parseRouting(payload)
    return {
      attempt,
      account,
      status: failed ? (payload.error === undefined ? result.status : 502) : 200,
      ok: !failed,
      json: payload,
      text: result.text,
      ms: Date.now() - started,
      routing,
      // A 200 says the gateway answered. It does not say the pin was applied,
      // and the router drops an unusable `only` without complaining.
      adherence: failed ? null : pinAdherence(attempt, routing),
      warnings: pinWarnings({ upstream: attempt.upstream, excludeList: attempt.excludeList }, meta),
      error: failed ? (errorText(payload.error) || result.text.slice(0, 400) || `HTTP ${result.status}`) : '',
    }
  }

  /**
   * Run one model's ordered candidate chain until an attempt is both answered
   * and served by the channel the pin asked for.
   *
   * This is the diagnostic path (`cline_pass_test`), so it keeps looking past a
   * candidate the router quietly ignored: the point of the call is to find out
   * whether the pin works.
   */
  async runChain(
    model: string,
    body: Record<string, unknown>,
    pinConfig: PinConfig,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{
    ok: boolean
    result: ClinePassAttemptOutcome | null
    trace: Array<{ upstream: string; status: number; ms: number; note: string }>
    error: string
    warnings: string[]
  }> {
    const trace: Array<{ upstream: string; status: number; ms: number; note: string }> = []
    let last: ClinePassAttemptOutcome | null = null
    for (const attempt of buildAttempts(pinConfig)) {
      const outcome = await this.attemptChat(model, body, attempt, { signal, timeoutMs })
      const honored = outcome.ok && isAdherenceOk(outcome.adherence ?? 'unresolved')
      const note = !outcome.ok
        ? outcome.error
        : honored
          ? 'ok'
          : `pin not adopted: served by ${outcome.routing.finalProvider ?? '(unknown)'}`
      trace.push({ upstream: attempt.upstream ?? '(auto)', status: outcome.status, ms: outcome.ms, note: note.slice(0, 160) })
      last = outcome
      if (honored) return { ok: true, result: outcome, trace, error: '', warnings: outcome.warnings }
      if (!outcome.ok) {
        // A channel that refuses a strict pin is learned as unusable for it.
        if (attempt.upstream !== null && outcome.error !== '') {
          this.store.learnUpstream(model, attempt.upstream, classifyUpstreamError(outcome.error), outcome.error, outcome.ms)
        }
        if (attempt.upstream === null && attempt.excludeList.length > 0 && outcome.error !== '') this.learnFromError(model, outcome.error)
      }
    }
    const error = last === null
      ? 'no candidate succeeded'
      : last.ok !== true
        ? last.error
        : last.adherence === 'violated'
          ? `an excluded channel served the request: ${last.routing.finalProvider ?? '(unknown)'}`
          : `the gateway ignored the pin: served by ${last.routing.finalProvider ?? '(unknown)'}`
    return { ok: false, result: last, trace, error, warnings: last?.warnings ?? [] }
  }

  /** Merge a gateway error's own provider list into the model's channel list. */
  learnFromError(model: string, message: string): void {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ''))
    if (match === null) return
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const meta = this.store.metaOf(model)
    const current = Array.isArray(meta.upstreams) ? meta.upstreams : []
    // Comparing lengths used to stand in for "something new arrived", which is
    // false the moment the list is capped: a genuinely new channel replacing a
    // dropped one keeps the length identical and the learning was discarded.
    if (!tokens.some((token) => !current.includes(token))) return
    this.store.learn(model, { upstreams: mergeUpstreams(current, tokens) })
  }

  /**
   * Probe one model: detect its pipeline, read back the upstream it used, and
   * harvest the channel list each pipeline publishes. Costs two tiny requests.
   */
  async probe(
    model: string,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{
    ok: boolean
    ms: number
    model: string
    error: string
    pipeline: string
    pinnable: boolean
    canonicalSlug: string
    lastProvider: string
    upstreams: string[]
    availableProviders: string[]
    tier0: string[]
  }> {
    const account = await this.resolveAccount()
    const started = Date.now()
    const result = await chatCompletion({
      fetchFn: this.fetchFn,
      baseURL: account.baseURL || DEFAULT_BASE_URL,
      apiKey: account.key,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      signal,
      timeoutMs: timeoutMs ?? this.options.attemptTimeoutMs ?? 180_000,
    })
    const payload = unwrapEnvelope(result.json)
    const ms = Date.now() - started
    if (!result.ok || (payload.error !== undefined && payload.choices === undefined) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      const message = errorText(payload.error) || String(payload.message ?? '') || result.text.slice(0, 400) || (result.ok ? 'gateway returned no completion' : `HTTP ${result.status}`)
      this.store.learn(model, { ok: false, lastError: message, lastMs: ms })
      return { ok: false, ms, model, error: message, pipeline: '', pinnable: false, canonicalSlug: '', lastProvider: '', upstreams: [], availableProviders: [], tier0: [] }
    }
    const routing = parseRouting(payload)
    const pipeline = routing.pipeline
    const otherPipeline = pipeline === 'planner' ? 'direct' : pipeline === 'direct' ? 'planner' : null
    let harvested: string[] | null = null
    if (pipeline !== null) harvested = await this.harvest(model, pipeline, account, { signal, timeoutMs: this.options.probeTimeoutMs })
    let otherHarvested: string[] | null = null
    if (otherPipeline !== null) otherHarvested = await this.harvest(model, otherPipeline, account, { signal, timeoutMs: this.options.probeTimeoutMs })
    let endpoints: Awaited<ReturnType<typeof openRouterEndpoints>>['endpoints'] = []
    let openrouterSlug: string | null = null
    if (pipeline !== 'planner' && typeof routing.canonicalSlug === 'string') {
      const detail = await openRouterEndpoints(this.fetchFn, routing.canonicalSlug, { signal, timeoutMs: this.options.probeTimeoutMs })
      endpoints = detail.endpoints
      openrouterSlug = detail.slug
    }
    const previous = this.store.metaOf(model)
    const upstreamDetail = { ...(previous.upstreamDetail ?? {}) }
    for (const entry of endpoints) upstreamDetail[entry.slug] = entry
    const discovered = pipeline === 'planner'
      ? mergeUpstreams(harvested, routing.fallbacks)
      : mergeUpstreams(routing.fallbacks, harvested, Object.keys(upstreamDetail))
    // The channel that just served the probe is a real channel whether or not
    // the router's own list mentions it, and it is the highest-confidence entry
    // there is.
    const servedRaw = typeof routing.finalProvider === 'string' && routing.finalProvider.length > 0 ? routing.finalProvider : null
    const served = servedRaw === null ? [] : [pipeline === null ? servedRaw : channelNameFor(servedRaw, pipeline)]
    const combined = mergeUpstreams(served, discovered, otherHarvested)
    // A probe that discovered nothing must not wipe what an earlier one found:
    // `validate` refuses to run without a list, and every allow-list is built
    // from it.
    const upstreams = combined.length > 0 ? combined : (Array.isArray(previous.upstreams) ? previous.upstreams : [])
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline !== null) {
      const scoped = mergeUpstreams(served, harvested)
      if (scoped.length > 0) channels[pipeline] = scoped
    }
    if (otherPipeline !== null && Array.isArray(otherHarvested) && otherHarvested.length > 0) channels[otherPipeline] = otherHarvested
    const tier0 = [...new Set([...(previous.tier0 ?? []), ...parseTier0(routing.plan)])]
    const meta = this.store.learn(model, {
      ok: true,
      pipeline,
      pinnable: pipeline !== null,
      availableProviders: harvested ?? previous.availableProviders ?? [],
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      openrouterSlug: openrouterSlug ?? previous.openrouterSlug ?? null,
      upstreamDetail,
      upstreams,
      channels,
      staleAt: combined.length === 0 && upstreams.length > 0 ? Date.now() : 0,
      tier0,
      lastProvider: routing.finalProvider ?? previous.lastProvider ?? null,
      lastMs: ms,
      probedAt: Date.now(),
      lastError: '',
    })
    return {
      ok: true,
      ms,
      model,
      error: '',
      pipeline: meta.pipeline ?? '',
      pinnable: meta.pinnable === true,
      canonicalSlug: meta.canonicalSlug ?? '',
      lastProvider: meta.lastProvider ?? '',
      upstreams: meta.upstreams ?? [],
      availableProviders: meta.availableProviders ?? [],
      tier0: meta.tier0 ?? [],
    }
  }

  /**
   * Harvest the exact channel list for one pipeline by pinning a channel that
   * cannot exist: the router fails before spending a token and names every
   * provider it could have used.
   */
  private async harvest(
    model: string,
    pipeline: 'direct' | 'planner',
    account: ClinePassAccount,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<string[] | null> {
    const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
    const body = pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
      : { ...base, provider: { only: ['__probe__'] } }
    try {
      const result = await chatCompletion({
        fetchFn: this.fetchFn,
        baseURL: account.baseURL || DEFAULT_BASE_URL,
        apiKey: account.key,
        body,
        signal,
        timeoutMs: timeoutMs ?? this.options.probeTimeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload.error) || result.text
      return extractAvailableProviders(message, pipeline)
    } catch {
      return null
    }
  }

  /**
   * Test every known channel of a model once and record the verdicts.
   *
   * A channel counts as usable only when the response names it as the one that
   * served the request; a payload carrying `choices` alone is not evidence the
   * pin was honored.
   */
  async validate(
    model: string,
    { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{
    results: Array<{ upstream: string; status: string; ms: number; note: string }>
    summary: { ok: number; limited: number; bad: number; auth: number; unknown: number }
    cancelled: boolean
  }> {
    const meta = this.store.metaOf(model) as PinModelMeta
    const list = Array.isArray(meta.upstreams) ? meta.upstreams : []
    const results: Array<{ upstream: string; status: string; ms: number; note: string }> = []
    for (let index = 0; index < list.length; index += VALIDATE_CONCURRENCY) {
      if (signal?.aborted === true) break
      const batch = list.slice(index, index + VALIDATE_CONCURRENCY)
      const settled = await Promise.all(batch.map(async (upstream) => {
        const started = Date.now()
        const attempt: PinAttempt = { upstream, strict: true, sort: null, orderRest: [], excludeList: [] }
        const base = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
        // The same injection the live path uses, so a verdict describes the pin
        // this plugin would really send.
        const body = injectPrefs(base, meta, attempt)
        try {
          const account = await this.resolveAccount()
          const result = await chatCompletion({
            fetchFn: this.fetchFn,
            baseURL: account.baseURL || DEFAULT_BASE_URL,
            apiKey: account.key,
            body,
            signal,
            timeoutMs: timeoutMs ?? this.options.probeTimeoutMs,
          })
          const payload = unwrapEnvelope(result.json)
          const ms = Date.now() - started
          let status = 'unknown'
          let note = ''
          if (!result.ok || (payload.error !== undefined && payload.choices === undefined)) {
            note = errorText(payload.error) || result.text || `HTTP ${result.status}`
            status = isAuthenticationError(note, result.status) ? 'auth' : classifyUpstreamError(note)
          } else if (payload.choices !== undefined) {
            const routing = parseRouting(payload)
            const adherence = pinAdherence(attempt, routing)
            if (adherence === 'adopted') {
              status = 'ok'
            } else if (adherence === 'unresolved') {
              note = 'the response did not name the serving channel; the pin could not be verified'
            } else {
              status = 'not-adopted'
              note = `pin not adopted: served by ${routing.finalProvider ?? '(unknown)'}`
            }
          }
          return { upstream, status, ms, note: note.slice(0, 160) }
        } catch (error) {
          return { upstream, status: 'unknown', ms: Date.now() - started, note: errorText(error).slice(0, 160) }
        }
      }))
      for (const result of settled) {
        this.store.learnUpstream(model, result.upstream, result.status as 'ok', result.note, result.ms, { includeUnknown: true })
        results.push(result)
      }
    }
    const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 }
    for (const result of results) {
      // `not-adopted` has no summary column of its own: it means "not usable as
      // a pin", which is what `bad` already counts.
      const bucket = result.status === 'not-adopted' ? 'bad' : result.status
      if (bucket === 'ok' || bucket === 'limited' || bucket === 'bad' || bucket === 'auth' || bucket === 'unknown') {
        summary[bucket] += 1
      }
    }
    this.store.learn(model, { validatedAt: Date.now() })
    return { results, summary, cancelled: signal?.aborted === true }
  }

  /**
   * Send one small chat through a (possibly temporary) pin configuration and
   * report what served it. Nothing is persisted.
   */
  async test(
    model: string,
    { upstreams, exclude, signal }: { upstreams?: string[]; exclude?: string[]; signal?: AbortSignal } = {},
  ): Promise<{
    ok: boolean
    ms: number
    model: string
    error: string
    targets: string[]
    excluded: string[]
    trace: Array<{ upstream: string; status: number; ms: number; note: string }>
    actual: string
    actualName: string
    pipeline: string
    pinnable: boolean
    canonicalSlug: string
    account: string
    content: string
    adopted: boolean
    adherence: string
    plan: string
    warnings: string[]
  }> {
    const stored = this.pinOf(model)
    const pin: PinConfig = {
      upstreams: Array.isArray(upstreams) ? upstreams : stored.upstreams,
      exclude: Array.isArray(exclude) ? exclude : stored.exclude,
      pinMode: stored.pinMode,
      sort: stored.sort,
      spelling: this.options.pinFor(model).spelling,
    }
    const started = Date.now()
    const outcome = await this.runChain(model, { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 }, pin, { signal })
    const ms = Date.now() - started
    const warnings = outcome.warnings ?? []
    const targets = [...(pin.upstreams ?? [])]
    const excluded = [...(pin.exclude ?? [])]
    const routing = outcome.result?.routing
    const account = outcome.result?.account.name ?? ''
    if (!outcome.ok) {
      this.store.record({
        model,
        provider: routing?.finalProvider ?? '',
        attempts: outcome.trace.map((row) => row.upstream),
        ms,
        stream: false,
        error: outcome.error,
        account,
      })
      return {
        ok: false,
        ms,
        model,
        error: outcome.error,
        targets: [...targets],
        excluded: [...excluded],
        trace: outcome.trace,
        actual: routing?.finalProvider ?? '',
        actualName: routing?.finalProviderName ?? '',
        pipeline: routing?.pipeline ?? '',
        pinnable: routing?.pipeline !== null && routing?.pipeline !== undefined,
        canonicalSlug: routing?.canonicalSlug ?? '',
        account,
        content: '',
        adopted: false,
        adherence: outcome.result?.adherence ?? '',
        plan: routing?.plan ?? '',
        warnings,
      }
    }
    this.store.record({
      model,
      provider: routing?.finalProvider ?? '',
      canonical: routing?.canonicalSlug ?? '',
      attempts: outcome.trace.map((row) => row.upstream),
      ms,
      stream: false,
      error: '',
      account,
    })
    return {
      ok: true,
      ms,
      model,
      error: '',
      targets: [...targets],
      excluded: [...excluded],
      trace: outcome.trace,
      actual: routing?.finalProvider ?? '',
      actualName: routing?.finalProviderName ?? '',
      pipeline: routing?.pipeline ?? '',
      pinnable: routing?.pipeline !== null && routing?.pipeline !== undefined,
      canonicalSlug: routing?.canonicalSlug ?? '',
      account,
      content: String(routing?.content ?? '').slice(0, 120),
      adopted: outcome.result?.adherence === 'adopted',
      adherence: outcome.result?.adherence ?? '',
      // The router's own account of the decision — for a planner answer it reads
      // `Provider set restricted to: <provider>`, which is the confirmation a pin
      // was applied rather than merely not contradicted.
      plan: routing?.plan ?? '',
      warnings,
    }
  }

  /**
   * Check one account key against the gateway with a single small request.
   *
   * A key that authenticates but whose model still errors (a reasoning model
   * burning `max_tokens` into an empty completion, for example) counts as
   * authorized: only a real authentication failure is reported as one.
   */
  async testAccount({
    key,
    baseURL,
    model,
    signal,
    timeoutMs = this.options.probeTimeoutMs ?? 60_000,
  }: {
    key: string
    baseURL?: string
    model: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<{ ok: boolean; authorized: boolean; ms: number; model: string; error: string }> {
    const started = Date.now()
    try {
      const result = await chatCompletion({
        fetchFn: this.fetchFn,
        baseURL: baseURL && baseURL.trim() !== '' ? baseURL.trim() : this.options.baseURL(),
        apiKey: key,
        body: { model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 },
        signal,
        timeoutMs,
      })
      const payload = unwrapEnvelope(result.json)
      const ms = Date.now() - started
      const message = errorText(payload.error) || String(payload.message ?? '') || (result.ok ? '' : result.text.slice(0, 400)) || (result.ok ? '' : `HTTP ${result.status}`)
      if (isAuthenticationError(message, result.status)) return { ok: false, authorized: false, ms, model, error: message || `HTTP ${result.status}` }
      const hasCompletion = result.ok && Array.isArray(payload.choices) && payload.choices.length > 0
      // A structured model/quota refusal can establish authorization without a
      // completion. Server failures, HTML and malformed success bodies cannot.
      const modelError = /empty response content|\bmodel(?:id)?\b|context|max[_ -]?tokens|reasoning|no (?:allowed|available) providers/i.test(message)
      const modelRefusal = payload.error !== undefined && (
        [402, 429].includes(result.status)
        || ((result.ok || [400, 404, 422].includes(result.status)) && modelError)
      )
      const authorized = hasCompletion || modelRefusal
      return { ok: authorized, authorized, ms, model, error: authorized && hasCompletion ? '' : (message || 'gateway returned no completion; authorization could not be verified') }
    } catch (error) {
      return { ok: false, authorized: false, ms: Date.now() - started, model, error: errorText(error) }
    }
  }

  /** Refresh the gateway's own catalog ids. */
  async gatewayCatalog({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[]> {
    const account = await this.resolveAccount()
    return await fetchGatewayCatalog({ fetchFn: this.fetchFn, baseURL: account.baseURL || DEFAULT_BASE_URL, apiKey: account.key, signal, timeoutMs })
  }

  /** Refresh the official subscription model list. */
  async officialModels({ signal }: { signal?: AbortSignal } = {}): Promise<ClinePassCatalogScan> {
    return await fetchOfficialModels({ fetchFn: this.fetchFn, signal })
  }

  /** Open one chat stream for the adapter; transport only. */
  async openStream(
    account: ClinePassAccount,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    return await openChatStream({
      fetchFn: this.fetchFn,
      baseURL: account.baseURL || DEFAULT_BASE_URL,
      apiKey: account.key,
      body,
      signal,
    })
  }

  /** Raise the engine's own error for a request that never reached a candidate. */
  noAccountError(error: unknown): LlmError {
    if (error instanceof LlmError) return error
    const message = error instanceof Error ? error.message : String(error)
    return new LlmError(`Cline Pass has no usable account: ${message}`, 'MISSING_CREDENTIAL')
  }
}
