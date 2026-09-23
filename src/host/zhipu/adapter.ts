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
  ERROR_CODE,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ZhipuModelSettings,
  type ZhipuPreferenceStore,
} from './token-store.ts'
import {
  FALLBACK_MODELS,
  defaultContextWindowFor,
  maxOutputTokensFor,
  modelsForRegion,
  resolveZhipuModel,
  zhipuModelSupportsImage,
  zhipuReasoningEfforts,
  type ZhipuModelEntry,
} from './model-catalog.ts'
import { fetchCatalog, zhipuHeaders } from './client.ts'
import { resolveEnabledModelIds } from './routes.ts'
import {
  assertStreamComplete,
  buildChatRequest,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processStreamLine,
  resolveRequestImages,
  type AttachmentImageReader,
} from './mapper.ts'
import { normalizeGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'
import { convergeZhipuEffort } from '../../shared/zhipu-contracts.ts'
import type { ZhipuCredentials } from './token-store.ts'
import type { ZhipuAccountPool } from './account-pool.ts'

/**
 * Transient-failure retry policy for the `zhipu-coding-plan` route.
 *
 * The plan fronts several upstream model vendors, so a call can fail with an
 * upstream 5xx (`code 1230`/`1234`) while the account and key stay perfectly
 * usable. Those are classified as `SERVER` and given bounded backoff, mirroring
 * the sibling provider lines. Deliberately outside the set: `INVALID_CREDENTIAL`
 * (a rejected key fails identically on every attempt) and `ABORTED` (the caller
 * already cancelled).
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.zhipu.retry')

/**
 * Effort this route materializes when the caller names none.
 *
 * Preference order: the caller's explicit level when the model accepts it,
 * otherwise the user's configured level when the model accepts it, otherwise
 * nothing. Nothing is a real answer on this route: the provider's own default
 * is `max` for a model that takes an effort field, so omitting the field is not
 * "no thinking" — it is the provider's documented default.
 *
 * A candidate outside the model's ladder is converged onto the nearest rung
 * rather than sent, because an unsupported level is an error (`code 1214`), and
 * rather than dropped, because dropping the user's explicit choice silently
 * changes how hard the model thinks.
 */
export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
): ReasoningEffortId | undefined {
  if (efforts.length === 0) return undefined
  if (configuredEffort) {
    const converged = convergeZhipuEffort(configuredEffort, efforts)
    if (converged !== null) return ReasoningEffortId(converged)
  }
  return undefined
}

/**
 * Cooldown a 429 imposes when the service names no reset instant.
 *
 * The plan's allowance windows are hours long, so a shorter cooldown would
 * rediscover the same exhausted window immediately.
 */
export const POOL_COOLDOWN_MS = 10 * 60 * 1000

export interface ZhipuAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /** Live catalog loader seam; defaults to the managed `/models` call. */
  loadCatalog?: (credentials: ZhipuCredentials) => Promise<ZhipuModelEntry[]>
  /**
   * Multi-account pool this adapter rotates through.
   *
   * Absent leaves the line on its single-credential path, which is what the
   * headless tests and any caller that predates the pool use.
   */
  accountPool?: ZhipuAccountPool
}

