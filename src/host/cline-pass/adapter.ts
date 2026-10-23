/**
 * The Cline Pass LLM adapter: an OpenAI-compatible `chat/completions` stream
 * with upstream pinning, per-account rotation, and pre-first-token failover.
 *
 * Transport and mapping live in `client.ts` / `mapper.ts`; account selection and
 * probing live in `engine.ts`. This module owns the request loop: which account,
 * which channel, and when an attempt is abandoned.
 *
 * @module dsh-chatgpt-subscription/cline-pass-adapter
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions as HarnessGenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { normalizeGenerateOptions, type GenerateOptions } from '../common/llm-compat.ts'
import {
  DEFAULT_MODELS,
  POOL_COOLDOWN_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  type ClinePassConnection,
  type ClinePassDiscoveredModel,
} from './types.ts'
import { resolveModelInfo } from './catalog.ts'
import { buildAttempts, injectPrefs, isRecord, pinAdherence, pinWarnings, parseRouting, unwrapEnvelope, type ClinePipeline } from './protocol.ts'
import {
  buildClinePassBody,
  parseServerSentEvents,
  translate,
  streamErrorCode,
} from './mapper.ts'
import type { ClinePassEngine } from './engine.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassModelSettings, ClinePassModelSettingsStore } from './token-store.ts'
import type { ClinePassAccountPool } from './account-pool.ts'
import { outputReservation } from '../common/output-reservation.ts'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  wrapStreamWithWatchdog,
  type StreamActivity,
} from '../common/idle-watchdog.ts'
import { ConcurrencyGate } from '../common/concurrency-gate.ts'
import { resolveRequestImages, NO_RESOLVED_IMAGES, type AttachmentImageReader } from '../common/request-images.ts'

/**
 * Retry policy for the `cline-pass` route.
 *
 * A 5xx from the gateway says nothing about this key, so it is classified as
 * `SERVER` and given the same bounded backoff the other lines use. Deliberately
 * outside the set: `AUTH` and `QUOTA` (the pool rotates past those) and
 * `ABORTED`.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.cline-pass.retry')

/** How long one attempt may wait for response headers before it is abandoned. */
const ATTEMPT_TIMEOUT_MS = 180_000

/**
 * Retries for a failure that happened BEFORE the request was sent.
 *
 * A TLS handshake to the gateway can fail intermittently on a network path
 * where curl succeeds (the pinned upstream is never contacted: the body with
 * `provider.only` has not left the host). Retrying is safe because no HTTP
 * request reached the server, and it turns a one-in-two TLS failure into a rare
 * one. Errors after headers, or ambiguously mid-request, are never retried here.
 */
const TRANSPORT_RETRIES = 2
const TRANSPORT_RETRY_BASE_MS = 400

export interface ClinePassAdapterOptions {
  /** Durable attachment service, for request images. */
  attachments?: AttachmentImageReader
}

export class ClinePassAdapter extends LlmAdapter {
  private readonly gate = new ConcurrencyGate()

