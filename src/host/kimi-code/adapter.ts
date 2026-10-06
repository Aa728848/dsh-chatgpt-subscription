import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
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
  type KimiCodeCredentials,
  type KimiCodePreferenceStore,
} from './token-store.ts'
import { kimiCodeModelDef } from './model-catalog.ts'
import { markSessionActive } from './cache-hint.ts'
import {
  buildModelOptions,
  clearCachedCatalog,
  dynamicToolsForEntry,
  inputModalitiesForEntry,
  maxInputTokensForEntry,
  loadProviderModels,
  parseTimestamp,
  modelRequestHeaders,
  defaultReasoningEffortForEntry,
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
  MAX_REQUEST_VIDEO_BYTES,
  offloadOldestRequestImages,
  offloadOldestRequestVideos,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  requestHasVideo,
  resolveRequestImages,
  resolveRequestVideos,
  type AttachmentImageReader,
  type AttachmentVideoReader,
  type KimiCodeInBandStreamError,
  type KimiCodeStreamState,
} from './mapper.ts'
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import {
  inBandAnthropicStatus,
  reclassifyInBandError,
  reclassifyInBandResponsesError,
} from '../common/stream-error.ts'
import { KimiCodeAccountPool } from './account-pool.ts'
import { ensureAccessToken, KimiCodeUnauthorizedError } from './oauth.ts'
import { retryAfterMs } from '../wire-auth.ts'
import type { KimiCodeRegion, KimiCodeWire } from '../../shared/kimi-code-contracts.ts'

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
 *   or a 403 quota limit. Retrying a quota that resets in hours against the
 *   SAME account only burns requests and delays the message the user needs to
 *   see, so none of it is retried; a 403 limit still rotates to another account
 *   when the pool holds one, which is a routing decision rather than a retry;
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
  /**
   * True when the refusal belongs to THIS account alone, so another pooled
   * account may still serve the same request.
   *
   * A spent usage window is the case that matters, and this service reports it
   * as a 403 — neither a bad credential nor retryable back-pressure, so nothing
   * in the code or the message says "rotate". Asking the same account again
   * cannot help; taking it out of rotation until its window resets lets the next
   * account answer, and each account in the pool carries its own quota.
   *
   * False for every verdict that belongs to the request or to the plan: an
   * entitlement refusal, a malformed body, ordinary overload. Rotating on one of
   * those would spend every account in the pool to learn the same answer from
   * each of them.
   */
  accountScoped: boolean
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
  if (isHttpContextOverflow(status, bodyText)) {
    return { code: CONTEXT_OVERFLOW_CODE, retryable: false, accountScoped: false, message: `${PROVIDER_NAME} context window exceeded: ${detail}` }
  }

  if (status === 402) {
    // "We're unable to verify your membership benefits at this time." The docs
    // describe it as usually temporary and recommend waiting and retrying.
    return {
      code: 'SERVER',
      retryable: true,
      accountScoped: false,
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
        // A plan refusal is the same plan on every account of the pool, and it
        // is fixed by an upgrade rather than by a different account.
        accountScoped: false,
        message: `${PROVIDER_NAME} refused this request for the current plan: ${detail || 'the requested model or context is not included'}. Switch to a model the plan includes, lower the context-window override, or upgrade the subscription.`,
      }
    }
    if (status === 403) {
      // Every 403 on this route is an account-level refusal, so the code is the
      // same either way; the matched-limit test only selects which sentence the
      // user reads. The previous form branched to one value and read as though
      // the two cases were meant to differ.
      // Every 403 here is an account-level refusal, so the sentence shown is the
      // only thing that varies; the code is the same either way.
      const limitReached = matchesAny(detail, ACCOUNT_LIMIT_PATTERNS)
      return {
        code: 'PROVIDER_ERROR',
        retryable: false,
        // A spent window is this account's own quota. The 403 carries neither a
        // dead credential nor a signal worth retrying against the same account,
        // which is exactly why rotation has to be told about it separately: the
        // pool's remaining accounts each carry a window of their own.
        accountScoped: true,
        message: `${PROVIDER_NAME} blocked the request on an account limit (403): ${detail || (limitReached ? 'the account limit was reached' : 'the account refused the request')}. The quota refreshes on its own schedule — check the Kimi Code card in Settings for the reset time.`,
      }
    }
    return {
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      accountScoped: false,
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
        // Balance, not back-pressure: this account's own, and it stays spent.
        accountScoped: true,
        message: `${PROVIDER_NAME} reports the account quota is exhausted: ${detail || 'no remaining quota'}. Top up or wait for the window to reset.`,
      }
    }
    return {
      code: 'RATE_LIMIT',
      retryable: true,
      // Ordinary back-pressure says nothing about this account in particular,
      // and the shared 429 cooldown below already rotates on it.
      accountScoped: false,
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
      accountScoped: false,
      message: `${PROVIDER_NAME} upstream server error (${status}): ${detail || 'the model provider is temporarily unavailable'}. Retrying with backoff.`,
    }
  }

  if (status === 400) {
    return {
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: false,
      message: `${PROVIDER_NAME} rejected the request (400): ${detail || 'the request was not accepted'}`,
    }
  }

  return {
    code: 'PROVIDER_ERROR',
    retryable: false,
    accountScoped: false,
    message: `${PROVIDER_NAME} API error (${status}): ${detail || 'No response'}`,
  }
}

