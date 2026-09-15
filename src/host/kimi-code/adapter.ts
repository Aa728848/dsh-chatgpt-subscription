import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  DEFAULT_CONTEXT_WINDOW,
  FALLBACK_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  clampOutputToContext,
  codingBaseUrl,
  maxOutputTokensFor,
  reasoningEffortsFor,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  resolveRegion,
  type KimiCodeCatalogModel,
  type KimiCodePreferenceStore,
} from './token-store.ts'
import { kimiCodeModelDef } from './model-catalog.ts'
import {
  buildModelOptions,
  clearCachedCatalog,
  dynamicToolsForEntry,
  inputModalitiesForEntry,
  loadProviderModels,
  modelRequestHeaders,
  reasoningEffortsForEntry,
  wireForCatalogEntry,
} from './client.ts'
import {
  assertRequestBodyFits,
  assertStreamComplete,
  buildRequest,
  closeStream,
  createStreamState,
  estimatedInputTokens,
  offloadOldestRequestImages,
  offloadOldestRequestVideos,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  requestHasVideo,
  resolveRequestImages,
  resolveRequestVideos,
  type AttachmentImageReader,
  type AttachmentVideoReader,
  type KimiCodeStreamState,
} from './mapper.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { ensureAccessToken, KimiCodeUnauthorizedError } from './oauth.ts'
import { retryAfterMs } from '../wire-auth.ts'
import type { KimiCodeWire } from '../../shared/kimi-code-contracts.ts'

/**
 * Transient-failure retry policy for the `kimi-code` route.
 *
 * Kimi Code fronts the model providers, so a call can fail with a 502/503/504
 * while the subscription and the credential stay perfectly usable. The service
 * publishes exactly this case, and the body is usually
 * `{"error":{"message":"Upstream model provider is temporarily unavailable.
 * Please try again in a moment.","type":"server_error"}}` — which is precisely a
 * message telling the client to try again.
 *
 * The retryable set is therefore:
 *
 * - `SERVER` — any 5xx, including that upstream-unavailable 502;
 * - `RATE_LIMIT` — a 429 that is genuine back-pressure ("too many requests",
 *   "the engine is currently overloaded"), which the documentation describes as
 *   transient;
 * - `TRANSPORT` — a connection that produced no response at all;
 * - `TIMEOUT` — a stalled stream, handled by the idle watchdog.
 *
 * Deliberately outside the set:
 *
 * - `INVALID_CREDENTIAL` — a rejected access token fails identically on every
 *   attempt;
 * - `PROVIDER_ERROR` — a 400, a 401 that is really a plan-entitlement refusal,
 *   or a 403 quota limit. Retrying a quota that resets in hours only burns
 *   requests and delays the message the user needs to see;
 * - `ABORTED` — the caller already cancelled.
 *
 * The DSH normal defaults would apply anyway; stating the values here pins them
 * so this route never retries less than the rest of the plugin.
 */
export const KIMI_CODE_RETRY_POLICY_CONFIG: {
  mode: 'normal'
  maxRetries: number
  retryableCodes: string[]
  backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number }
} = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}

const RETRY_POLICY = resolveRetryPolicy(KIMI_CODE_RETRY_POLICY_CONFIG, 'dsh-chatgpt-subscription.kimi-code.retry')

/** Configured effort when the model supports it, else the adapter's preference order. */
export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
): ReasoningEffortId | undefined {
  if (configuredEffort && efforts.includes(configuredEffort)) {
    return ReasoningEffortId(configuredEffort)
  }
  return undefined
}

/**
 * What one failed response means for the retry policy.
 *
 * The service overloads a single status for unrelated problems — a 401 covers
 * both "your token is bad" and "your plan does not include k3", and a 429
 * covers both ordinary back-pressure and a spent quota that must not be
 * retried. The body text is what separates them, so the classification reads
 * it rather than trusting the status alone.
 */
export interface KimiFailureClassification {
  /** DSH error code; decides whether the route retries. */
  code: string
  /** Message shown to the user, with the provider's own text appended. */
  message: string
  /** True only when the failure is worth retrying. */
  retryable: boolean
}

