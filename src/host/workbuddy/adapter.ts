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
  CHAT_PATH,
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type WorkBuddyModelSettings,
  type WorkBuddyPreferenceStore,
} from './token-store.ts'
import {
  FALLBACK_MODELS,
  defaultContextWindowFor,
  maxOutputTokensFor,
  modelsForRegion,
  resolveWorkBuddyModel,
  workBuddyModelSupportsImage,
  workBuddyReasoningEfforts,
  type WorkBuddyModelEntry,
} from './model-catalog.ts'
import { loadConfigCatalog, workBuddyHeaders, refreshCredentials } from './client.ts'
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
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'
import type { WorkBuddyCredentials } from './token-store.ts'
import type { WorkBuddyAccountPool } from './account-pool.ts'

/**
 * Transient-failure retry policy for the `workbuddy` route.
 *
 * The subscription proxies to several upstream vendors, so a call can fail with
 * an upstream 5xx while the account stays perfectly usable. Those are
 * classified as `SERVER` and given bounded backoff. Deliberately outside the
 * set: `INVALID_CREDENTIAL` (a rejected token fails identically every attempt)
 * and `ABORTED` (the caller already cancelled).
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.workbuddy.retry')

/**
 * Effort this route materializes when the caller names none.
 *
 * Preference order: the user's configured level when the model accepts it,
 * otherwise the level the gateway's own catalog declares for that model (the
 * same default the official CLI applies), otherwise nothing — which leaves the
 * provider's own default in charge. A configured level the model does not
 * accept is ignored rather than sent, since the endpoint rejects an unsupported
 * level with `code 11150`.
 */
export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
  modelDefaultEffort?: string | null,
): ReasoningEffortId | undefined {
  if (configuredEffort && efforts.includes(configuredEffort)) {
    return ReasoningEffortId(configuredEffort)
  }
  if (modelDefaultEffort && efforts.includes(modelDefaultEffort)) {
    return ReasoningEffortId(modelDefaultEffort)
  }
  return undefined
}

/** Cooldown a 429 imposes when the service names no reset instant. */
export const POOL_COOLDOWN_MS = 5 * 60 * 1000

export interface WorkBuddyAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /** Live catalog loader seam; defaults to the gateway `/v3/config` call. */
  loadCatalog?: (credentials: WorkBuddyCredentials) => Promise<WorkBuddyModelEntry[]>
  /**
   * Multi-account pool this adapter rotates through.
   *
   * Absent leaves the line on its single-credential path, which is what the
   * headless tests and any caller that predates the pool use.
   */
  accountPool?: WorkBuddyAccountPool
}

export class WorkBuddyAdapter extends LlmAdapter {
  /** Null keeps the pre-pool single-credential path. */
  private readonly accountPool: WorkBuddyAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: WorkBuddyPreferenceStore,
    private readonly options: WorkBuddyAdapterOptions = {},
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