export class ZhipuAdapter extends LlmAdapter {
  /** Null keeps the pre-pool single-credential path. */
  private readonly accountPool: ZhipuAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: ZhipuPreferenceStore,
    private readonly options: ZhipuAdapterOptions = {},
  ) {
    super()
    this.accountPool = options.accountPool ?? null
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

  private settings(): Promise<ZhipuModelSettings> {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  /**
   * Credential the picker and the single-credential path read.
   *
   * With a pool installed the store holds the mirrored primary account, so this
   * stays the same read path either way; the pool is consulted only when a
   * request is actually served, which is where per-account rotation matters.
   */
  private async credentials(): Promise<ZhipuCredentials | null> {
    return this.store.read()
  }

  private async catalog(credentials: ZhipuCredentials): Promise<readonly ZhipuModelEntry[]> {
    const load = this.options.loadCatalog
      ?? ((current: ZhipuCredentials) => fetchCatalog(current, { fetchFn: this.options.fetchFn }))
    const live = await load(credentials).catch(() => [])
    return live.length > 0 ? live : FALLBACK_MODELS
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const credentials = await this.credentials()
    // Before a sign-in no deployment is known, so the shipped table stands in
    // and the picker is usable; the credentials decide which entries apply.
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const available = credentials === null ? [...catalog] : modelsForRegion(credentials.region, catalog)
    const enabled = new Set(resolveEnabledModelIds(
      settings.enabledModelIds,
      available.map((model) => model.id),
      true,
    ))

    return available
      .filter((model) => enabled.has(model.id))
      .map((model) => ({
        provider: prov,
        id: model.id,
        name: model.name,
        // No `description`: the sibling routes advertise a name only, and a
        // description here would make the shared picker show a second line for
        // this route alone.
        inputModalities: model.supportsImage ? ['text', 'image'] as const : ['text'] as const,
      }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('GLM Coding Plan model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const credentials = await this.credentials()
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const entry = resolveZhipuModel(modelId, catalog)
    const efforts = zhipuReasoningEfforts(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
    const override = settings.contextWindowOverrides[modelId]
    const contextWindow = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : defaultContextWindowFor(modelId, catalog)

    return {
      provider,
      id: modelId,
      name: entry.id === modelId ? entry.name : modelId,
      inputModalities: entry.supportsImage ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: maxOutputTokensFor(modelId, catalog),
      // No `systemPromptUpdate: 'in-history'`: the wire carries the system
      // prompt in the leading message, never inside the history, so this route
      // cannot read a later system message as the effective prompt.
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
    const effort = await this.effortFor(options)
    const effectiveOptions: GenerateOptions = effort === undefined
      ? options
      : { ...options, reasoningEffort: ReasoningEffortId(effort) }

    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(effectiveOptions, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /**
   * Effort this request should carry, or `undefined` to send none.
   *
   * Order: the caller's explicit choice, then the user's configured level. Both
   * are converged onto the model's own ladder — the provider rejects a level
   * outside it — and a model that declares no ladder gets none, because sending
   * an effort to a model that takes no such field is exactly the 400 this
   * convergence exists to avoid.
   */
  private async effortFor(options: GenerateOptions): Promise<string | undefined> {
    const settings = await this.settings()
    const credentials = await this.credentials()
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const efforts = zhipuReasoningEfforts(options.model, catalog)
    if (efforts.length === 0) return undefined

    const candidates = [
      options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      settings.defaultReasoningEffort ?? undefined,
    ]
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === '') continue
      const converged = convergeZhipuEffort(candidate, efforts)
      if (converged !== null) return converged
    }
    return undefined
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)

    const pool = this.accountPool
    const tried = new Set<string>()
    let response: Response | undefined
    let accountId: string | undefined
    // Built per attempt: the effort ladder is a property of the credential's
    // catalog, and the body carries that ladder's convergence.
    let body = ''

    while (true) {
      let credentials: ZhipuCredentials

      if (pool === null) {
        const stored = await this.credentials()
        if (stored === null) {
          throw new LlmError(
            `Not signed in to ${PROVIDER_NAME}. Add a GLM Coding Plan API key in `
            + 'Settings > GLM Coding Plan, or paste one there.',
            'MISSING_CREDENTIAL',
          )
        }
        credentials = stored
      } else {
        let effective: { account: { id: string }; credentials: ZhipuCredentials }
        try {
          effective = await pool.getEffectiveAccount(tried, fetchFn)
        } catch (error) {
          // The pool's own verdict (an exhausted rotation) is already typed; a
          // plain error means no account is signed in at all.
          if (error instanceof LlmError) throw error
          throw new LlmError(
            error instanceof Error ? error.message : `Not signed in to ${PROVIDER_NAME}.`,
            'MISSING_CREDENTIAL',
            { cause: error },
          )
        }
        accountId = effective.account.id
        tried.add(accountId)
        credentials = effective.credentials
      }

      const catalog = await this.catalog(credentials)
      const efforts = zhipuReasoningEfforts(options.model, catalog)
      const converged = options.reasoningEffort === undefined
        ? undefined
        : convergeZhipuEffort(String(options.reasoningEffort), efforts) ?? undefined
      // The caller's level is converged here, against *this* account's catalog,
      // because a pool may hold accounts whose live listings differ.
      const attemptOptions = converged === undefined
        ? requestOptions
        : { ...requestOptions, reasoningEffort: ReasoningEffortId(converged) }
      body = JSON.stringify(buildChatRequest(attemptOptions, images, efforts))

      try {
        response = await fetchFn(`${credentials.apiBase}/api/coding/paas/v4/chat/completions`, {
          method: 'POST',
          headers: zhipuHeaders(credentials, { accept: 'text/event-stream' }),
          body,
          // The idle watchdog owns the deadline: it resets while tokens flow, so
          // a long but active generation is not cut off by a wall-clock cap.
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw new LlmError('GLM Coding Plan request aborted', 'ABORTED', { cause: error })
        throw new LlmError(
          `GLM Coding Plan request failed: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error },
        )
      }

      if (response.ok) break

      const detail = (await response.text().catch(() => '')).slice(0, 600)
      const failure = classifyFailure(response.status, detail, response.headers)

      if (pool !== null && accountId !== undefined) {
        const after = retryAfterMs(response.headers)
        if (failure.code === 'RATE_LIMIT') {
          await pool.markCooldown(accountId, after ?? POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`)
            .catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        } else if (failure.code === 'INVALID_CREDENTIAL') {
          // A dead key is that account's problem alone: keep the account (adding
          // it again restores it) and take it out of rotation.
          await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        }
      }

      throw failure
    }

    if (response === undefined) throw new LlmError('GLM Coding Plan produced no response', 'PROVIDER_ERROR')
    if (response.body === null) throw new LlmError('GLM Coding Plan returned an empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createStreamState()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const chunk of processStreamLine(line, state)) yield chunk
          if (state.finished) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processStreamLine(line, state)) yield chunk
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

/**
 * Map one failed HTTP response onto a DSH failure.
 *
 * The platform reports its own condition inside a JSON `code` while the status
 * line stays generic, so the body is read for the cases the status alone cannot
 * express. Several distinct conditions share one status — 429 covers a spent
 * window, a lapsed plan, and a per-model entitlement gap — and they need
 * different actions, which is exactly why the code decides.
 */
export function classifyFailure(
  status: number,
  detail: string,
  headers?: Headers,
): LlmError {
  const code = readErrorCode(detail)

  if (status === 401 || status === 403
    || code === ERROR_CODE.AUTH_INVALID
    || code === ERROR_CODE.AUTH_EXPIRED
    || code === ERROR_CODE.AUTH_MISSING) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the stored API key (${status}). `
      + `Add the key again in Settings > GLM Coding Plan.${detail ? ` ${detail}` : ''}`,
      'INVALID_CREDENTIAL',
      { status },
    )
  }

  // A per-model entitlement gap is a 429 on this platform but is not transient:
  // the plan simply does not include the model, so retrying cannot help and the
  // only fix is a different model.
  if (code === ERROR_CODE.MODEL_NOT_IN_PLAN) {
    return new LlmError(
      `${PROVIDER_NAME} does not include this model in the current plan. `
      + `Pick a different model in Settings > GLM Coding Plan.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // A lapsed package is likewise not transient: it needs a renewal.
  if (code === ERROR_CODE.PLAN_EXPIRED) {
    return new LlmError(
      `${PROVIDER_NAME} plan package has expired and is temporarily unavailable. `
      + `Renew the subscription to resume.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // An unknown model id and a wrong call method are both request problems.
  if (code === ERROR_CODE.UNKNOWN_MODEL || code === ERROR_CODE.WRONG_METHOD) {
    return new LlmError(
      `${PROVIDER_NAME} does not serve this model id. `
      + `Refresh the catalog and pick a model from it.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  if (code === ERROR_CODE.PROMPT_TOO_LONG) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the request: the prompt exceeds the model's context window. `
      + `Compact the conversation or lower the context-window override.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // A rejected parameter (an unsupported reasoning level, an unreadable image)
  // is a request problem rather than a transient one.
  if (code === ERROR_CODE.INVALID_PARAM || code === ERROR_CODE.MISSING_PARAM || code === ERROR_CODE.CONTENT_FILTERED) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the request parameters (${code ?? status}). `
      + `An image may be unsupported by this model, or a reasoning level is unavailable for it.`
      + `${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // Everything else the platform calls a limit is retryable: a spent window
  // refills, an overloaded service recovers, and an empty balance is restored by
  // a recharge or by the next reset. The body carries the reset instant when the
  // service names one.
  const isLimit = status === 429
    || code === ERROR_CODE.RATE_LIMITED
    || code === ERROR_CODE.OVERLOADED
    || code === ERROR_CODE.USAGE_LIMIT
    || code === ERROR_CODE.PLAN_LIMIT
    || code === ERROR_CODE.NO_BALANCE
  if (isLimit) {
    const after = headers ? retryAfterMs(headers) : undefined
    return new LlmError(
      `${PROVIDER_NAME} rate limit or plan allowance reached. Check the quota card in Settings > GLM Coding Plan.`
      + `${detail ? ` ${detail}` : ''}`,
      'RATE_LIMIT',
      { status: status === 429 ? 429 : undefined, ...(after === undefined ? {} : { providerRetryAfterMs: after }) },
    )
  }

  if (status >= 500) {
    return new LlmError(
      `${PROVIDER_NAME} upstream server error (${status}): ${detail || 'No response'}`,
      'SERVER',
      { status },
    )
  }

  return new LlmError(
    `${PROVIDER_NAME} API error (${status}): ${detail || 'No response'}`,
    'PROVIDER_ERROR',
    { status },
  )
}

/** Read the platform's own numeric error code out of a response body. */
export function readErrorCode(detail: string): number | null {
  const matched = /"code"\s*:\s*(\d+)/.exec(detail)
  if (matched === null) return null
  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

export { PROVIDER_ID, PROVIDER_NAME }