/** Body text the service uses for a plan entitlement refusal (status 401). */
const ENTITLEMENT_PATTERNS = [
  /does not have access to/i,
  /supports only .* up to .* context/i,
  /model id does not exist/i,
  /recognized as other/i,
  /currently plan supports only/i,
]

/** Body text the service uses for a 429 that must NOT be retried. */
const QUOTA_EXHAUSTED_PATTERNS = [
  /exceeded_current_quota_error/i,
  /exceeded your current (token )?quota/i,
  /check your account balance/i,
  /insufficient balance/i,
  /recharge your account/i,
  /please recharge/i,
  /account (is )?in arrears/i,
]

/** Body text the service uses for an account limit (status 403). */
const ACCOUNT_LIMIT_PATTERNS = [
  /reached your .*usage limit/i,
  /reached your concurrent request limit/i,
  /usage limit for this billing cycle/i,
]

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/** Short, single-line excerpt of one error body, safe to show a user. */
export function summarizeFailureBody(raw: string): string {
  const text = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (text === '') return ''
  // The service nests its real message under `error`; unwrap it so the user
  // reads the sentence rather than a JSON envelope.
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === 'string') return error.slice(0, 400)
      if (typeof error === 'object' && error !== null) {
        const nested = error as Record<string, unknown>
        const message = nested.message ?? nested.error_description ?? nested.type
        if (typeof message === 'string') return message.slice(0, 400)
      }
      if (typeof record.message === 'string') return record.message.slice(0, 400)
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 400)
}

/**
 * Classify one non-2xx response for the retry policy.
 *
 * @param status - HTTP status the service answered with.
 * @param bodyText - raw response body, used to separate overloaded statuses.
 */
export function classifyKimiFailure(status: number, bodyText: string): KimiFailureClassification {
  const detail = summarizeFailureBody(bodyText)

  if (status === 402) {
    // "We're unable to verify your membership benefits at this time." The docs
    // describe it as usually temporary and recommend waiting and retrying.
    return {
      code: 'SERVER',
      retryable: true,
      message: `${PROVIDER_NAME} could not verify the subscription tier (402). Retrying; if it persists, confirm the membership is active.${detail ? ` ${detail}` : ''}`,
    }
  }

  if (status === 401 || status === 403) {
    if (matchesAny(detail, ENTITLEMENT_PATTERNS)) {
      // The credential is fine; the plan is the problem. Re-authenticating
      // cannot help, and retrying cannot either.
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        message: `${PROVIDER_NAME} refused this request for the current plan: ${detail || 'the requested model or context is not included'}. Switch to a model the plan includes, lower the context-window override, or upgrade the subscription.`,
      }
    }
    if (status === 403) {
      // Every 403 on this route is an account-level refusal, so the code is the
      // same either way; the matched-limit test only selects which sentence the
      // user reads. The previous form branched to one value and read as though
      // the two cases were meant to differ.
      const isLimit = matchesAny(detail, ACCOUNT_LIMIT_PATTERNS)
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        message: `${PROVIDER_NAME} blocked the request on an account limit (403): ${detail || 'the account limit was reached'}. The quota refreshes on its own schedule — check the Kimi Code card in Settings for the reset time.`,
      }
    }
    return {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      message: `${PROVIDER_NAME} rejected the stored credential (401). Sign in again from Settings > Kimi Code.${detail ? ` ${detail}` : ''}`,
    }
  }

  if (status === 429) {
    if (matchesAny(detail, QUOTA_EXHAUSTED_PATTERNS)) {
      // A spent quota is not back-pressure: the same request cannot succeed
      // until the account is topped up, so it must not be retried.
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        message: `${PROVIDER_NAME} reports the account quota is exhausted: ${detail || 'no remaining quota'}. Top up or wait for the window to reset.`,
      }
    }
    return {
      code: 'RATE_LIMIT',
      retryable: true,
      message: `${PROVIDER_NAME} is rate limited or overloaded (429): ${detail || 'too many requests'}. Retrying with backoff.`,
    }
  }

  if (status >= 500) {
    // The upstream model provider is temporarily unavailable. Neither the
    // request nor the credential is at fault, so it is retried under the
    // bounded policy above instead of failing the turn outright.
    return {
      code: 'SERVER',
      retryable: true,
      message: `${PROVIDER_NAME} upstream server error (${status}): ${detail || 'the model provider is temporarily unavailable'}. Retrying with backoff.`,
    }
  }

  if (status === 400) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: false,
      message: `${PROVIDER_NAME} rejected the request (400): ${detail || 'the request was not accepted'}`,
    }
  }

  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    message: `${PROVIDER_NAME} API error (${status}): ${detail || 'No response'}`,
  }
}