  private settings(): Promise<WorkBuddyModelSettings> {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  private async credentials(settings?: WorkBuddyModelSettings): Promise<WorkBuddyCredentials | null> {
    const current = settings ?? await this.settings()
    return this.store.read({
      accountId: current.selectedAccountId,
      hiddenAccountIds: current.hiddenAccountIds,
    })
  }

  /**
   * Catalog for the picker: the live gateway listing when reachable, the
   * shipped table otherwise.
   *
   * The gateway is the authority on capabilities, so its answer replaces the
   * fallback rather than merging with it — a model whose context window changed
   * upstream must not keep a stale local value.
   */
  private async catalog(credentials: WorkBuddyCredentials): Promise<readonly WorkBuddyModelEntry[]> {
    const load = this.options.loadCatalog
      ?? ((current: WorkBuddyCredentials) => loadConfigCatalog(current, { fetchFn: this.options.fetchFn }))
    const live = await load(credentials).catch(() => [])
    return live.length > 0 ? live : FALLBACK_MODELS
  }

  /**
   * Models the picker may offer.
   *
   * The catalog is filtered by the account's own region: asking a region for a
   * model it does not serve answers 400 `code 11102`, so offering one would
   * hand the user a model that cannot work.
   */
  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const credentials = await this.credentials(settings)
    if (credentials === null) return []

    const catalog = await this.catalog(credentials)
    const available = modelsForRegion(credentials.region, catalog)
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
        // No `description`: the other four routes advertise a name only, and a
        // description here made the shared composer model picker show a second
        // capability line for this route alone.
        inputModalities: model.supportsImage ? ['text', 'image'] as const : ['text'] as const,
      }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('WorkBuddy model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const credentials = await this.credentials(settings)
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const entry = resolveWorkBuddyModel(modelId, catalog)
    const efforts = workBuddyReasoningEfforts(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(
      efforts,
      settings.defaultReasoningEffort,
      entry.defaultReasoningEffort,
    )
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
      // prompt as the mandatory first message, never inside the history, so this
      // route cannot read a later system message as the effective prompt.
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
   * Order: the caller's explicit choice, then the user's configured level, then
   * the level the gateway catalog declares for this model. The last step
   * matters because the endpoint returns an **empty `reasoning_content`** when
   * no `reasoning_effort` is present, even for a reasoning-only model: measured
   * on `deepseek-v4.1-flash`, the same prompt yields 0 reasoning characters
   * with no field and 130-215 with one. Omitting it therefore silently drops
   * the model's thinking instead of letting the provider pick, so the catalog's
   * own default (which is what the official CLI sends) is materialized here.
   *
   * A candidate the model does not accept is discarded rather than sent, since
   * the endpoint rejects an unsupported level with `code 11150`.
   */
  private async effortFor(options: GenerateOptions): Promise<string | undefined> {
    const settings = await this.settings()
    const credentials = await this.credentials(settings)
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const efforts = workBuddyReasoningEfforts(options.model, catalog)
    if (efforts.length === 0) return undefined

    const candidates = [
      options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort),
      settings.defaultReasoningEffort ?? undefined,
      resolveWorkBuddyModel(options.model, catalog).defaultReasoningEffort ?? undefined,
    ]
    return candidates.find((candidate): candidate is string => candidate !== undefined && efforts.includes(candidate))
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const requestOptions = offloadOldestRequestImages(options)
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)
    const body = JSON.stringify(buildChatRequest(requestOptions, images))

    const pool = this.accountPool
    const tried = new Set<string>()
    let response: Response | undefined

    // Account rotation. With no pool this runs exactly once and keeps the
    // single-credential behaviour; with one, an account that is rate limited
    // or no longer authenticating steps out of this request while another
    // account serves the same body. The credential's own backend is used every
    // time, so one pool may hold accounts from both regions.
    while (true) {
      let credentials: WorkBuddyCredentials
      let accountId: string | undefined

      if (pool === null) {
        const settings = await this.settings()
        const stored = await this.credentials(settings)
        if (stored === null) {
          throw new LlmError(
            `Not signed in to ${PROVIDER_NAME}. Sign in with the CodeBuddy desktop client; `
            + 'this route reads its credential from the local auth directory.',
            'MISSING_CREDENTIAL',
          )
        }
        // The refresh token rotates, so an expired token is renewed through the
        // store's shared path rather than here; a concurrent call reuses the same
        // refresh instead of invalidating it.
        credentials = await this.store.ensureFresh(stored, (current) => refreshCredentials(current, { fetchFn }))
      } else {
        let effective: { account: { id: string }; credentials: WorkBuddyCredentials }
        try {
          effective = await pool.getEffectiveCredential(tried, fetchFn)
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

      try {
        response = await fetchFn(`${credentials.backend}${CHAT_PATH}`, {
          method: 'POST',
          headers: workBuddyHeaders(credentials, { accept: 'text/event-stream' }),
          body,
          // The idle watchdog owns the deadline: it resets while tokens flow, so a
          // long but active generation is not cut off by a wall-clock cap.
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw new LlmError('WorkBuddy request aborted', 'ABORTED', { cause: error })
        throw new LlmError(
          `WorkBuddy request failed: ${error instanceof Error ? error.message : String(error)}`,
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
          // A dead credential is that account's problem alone: keep the account
          // (signing in again restores it) and take it out of rotation.
          await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        }
      }

      throw failure
    }

    if (response === undefined) throw new LlmError('WorkBuddy produced no response', 'PROVIDER_ERROR')

    if (response.body === null) throw new LlmError('WorkBuddy returned an empty response body', 'PROVIDER_ERROR')

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
 * The subscription reports its own conditions inside a JSON `code` while the
 * status line stays generic, so the body is read for the specific cases the
 * status alone cannot express — notably the quota signal, whose message carries
 * the instant the allowance resets.
 */
export function classifyFailure(
  status: number,
  detail: string,
  headers?: Headers,
): LlmError {
  const code = readErrorCode(detail)

  if (status === 401 || status === 403) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the stored credential (${status}). `
      + `Sign in again with the CodeBuddy desktop client.${detail ? ` ${detail}` : ''}`,
      'INVALID_CREDENTIAL',
      { status },
    )
  }

  // Quota exhaustion and rate limiting both arrive as 429, and the body says
  // which; either way the account cannot serve this request right now, so the
  // failure is retryable under the bounded policy with the reset instant the
  // service reported.
  if (status === 429 || code === 6004 || code === 14003) {
    const after = headers ? retryAfterMs(headers) : undefined
    return new LlmError(
      `${PROVIDER_NAME} rate limit or plan quota reached. Check the quota card in Settings > WorkBuddy.`
      + `${detail ? ` ${detail}` : ''}`,
      'RATE_LIMIT',
      { status: status === 429 ? 429 : undefined, ...(after === undefined ? {} : { providerRetryAfterMs: after }) },
    )
  }

  // `code 11102` covers two measured conditions that share one code: the model
  // is not served in this account's region, or the account's plan is not
  // entitled to it. Retrying cannot help either way, and the fix is the same —
  // pick a different model — so both are reported together rather than guessed
  // apart.
  if (code === 11102) {
    return new LlmError(
      `${PROVIDER_NAME} does not serve this model for the signed-in account: it is either `
      + `unavailable in the account's region or not included in its plan. `
      + `Pick a different model in Settings > WorkBuddy.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // An unreadable or unsupported image is a request problem, not a transient
  // one; the caller must drop or replace the attachment.
  if (code === 11135 || code === 11133) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the request parameters (${code}). `
      + `An image may be unsupported by this model or unreadable.${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  if (code === 11128) {
    return new LlmError(
      `${PROVIDER_NAME} rejected the message history: the conversation must open with a system prompt.`
      + `${detail ? ` ${detail}` : ''}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  if (status >= 500 || code === 11134) {
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

/** Read the subscription's own numeric error code out of a response body. */
export function readErrorCode(detail: string): number | null {
  const matched = /"code"\s*:\s*(\d+)/.exec(detail)
  if (matched === null) return null
  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

export { PROVIDER_ID, PROVIDER_NAME }