  constructor(
    private readonly engine: ClinePassEngine,
    private readonly store: ClinePassStore,
    private readonly modelSettings: ClinePassModelSettingsStore,
    private readonly accountPool: ClinePassAccountPool,
    private readonly options: ClinePassAdapterOptions = {},
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  imageRequestPricing(): undefined {
    return undefined
  }

  private settings(): Promise<ClinePassModelSettings> {
    return this.modelSettings.read()
  }

  /**
   * The ids the route advertises: the shipped table, models a live scan adopted,
   * and (when asked) the gateway's own catalog — narrowed by the user's selection
   * and hidden list.
   */
  private async availableModelIds(settings: ClinePassModelSettings): Promise<string[]> {
    const ids = new Set<string>(DEFAULT_MODELS)
    for (const model of settings.catalogModels) ids.add(model.id)
    if (settings.exposeCatalog === true) {
      for (const id of this.store.catalog().ids) ids.add(id)
    }
    const hidden = new Set(settings.hiddenModels)
    const enabled = settings.enabledModelIds === null ? null : new Set(settings.enabledModelIds)
    return [...ids].filter((id) => !hidden.has(id) && (enabled === null || enabled.has(id)))
  }

  /** One model's resolved descriptor, from the shipped catalog plus live data. */
  private async modelInfo(modelId: string): Promise<ReturnType<typeof resolveModelInfo>> {
    const settings = await this.settings()
    const catalogModels = this.store.catalog().models
    const raw = isRecord(catalogModels[modelId]) ? catalogModels[modelId] : undefined
    const discovered: ClinePassDiscoveredModel | undefined = raw === undefined
      ? undefined
      : {
          ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
          ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
          ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
          ...(Array.isArray(raw.inputModalities) ? { inputModalities: raw.inputModalities.filter((item): item is string => typeof item === 'string') } : {}),
          ...(Array.isArray(raw.input) ? { input: raw.input.filter((item): item is string => typeof item === 'string') } : {}),
          ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
          ...(Array.isArray(raw.efforts) ? { efforts: raw.efforts.filter((item): item is string => typeof item === 'string') } : {}),
        }
    return resolveModelInfo(modelId, {
      displayName: PROVIDER_NAME,
      synced: settings.catalogModels,
      ...(discovered === undefined ? {} : { discovered }),
      ...(settings.contextWindowOverrides[modelId] === undefined ? {} : { contextWindowOverride: settings.contextWindowOverrides[modelId] }),
      defaultContextWindow: settings.defaultContextWindow,
      defaultMaxTokens: settings.defaultMaxTokens,
    })
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const ids = await this.availableModelIds(settings)
    return await Promise.all(ids.map(async (id) => {
      const info = await this.modelInfo(id)
      return {
        provider: prov,
        id,
        name: info.displayName,
        inputModalities: info.input as LlmModelInfo['inputModalities'],
      }
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Cline Pass model resolution aborted', 'ABORTED')
    const info = await this.modelInfo(modelId)
    return {
      provider,
      id: modelId,
      name: info.displayName,
      inputModalities: info.input as LlmResolvedModelInfo['inputModalities'],
      context: { contextWindow: info.contextWindow },
      ...outputReservation(info.contextWindow, info.maxTokens),
      ...(info.reasoning
        ? {
            reasoning: {
              efforts: info.efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: HarnessGenerateOptions): AsyncIterable<StreamChunk> {
    const settings = await this.settings()
    yield* wrapStreamWithWatchdog(
      (watchdogSignal, activity) => this.requestStream(options, settings, watchdogSignal, activity),
      options.signal,
      settings.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(
    rawOptions: HarnessGenerateOptions,
    settings: ClinePassModelSettings,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    if (settings.enabled === false) {
      throw new LlmError(`${PROVIDER_NAME} is disabled in Settings > Subscription. Enable the line there, then retry.`, 'INVALID_REQUEST')
    }
    const options: GenerateOptions = normalizeGenerateOptions(rawOptions)
    const images = await resolveRequestImages(
      options,
      this.options.attachments as AttachmentImageReader | undefined,
      signal,
    ).catch((error) => {
      if (signal.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
      return NO_RESOLVED_IMAGES
    })
    const connection: ClinePassConnection = {
      baseURL: settings.baseURL,
      displayName: PROVIDER_NAME,
      models: [],
      defaultContextWindow: settings.defaultContextWindow,
      maxTokens: settings.defaultMaxTokens,
      streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
      maxConcurrentRequests: settings.maxConcurrentRequests,
      pinSpelling: settings.pinSpelling,
    }
    const body = buildClinePassBody(options, connection, images)
    const attempts = buildAttempts(this.engine.pinConfigFor(options.model))
    const meta = this.store.metaOf(options.model)
    const startedAt = Date.now()
    const trace: string[] = []
    const refused = new Set<string>()
    let firstByteMs = 0
    let firstChunkMs = 0
    let delivered = false
    let lastError: LlmError | null = null
    let attemptIndex = 0

    while (attemptIndex < attempts.length) {
      const attempt = attempts[attemptIndex++]
      let account: Awaited<ReturnType<ClinePassEngine['resolveAccount']>>
      try {
        account = await this.engine.resolveAccount(refused)
      } catch (error) {
        throw lastError ?? this.engine.noAccountError(error)
      }
      const consumer = new AbortController()
      const upstream = AbortSignal.any([signal, consumer.signal])
      let release: () => void = () => undefined
      try {
        release = await this.gate.acquire(account.id, upstream)
      } catch (error) {
        if (signal.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
        throw error
      }
      const attemptStarted = Date.now()
      const attemptLabel = attempt.upstream ?? '(auto)'
      try {
        const pinned = injectPrefs(body as unknown as Record<string, unknown>, meta, attempt)
        let response: Response | undefined
        let transportError: unknown
        for (let transportTry = 0; transportTry <= TRANSPORT_RETRIES; transportTry += 1) {
          try {
            response = await this.engine.openStream(account, pinned, withAttemptTimeout(upstream))
            break
          } catch (error) {
            if (signal.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
            transportError = error
            // Only a failure that happened before the request was sent is safe
            // to replay. A mid-request reset might already have been served.
            if (transportTry < TRANSPORT_RETRIES && isPreConnectionFailure(error)) {
              try {
                await sleep(TRANSPORT_RETRY_BASE_MS * (transportTry + 1), undefined, { signal: upstream })
              } catch (waitError) {
                if (signal.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: waitError })
                throw waitError
              }
              continue
            }
            break
          }
        }
        if (response === undefined) {
          const note = errorChain(transportError)
          const hint = isPreConnectionFailure(transportError)
            ? ` The request never reached the gateway, so the pinned upstream was not contacted: ${account.baseURL} failed during TLS/connect. Check the network, proxy or TUN, or set a custom proxy in the plugin.`
            : ''
          trace.push(attemptLabel)
          this.store.learnUpstream(options.model, attempt.upstream, 'unknown', note, Date.now() - attemptStarted)
          lastError = new LlmError(note + hint, 'TRANSPORT', { cause: transportError })
          continue
        }
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          let detail = raw.slice(0, 400)
          try {
            const parsed = unwrapEnvelope(JSON.parse(raw))
            detail = errorMessage(parsed) || detail
          } catch { /* keep the raw text */ }
          const ms = Date.now() - attemptStarted
          trace.push(attemptLabel)
          this.store.learnUpstream(options.model, attempt.upstream, classifyVerdict(detail), detail, ms)
          const code = streamErrorCode(detail, response.status)
          lastError = new LlmError(`${detail || `HTTP ${response.status}`} [model=${options.model}]`, code, { status: response.status })
          // A rejected pin or a busy upstream is worth another candidate. An
          // account-level refusal is worth another ACCOUNT: that is the whole
          // point of a pool, and with one account the next attempt simply finds
          // nothing left and this error is raised unchanged.
          if (code === 'AUTH' || code === 'QUOTA') {
            refused.add(account.id)
            await this.standDown(account.id, code, detail)
            // A spent account says nothing about this channel. Give the next
            // account the full chain, including a lone auto route or strict pin.
            attemptIndex = 0
            this.store.record({
              model: options.model,
              provider: '',
              attempts: trace.map(String),
              ms: Date.now() - startedAt,
              stream: true,
              error: detail.replace(/\s+/g, ' ').trim().slice(0, 200),
              code,
              account: account.name,
            })
          }
          continue
        }
        if (response.body === null) {
          lastError = new LlmError('gateway returned no response body', 'EMPTY_RESPONSE', { status: response.status })
          continue
        }
        const observed: { provider: string | null; canonical: string | null; pipeline: ClinePipeline | null; fingerprint: string | null; anonymous: boolean } = { provider: null, canonical: null, pipeline: null, fingerprint: null, anonymous: false }
        const responseBody = tapChunks(response.body, () => {
          activity?.pulse()
          if (firstByteMs === 0) firstByteMs = Date.now() - startedAt
        })
        const iterator = translate(tapRouting(parseServerSentEvents(responseBody), observed))[Symbol.asyncIterator]()
        let yielded = false
        let usage: TokenUsage | undefined
        let finishFailure: { message: string; code: string } | null = null
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done === true) break
            if (next.value.type === 'usage') usage = next.value.usage
            if (next.value.type === 'finish' && next.value.reason.kind === 'error') finishFailure = next.value.reason.failure
            if (firstChunkMs === 0) firstChunkMs = Date.now() - startedAt
            yielded = true
            yield next.value
          }
        } catch (error) {
          if (signal.aborted) throw new LlmError('Cline Pass request aborted by caller', 'ABORTED', { cause: error })
          const note = error instanceof LlmError ? error.message : errorChain(error)
          const code = error instanceof LlmError ? error.code : 'TRANSPORT'
          const ms = Date.now() - attemptStarted
          trace.push(attemptLabel)
          this.store.learnUpstream(options.model, attempt.upstream, classifyVerdict(note), note, ms)
          // Content already reached the caller: this is the answer's failure, and
          // no retry can un-deliver it. Before any content, an account-level
          // refusal moves to the next account.
          if (yielded) {
            this.store.record({
              model: options.model,
              provider: observed.provider ?? '',
              canonical: observed.canonical ?? '',
              attempts: trace.map(String),
              ms: Date.now() - startedAt,
              ttfb: firstByteMs,
              ttft: firstChunkMs,
              stream: true,
              error: note.slice(0, 200),
              code,
              account: account.name,
            })
            throw error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          }
          if (code === 'AUTH' || code === 'QUOTA') {
            refused.add(account.id)
            await this.standDown(account.id, code, note)
            attemptIndex = 0
            this.store.record({
              model: options.model,
              provider: observed.provider ?? '',
              canonical: observed.canonical ?? '',
              attempts: trace.map(String),
              ms: Date.now() - startedAt,
              ttfb: firstByteMs,
              ttft: firstChunkMs,
              stream: true,
              error: note.slice(0, 200),
              code,
              account: account.name,
            })
          }
          lastError = error instanceof LlmError ? error : new LlmError(note, 'TRANSPORT', { cause: error })
          continue
        } finally {
          consumer.abort('Cline Pass stream consumer stopped')
          void iterator.return?.(undefined).catch(() => undefined)
        }
        delivered = true
        const adherence = pinAdherence(attempt, { finalProvider: observed.provider })
        const warnings = pinWarnings({ upstream: attempt.upstream, excludeList: attempt.excludeList }, meta)
        // The pin verdict is only readable after the stream ends (the routing
        // frame trails the content), so an ignored pin cannot be failed over —
        // but it must be SAID, or a strict pin silently becomes the anonymous
        // contributor route's answer.
        if (adherence === 'not-adopted') {
          warnings.push(`pinNotAdopted: the gateway served ${observed.provider ?? '(unknown)'} instead of the pinned ${attempt.upstream ?? '(auto)'}`)
        } else if (adherence === 'violated') {
          warnings.push(`pinViolated: an excluded channel served this request: ${observed.provider ?? '(unknown)'}`)
        }
        if (observed.anonymous) {
          warnings.push(`anonymousServed: this answer came from the gateway's anonymous contributor route (${observed.provider ?? 'openai-compatible-private'}) — it may be used for training and carries no zero-data-retention guarantee`)
        }
        const ms = Date.now() - attemptStarted
        trace.push(attemptLabel)
        this.store.record({
          model: options.model,
          provider: observed.provider ?? attempt.upstream ?? '',
          canonical: observed.canonical ?? '',
          attempts: trace.map(String),
          ms: Date.now() - startedAt,
          ttfb: firstByteMs,
          ttft: firstChunkMs,
          stream: true,
          error: finishFailure?.message ?? '',
          code: finishFailure?.code ?? '',
          account: account.name,
          adherence,
          fingerprint: observed.fingerprint ?? '',
          anonymous: observed.anonymous,
          warnings,
          ...(usage === undefined ? {} : { usage }),
          effort: options.reasoningEffort === undefined ? '' : String(options.reasoningEffort),
        })
        // The fingerprint is the only proof of a first-party DeepSeek answer;
        // keep the freshest reading on the model so the card can show it.
        if (observed.fingerprint !== null || observed.provider !== null) {
          this.store.learn(options.model, {
            ...(observed.provider === null ? {} : { lastProvider: observed.provider }),
            ...(observed.fingerprint === null ? {} : { lastFingerprint: observed.fingerprint }),
          })
        }
        void this.accountPool.recordModel(account.id, options.model)
        // Only a pin the router actually honored proves the channel works.
        // Marking it usable no matter who answered is how a false "available"
        // reached the verdict map the exclusion allow-list is built from.
        if (finishFailure === null && attempt.upstream !== null && adherence === 'adopted') {
          this.store.learnUpstream(options.model, attempt.upstream, 'ok', '', ms)
        }
        return
      } finally {
        release()
      }
    }
    if (!delivered) {
      const message = lastError?.message ?? 'no pinned upstream could serve the request'
      this.store.record({
        model: options.model,
        provider: '',
        attempts: trace.map(String),
        ms: Date.now() - startedAt,
        ttfb: firstByteMs,
        ttft: firstChunkMs,
        stream: true,
        error: message.slice(0, 200),
        account: '',
      })
      throw lastError ?? new LlmError(`${message} [model=${options.model}]`, 'UPSTREAM')
    }
  }

  /** Park an account that refused a request, for the reason it refused. */
  private async standDown(accountId: string, code: string, detail: string): Promise<void> {
    if (code === 'AUTH') {
      await this.accountPool.markAuthFailed(accountId, `${PROVIDER_NAME} rejected this API key. Replace it from the account card. ${detail.slice(0, 160)}`, 'invalid').catch(() => undefined)
      return
    }
    await this.accountPool.markCooldown(accountId, POOL_COOLDOWN_MS, `${PROVIDER_NAME} quota exhausted`).catch(() => undefined)
  }
}

/** A caller signal combined with the attempt's header deadline. */
function withAttemptTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
}

/**
 * Whether a transport failure happened before any request was sent.
 *
 * Deliberately narrow: `other side closed`/`ECONNRESET` can happen after the
 * body was accepted, and replaying those is not safe. These are the handshake
 * and connect failures only.
 */
function isPreConnectionFailure(error: unknown): boolean {
  const text = errorChain(error)
  return /Client network socket disconnected before secure TLS connection|Connect Timeout Error|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)
}

/** Password-style redaction is not needed here; the chain is transport-only. */
function errorChain(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause === undefined ? error.message : `${error.message}: ${errorChain(cause)}`
  }
  return String(error)
}

/** The gateway's own one-line explanation, when it sent one. */
function errorMessage(payload: Record<string, unknown>): string {
  const value = payload.error ?? payload.message
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.message === 'string') return value.message
  return ''
}

/** One failed pin's verdict. */
function classifyVerdict(detail: string): 'unknown' | 'limited' | 'bad' | 'auth' | 'ok' {
  if (/empty response content/i.test(detail)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(detail)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(detail)) return 'bad'
  if (/unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)) return 'auth'
  return 'unknown'
}

/**
 * Report transport activity and the first byte without disturbing the stream.
 *
 * A keep-alive comment or an early frame reaches this before it reaches the SSE
 * parser, so the recorded moment is the gateway's first sign of life rather than
 * the caller's first content.
 */
function tapChunks(body: ReadableStream<Uint8Array>, onChunk: () => void): ReadableStream<Uint8Array> {
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onChunk()
      controller.enqueue(chunk)
    },
  }))
}

/**
 * Watch a payload stream for routing metadata without disturbing it.
 *
 * The gateway attaches `provider_metadata.gateway.routing` to the message of a
 * non-streaming answer; in a stream it appears on whichever frame carries it,
 * so every frame is inspected and the last non-null reading wins.
 */
async function* tapRouting(
  payloads: AsyncIterable<unknown | '[DONE]'>,
  observed: { provider: string | null; canonical: string | null; pipeline: ClinePipeline | null; fingerprint: string | null; anonymous: boolean },
): AsyncGenerator<unknown | '[DONE]'> {
  for await (const payload of payloads) {
    if (payload !== '[DONE]') {
      const routing = parseRouting(payload)
      if (routing.finalProvider !== null) {
        observed.provider = routing.finalProvider
        observed.pipeline = routing.pipeline
        observed.anonymous = routing.anonymous
        if (routing.canonicalSlug !== null) observed.canonical = routing.canonicalSlug
      }
      // A frame can carry the first-party fingerprint without repeating the
      // routing block; whichever frame carries it, the last reading wins.
      if (routing.fingerprint !== null) observed.fingerprint = routing.fingerprint
    }
    yield payload
  }
}