export interface KimiCodeAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /**
   * Video reader seam.
   *
   * DSH's attachment service stores images only, so a deployment that produces
   * video references injects the reader here. Absent, video occurrences degrade
   * to an explicit text placeholder rather than silently vanishing.
   */
  videos?: AttachmentVideoReader
  /** Live catalog loader seam; defaults to the managed `/models` call. */
  loadCatalog?: () => Promise<KimiCodeCatalogModel[]>
}

export class KimiCodeAdapter extends LlmAdapter {
  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: KimiCodePreferenceStore,
    private readonly options: KimiCodeAdapterOptions = {},
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

  private settings() {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  /**
   * Catalog for the picker: the live managed listing when reachable, the
   * shipped fallback otherwise, narrowed by the user's enabled selection.
   */
  private async catalog(): Promise<KimiCodeCatalogModel[]> {
    const load = this.options.loadCatalog
      ?? (() => loadProviderModels({ fetchFn: this.options.fetchFn, store: this.store }))
    const live = await load().catch(() => [])
    if (live.length > 0) return live
    return FALLBACK_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      inputModalities: [...(kimiCodeModelDef(model.id)?.inputModalities ?? ['text'])],
      supportsVideo: kimiCodeModelDef(model.id)?.inputModalities.includes('video') ?? false,
      supportsDynamicTools: kimiCodeModelDef(model.id)?.supportsDynamicTools === true,
    }))
  }

  private contextWindowFor(
    modelId: string,
    entry: KimiCodeCatalogModel | undefined,
    overrides: Record<string, number>,
  ): number {
    const override = overrides[modelId]
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override
    return entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    const catalog = await this.catalog()
    const enabled = new Set(settings.enabledModelIds)
    const available = enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id))

    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name ?? model.id,
      // Video rides through the real modality channel, so DSH's own capability
      // gates (image admission, read_image, subagent delegation) see exactly
      // what this model accepts instead of a hardcoded guess.
      inputModalities: inputModalitiesForEntry(model.id, catalog),
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Kimi Code model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    const efforts = reasoningEffortsForEntry(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
      ?? (entry?.defaultReasoningEffort === undefined
        ? undefined
        : resolveDefaultReasoningEffort(efforts, entry.defaultReasoningEffort))

    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: inputModalitiesForEntry(modelId, catalog),
      context: { contextWindow: this.contextWindowFor(modelId, entry, settings.contextWindowOverrides) },
      // The cap tracks the window so a long max-effort turn is not truncated by
      // a fixed 32K ceiling; reasoning_content is billed as output.
      defaultMaxTokens: maxOutputTokensFor(
        modelId,
        this.contextWindowFor(modelId, entry, settings.contextWindowOverrides),
      ),
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })),
              ...(defaultEffortId === undefined ? {} : { defaultEffort: defaultEffortId }),
            },
          }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = await this.settings()
    const effort = options.reasoningEffort ?? settings.defaultReasoningEffort ?? undefined
    const effectiveOptions: GenerateOptions = effort === undefined || effort === null
      ? options
      : { ...options, reasoningEffort: ReasoningEffortId(String(effort)) }

    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(effectiveOptions, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    let credentials
    try {
      // A token near expiry is rotated here; a rejected refresh token surfaces
      // as an unauthorized error, which is not retried.
      credentials = await ensureAccessToken(this.store, { fetchFn, signal })
    } catch (error) {
      if (error instanceof KimiCodeUnauthorizedError) {
        throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
      }
      throw new LlmError(
        `Kimi Code credential could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }

    const catalog = await this.catalog().catch(() => [])
    const wire: KimiCodeWire = wireForCatalogEntry(options.model, catalog)

    const entry = catalog.find((model) => model.id === options.model)

    // DSH delivers pasted images as durable references because this route
    // declares image input; both wires need bytes, so resolve them once up
    // front and reuse the result for the single request below. Video travels
    // the same path and is dropped oldest-first against its own, far larger
    // budget, because one clip dwarfs the whole image allowance.
    const requestOptions = offloadOldestRequestVideos(offloadOldestRequestImages(options))
    const [images, videos] = await Promise.all([
      resolveRequestImages(requestOptions, this.options.attachments, signal),
      resolveRequestVideos(requestOptions, this.options.videos, signal),
    ])
    const media = {
      videos,
      videoAccepted: inputModalitiesForEntry(options.model, catalog).includes('video'),
      // Same resolver the settings card uses, so UI and wire cannot disagree.
      messageTools: dynamicToolsForEntry(options.model, catalog),
    }

    const settings = await this.settings()
    const contextWindow = this.contextWindowFor(
      options.model,
      entry,
      settings.contextWindowOverrides,
    )
    // A hand-built request states its own cap; an unstated one tracks the window
    // so long reasoning is not cut off at a fixed ceiling, and either way the
    // cap is reduced when the caller already knows the prompt will not fit.
    // A request carrying video is measured against the larger ceiling, so the
    // caller is told about an oversized body rather than about a limit sized
    // for text alone.
    const requestedMax = options.maxTokens ?? maxOutputTokensFor(options.model, contextWindow)
    const boundedOptions: GenerateOptions = {
      ...requestOptions,
      maxTokens: clampOutputToContext(requestedMax, contextWindow, estimatedInputTokens(requestOptions)),
    }
    const built = buildRequest(boundedOptions, wire, images, undefined, media)
    assertRequestBodyFits(built, requestHasVideo(requestOptions))
    const body = JSON.stringify(built)

    const region = credentials.region ?? await resolveRegion()
    const base = (credentials.baseUrl ?? codingBaseUrl(region)).replace(/\/+$/, '')
    const endpoint = wire === 'anthropic'
      ? `${base}/v1/messages?beta=true`
      : `${base}/v1/chat/completions`
    const headers = await modelRequestHeaders(credentials.accessToken, wire)

    let response: Response
    try {
      response = await fetchFn(endpoint, { method: 'POST', headers, body, signal })
    } catch (error) {
      if (signal.aborted) throw new LlmError('Kimi Code request aborted', 'ABORTED', { cause: error })
      // A connection that never produced a response is a transport failure, not
      // a verdict from the provider: the same request is eligible for the
      // bounded backoff above instead of failing the turn outright.
      throw new LlmError(
        `Kimi Code request failed: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 2_000)
      const failure = classifyKimiFailure(response.status, detail)
      const after = response.status === 429 ? retryAfterMs(response.headers) : undefined
      throw new LlmError(failure.message, failure.code, {
        status: response.status,
        ...(after === undefined ? {} : { providerRetryAfterMs: after }),
      })
    }

    if (response.body === null) throw new LlmError('Kimi Code returned an empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createStreamState(wire)
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const chunk of processLine(line, state, wire)) yield chunk
          if (state.finished) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processLine(line, state, wire)) yield chunk
        }
      }
      if (state.finished) return

      // A connection that ends without a terminal event is a truncated stream,
      // not a completed answer; the watchdog turns a stalled one into an abort.
      assertStreamComplete(state)
      for (const chunk of closeStream(state)) yield chunk
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}

function processLine(line: string, state: KimiCodeStreamState, wire: KimiCodeWire): StreamChunk[] {
  return wire === 'anthropic'
    ? processAnthropicStreamLine(line, state)
    : processOpenAIStreamLine(line, state)
}

export { clearCachedCatalog, buildModelOptions, reasoningEffortsFor, PROVIDER_ID }