/** Numeric reset the service may ship as a field rather than in prose. */
const RESET_FIELD_PATTERN = /"?reset[A-Za-z_]*"?\s*[:=]\s*"?(\d{9,16})"?/i

/** ISO instant quoted in prose, trusted only when it names its own zone. */
const RESET_INSTANT_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/

/** The window a billing-cycle refusal names; nothing shorter describes it. */
const BILLING_CYCLE_PATTERN = /usage limit for this billing cycle/i

/**
 * How long one account stays out of rotation after it reports a spent limit.
 *
 * The reset instant is read from the body whenever the service states one — as a
 * numeric field, or as an instant carrying its own zone — and the length of the
 * window the service names is used otherwise. The zone is required for that
 * instant because an unqualified one is ambiguous, and a cooldown computed from
 * the wrong zone is either hours too long or already over; where the body is
 * ambiguous the window length is the honest answer.
 *
 * Both ends of the range are load-bearing. A reset instant barely in the future
 * would otherwise read as no cooldown at all and put the account straight back
 * into rotation to be refused again; and a reset instant already in the past
 * (a stale cache, a clock skew) falls back to the window length above rather
 * than to no cooldown at all.
 */
export function accountLimitCooldownMs(bodyText: string, now: number = Date.now()): number {
  const field = bodyText.match(RESET_FIELD_PATTERN)
  const instant = bodyText.match(RESET_INSTANT_PATTERN)
  const resetsAt = field !== null
    ? parseTimestamp(Number(field[1]))
    : instant !== null
      ? Date.parse(instant[0].replace(' ', 'T'))
      : null
  if (resetsAt !== null && Number.isFinite(resetsAt) && resetsAt > now) {
    return Math.min(Math.max(resetsAt - now, POOL_COOLDOWN_MS), MAX_ACCOUNT_LIMIT_COOLDOWN_MS)
  }
  return BILLING_CYCLE_PATTERN.test(bodyText)
    ? BILLING_CYCLE_COOLDOWN_MS
    : ACCOUNT_LIMIT_COOLDOWN_MS
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

/** Cooldown one rate-limited account takes when the provider states no delay. */
const POOL_COOLDOWN_MS = 15 * 60_000

/**
 * Fallback cooldown for an account whose usage window is spent.
 *
 * The service states the reset time only sometimes, so the fallback is the
 * window's own length. The 15 minutes a 429 gets would put the account back
 * into rotation four times inside the very window that just refused it.
 */
const ACCOUNT_LIMIT_COOLDOWN_MS = 5 * 60 * 60_000

/**
 * A billing cycle is not a window: a 5-hour cooldown would spend a request every
 * five hours to learn an answer that changes at most once a month.
 */
const BILLING_CYCLE_COOLDOWN_MS = 30 * 24 * 60 * 60_000

/** Ceiling, so a malformed reset time cannot park an account for years. */
const MAX_ACCOUNT_LIMIT_COOLDOWN_MS = BILLING_CYCLE_COOLDOWN_MS

export class KimiCodeAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored credential.
   *
   * Only the plugin entry installs one, because it owns the pool's storage; an
   * adapter built without one must keep working off the one credential file and
   * must not create pool state of its own.
   */
  private readonly accountPool: KimiCodeAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: KimiCodePreferenceStore,
    private readonly options: KimiCodeAdapterOptions = {},
    accountPool?: KimiCodeAccountPool,
  ) {
    super()
    this.accountPool = accountPool ?? null
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
    const pool = this.accountPool
    const load = this.options.loadCatalog
      ?? (() => loadProviderModels({
        fetchFn: this.options.fetchFn,
        store: this.store,
        // With a pool the single-credential file is only a mirror of one pooled
        // account, and a refresh rotates the refresh token. Reading the mirror
        // here would spend the token the pool is about to present, so the pool
        // is asked instead.
        ...(pool === null
          ? {}
          : { credentialProvider: (_region: KimiCodeRegion) => pool.getFreshCredential(undefined, this.options.fetchFn ?? fetch).then((c) => c.accessToken) }),
      }))
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
    if (settings.enabled === false) return []
    const catalog = await this.catalog()
    const enabled = new Set(settings.enabledModelIds)
    const available = catalog.filter((model) => enabled.has(model.id))

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
    // Resolved through the shared helper rather than reading the entry directly,
    // so a declared default that the three-state thinking rule removed cannot
    // reach the caller as a level the model no longer accepts.
    const entryDefault = defaultReasoningEffortForEntry(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
      ?? (entryDefault === undefined ? undefined : resolveDefaultReasoningEffort(efforts, entryDefault))

    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: inputModalitiesForEntry(modelId, catalog),
      context: { contextWindow: this.contextWindowFor(modelId, entry, settings.contextWindowOverrides) },
      // Deliberately omit defaultMaxTokens: DSH materializes it into requests
      // and reserves it in compaction. Our window-sized cap is dynamic, not a
      // fixed reservation. requestStream computes it after measuring the prompt;
      // explicit caller caps still win there (including compaction summaries).
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

    const catalog = await this.catalog().catch(() => [])
    const wire: KimiCodeWire = wireForCatalogEntry(options.model, catalog)

    const entry = catalog.find((model) => model.id === options.model)

    // DSH delivers pasted images as durable references because this route
    // declares image input; both wires need bytes, so resolve them once up
    // front and reuse the result for the single request below. Video travels
    // the same path and is dropped oldest-first against its own, far larger
    // budget, because one clip dwarfs the whole image allowance.
    const requestOptions = offloadOldestRequestVideos(
      offloadOldestRequestImages(normalizeGenerateOptions(options)),
      MAX_REQUEST_VIDEO_BYTES,
    )
    const [images, videos] = await Promise.all([
      resolveRequestImages(requestOptions, this.options.attachments, signal),
      resolveRequestVideos(requestOptions, this.options.videos, signal),
    ])
    const settings = await this.settings()
    const media = {
      videos,
      videoAccepted: inputModalitiesForEntry(options.model, catalog).includes('video'),
      // Same resolver the settings card uses, so UI and wire cannot disagree.
      messageTools: dynamicToolsForEntry(options.model, catalog),
      // `null` (nothing stored) sends NO cache field, which is the request this
      // line made before the setting existed — Kimi's own default, byte for
      // byte. A stored tier adds the field for whichever wire is in use.
      cacheTtl: settings.cacheTtl,
    }

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
    // A service-declared input cap is what actually bounds the PROMPT, and the
    // window is what bounds the completion. Clamping only against the window
    // lets a prompt grow past the endpoint's input limit and come back as a
    // rejection rather than as the compaction that would have avoided it, so
    // the two are separated here and the smaller one guards the prompt.
    const inputCap = maxInputTokensForEntry(options.model, catalog)
    const promptLimit = inputCap === undefined ? contextWindow : Math.min(contextWindow, inputCap)
    const boundedOptions: NormalizedGenerateOptions = {
      ...requestOptions,
      maxTokens: clampOutputToContext(requestedMax, promptLimit, estimatedInputTokens(requestOptions)),
    }
    const built = buildRequest(boundedOptions, wire, images, undefined, media)
    // The guard returns the serialized body it measured, so the multi-megabyte
    // string is built once instead of twice.
    const body = assertRequestBodyFits(built, requestHasVideo(requestOptions))

    const pool = this.accountPool
    const tried = new Set<string>()
    // Hoisted out of the rotation loop so the account that actually served the
    // response is still in scope when the stream closes and files its usage, and
    // when a failure reported inside the stream takes that account out of
    // rotation below.
    let servedByAccountId: string | undefined
    let response: Response | undefined

    // Account rotation. Without a pool this runs exactly once and keeps the
    // original credential preparation and error mapping; with one, an account
    // that is rate limited, out of quota or no longer authenticating steps out
    // of the rotation while another account serves the same payload.
    while (true) {
      let apiCredentials: KimiCodeCredentials
      let accountId: string | undefined
      if (pool === null) {
        try {
          // A token near expiry is rotated here; a rejected refresh token
          // surfaces as an unauthorized error, which is not retried.
          apiCredentials = await ensureAccessToken(this.store, { fetchFn, signal })
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
      } else {
        let effective: { account: { id: string }; credentials: KimiCodeCredentials }
        try {
          effective = await pool.getEffectiveCredential(tried, fetchFn)
        } catch (error) {
          // The pool's own verdict (an exhausted rotation) is already typed; a
          // plain error means no account is signed in at all.
          if (error instanceof LlmError) throw error
          throw new LlmError(
            error instanceof Error ? error.message : 'Kimi Code credential could not be prepared.',
            'MISSING_CREDENTIAL',
            { cause: error },
          )
        }
        accountId = effective.account.id
        servedByAccountId = accountId
        tried.add(accountId)
        apiCredentials = effective.credentials
      }

      // Every attempt uses the credential's own region and hosts: one pool may
      // legitimately hold accounts issued in different regions.
      const region = apiCredentials.region ?? await resolveRegion()
      const base = (apiCredentials.baseUrl ?? codingBaseUrl(region)).replace(/\/+$/, '')
      const endpoint = wire === 'anthropic'
        ? `${base}/v1/messages?beta=true`
        : `${base}/v1/chat/completions`
      const headers = await modelRequestHeaders(apiCredentials.accessToken, wire)

      try {
        response = await fetchWithContextBudgetRecovery(fetchFn)(endpoint, { method: 'POST', headers, body, signal })
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

      if (response.ok) break

      const detail = (await response.text().catch(() => '')).slice(0, 2_000)
      const failure = classifyKimiFailure(response.status, detail)
      const after = response.status === 429 ? retryAfterMs(response.headers) : undefined

      if (pool !== null && accountId !== undefined) {
        // A plan-scoped 429 is a property of the request, not of the account:
        // rotating cannot help, and cooling every account after one such request
        // would take the whole pool offline.
        const planScoped = response.status === 429 && matchesAny(detail, ENTITLEMENT_PATTERNS)
        if (response.status === 429 && !planScoped) {
          // A spent balance is this account's own and stays spent, so it takes
          // the window's length rather than the retry-after of a back-pressure
          // signal that would have meant nothing here.
          const cooldownMs = failure.accountScoped
            ? accountLimitCooldownMs(detail)
            : after ?? POOL_COOLDOWN_MS
          await pool.markCooldown(accountId, cooldownMs, `${PROVIDER_NAME} 429`).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        } else if (failure.code === 'INVALID_CREDENTIAL') {
          // A dead refresh token is that account's problem alone: keep the
          // account (signing in again restores it) and take it out of rotation.
          await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        } else if (failure.accountScoped) {
          // A usage window this account has spent, which this service reports as
          // a 403. Neither of the branches above recognizes it — the credential
          // is fine and the request must not be retried against the same account
          // — so before this branch existed a pool of several accounts failed the
          // whole turn on whichever one happened to be first. Cooling this one
          // until its window resets is what lets the next account answer.
          await pool.markCooldown(accountId, accountLimitCooldownMs(detail), `${PROVIDER_NAME} 403`).catch(() => undefined)
          if (await pool.hasAnotherAvailableAccount(tried)) continue
        }
      }

      throw new LlmError(failure.message, failure.code, {
        status: response.status,
        ...(after === undefined ? {} : { providerRetryAfterMs: after }),
      })
    }

    if (response.body === null) throw new LlmError('Kimi Code returned an empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // The session travels with the turn so usage is filed under the right
    // conversation when the stream closes; the account is passed separately
    // below, once rotation has settled on one.
    const state = createStreamState(wire, requestOptions.sessionId)
    // Recorded after the turn is built and sent, so the timestamp answers when
    // this conversation last ran — the input the cache-expiry hint needs.
    markSessionActive(requestOptions.sessionId)
    let buffer = ''
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "text arrived": a block-start the caller has
     * already seen repeats just as badly as text it has already read, so the
     * conservative reading is the one that cannot be wrong. It is what keeps the
     * in-band reclassification below pre-output only.
     */
    let outputStarted = false

    try {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            for (const chunk of processLine(line, state, wire)) {
              outputStarted = true
              yield chunk
            }
            if (state.finished) return
          }
        }

        buffer += decoder.decode()
        if (buffer.trim() !== '') {
          for (const line of buffer.split('\n')) {
            for (const chunk of processLine(line, state, wire)) {
              outputStarted = true
              yield chunk
            }
          }
        }
        if (state.finished) return

        // A connection that ends without a terminal event is a truncated stream,
        // not a completed answer; the watchdog turns a stalled one into an abort.
        assertStreamComplete(state)
        for (const chunk of closeStream(state, servedByAccountId)) {
          outputStarted = true
          yield chunk
        }
      } catch (error) {
        // A verdict the mapper already typed (a truncated stream, an in-band
        // error event) is passed through — except an in-band error event that
        // arrived before anything reached the caller, which is classified the
        // way this line classifies the response body it is equivalent to: an
        // Anthropic type through {@link classifyKimiFailure} at the status that
        // type stands for, an OpenAI one through the Responses vocabulary the
        // sibling lines read. Either way every rule the HTTP path owns still
        // owns the verdict, so the same overload, the same spent window and the
        // same plan refusal reach the retry policy as they would have as a
        // status. A context overflow is excluded from that, because its code is
        // how the turn is compacted and recovered rather than retried. After the
        // first chunk the mapper's verdict stands: a retry would repeat output
        // the user has already seen.
        const inBand = state.streamError
        if (error instanceof LlmError && !outputStarted && error.code === 'PROVIDER_ERROR'
          && inBand !== undefined) {
          throw await this.inBandStreamFailure(error, inBand, servedByAccountId)
        }
        throw error
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }

  /**
   * What one in-band failure becomes once the pool has been told what the
   * verdict means for it.
   *
   * Reclassification and the pool reaction are separate because they answer
   * different questions about the same classification: the code decides whether
   * the harness retries, `accountScoped` decides whether a retry could land
   * somewhere that can answer. The mapper can supply only the first, which is
   * why the wire object is recorded there and read here.
   *
   * The body is the one a non-2xx response would have carried, so every pattern
   * below reads exactly what the HTTP branch reads and a limit cannot mean one
   * thing as a status and another as an event. The request itself is NOT
   * re-issued: its body is already open and part-read, and the harness retry
   * policy owns the repeat.
   */
  private async inBandStreamFailure(
    thrown: LlmError,
    inBand: KimiCodeInBandStreamError,
    accountId: string | undefined,
  ): Promise<LlmError> {
    const bodyText = JSON.stringify({ error: inBand.error })
    const reclassified = inBand.vocabulary === 'anthropic'
      ? reclassifyInBandError(thrown, inBand.error, classifyKimiFailure)
      : reclassifyInBandResponsesError(thrown, inBand.error, inBand.message, classifyKimiFailure)
    const pool = this.accountPool
    if (pool === null || accountId === undefined) return reclassified

    if (inBand.vocabulary === 'anthropic') {
      const status = inBandAnthropicStatus(inBand.error)
      // A type this vocabulary does not name classifies to nothing, so there is
      // no verdict to weigh against the pool and the mapper's own stands.
      if (status === null) return reclassified
      const failure = classifyKimiFailure(status, bodyText)
      // The same chain the non-2xx branch runs, in the same order: a
      // plan-scoped 429 is a property of the request, so it cools nothing and
      // rotating on it would spend the whole pool to learn the same refusal.
      // Kept whole rather than narrowed to the statuses named today, so a type
      // the table later adds lands in the arm that already owns it.
      const planScoped = status === 429 && matchesAny(bodyText, ENTITLEMENT_PATTERNS)
      if (status === 429 && !planScoped) {
        await this.coolInBandRateLimit(pool, accountId, failure.accountScoped, bodyText)
      } else if (failure.code === 'INVALID_CREDENTIAL') {
        // A credential the stream itself calls dead is that account's problem
        // alone, and signing in again restores it — so mark it, never delete.
        await pool.markAuthFailed(accountId, failure.message).catch(() => undefined)
      } else if (failure.accountScoped) {
        // A window this account has spent: the retry is about to repeat the
        // request, and repeating it against the same spent window fails
        // identically three times over.
        await pool.markCooldown(accountId, accountLimitCooldownMs(bodyText), `${PROVIDER_NAME} in-stream 403`).catch(() => undefined)
      }
      return reclassified
    }

    // This vocabulary names no status at all, so nothing is synthesized to
    // classify against and no arm is invented: the code the vocabulary derived
    // selects it. RATE_LIMIT is the 429 rule below, and SERVER is the 5xx rule,
    // which the HTTP path leaves the pool alone for — an overload is not one
    // account's property to carry.
    if (reclassified.code === 'RATE_LIMIT' && !matchesAny(bodyText, ENTITLEMENT_PATTERNS)) {
      // The same 429 rule, with the scope read off that arm's own classification
      // — which is where the HTTP branch reads `accountScoped` from too, so a
      // spent balance leaves rotation here exactly as it does there.
      await this.coolInBandRateLimit(pool, accountId, classifyKimiFailure(429, bodyText).accountScoped, bodyText)
    }
    return reclassified
  }

  /**
   * Cool the account whose own rate limit the stream reported.
   *
   * The window this route already defaults to, never a Retry-After: there is no
   * 429 response to read one from, and a delay stated on the 200 belongs to a
   * different message. An account-scoped verdict takes its own window instead,
   * because a spent balance is not back-pressure and 15 minutes would put the
   * account back into rotation four times inside the window that refused it.
   */
  private async coolInBandRateLimit(
    pool: KimiCodeAccountPool,
    accountId: string,
    accountScoped: boolean,
    bodyText: string,
  ): Promise<void> {
    const cooldownMs = accountScoped ? accountLimitCooldownMs(bodyText) : POOL_COOLDOWN_MS
    await pool.markCooldown(accountId, cooldownMs, `${PROVIDER_NAME} in-stream 429`).catch(() => undefined)
  }
}

function processLine(line: string, state: KimiCodeStreamState, wire: KimiCodeWire): StreamChunk[] {
  return wire === 'anthropic'
    ? processAnthropicStreamLine(line, state)
    : processOpenAIStreamLine(line, state)
}

export { clearCachedCatalog, buildModelOptions, reasoningEffortsFor, PROVIDER_ID }
