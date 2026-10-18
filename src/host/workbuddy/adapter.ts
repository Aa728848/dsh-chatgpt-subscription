import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
import { outputReservation } from '../common/output-reservation.ts'
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
import { getCachedQuotaFor, loadConfigCatalog, workBuddyHeaders, refreshCredentials } from './client.ts'
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
import { wrapStreamWithWatchdog, type StreamActivity } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'
import type { WorkBuddyCredentials } from './token-store.ts'
import type { WorkBuddyAccountPool } from './account-pool.ts'
import { resolveOutboundProduct } from './outbound-identity.ts'
import {
  evaluateGuardrails,
  guardrailsArmed,
  type WorkBuddyUsageLedger,
} from './guardrails.ts'

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
  /**
   * Per-account daily token counters behind the local guardrails.
   *
   * Absent means the guardrails cannot be evaluated, so a deployment without it
   * never refuses a request for a reason nothing is counting.
   */
  usageLedger?: WorkBuddyUsageLedger
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
      ...outputReservation(contextWindow || DEFAULT_CONTEXT_WINDOW, maxOutputTokensFor(modelId, catalog)),
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
      (watchdogSignal, activity) => this.requestStream(effectiveOptions, watchdogSignal, activity),
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
  /**
   * Accounts the LOCAL guardrails refuse for this model right now.
   *
   * Reads only numbers this plugin already owns — the billing snapshot's
   * remaining credits and this line's own token counters — so it never becomes a
   * second, disagreeing source of truth about the upstream allowance.
   */
  private async guardrailBlockedAccounts(
    settings: WorkBuddyModelSettings,
    model: string,
  ): Promise<ReadonlySet<string>> {
    const blocked = new Set<string>()
    const ledger = this.options.usageLedger
    const pool = this.accountPool
    if (pool === null) return blocked
    if (ledger === undefined || !guardrailsArmed(settings.guardrails)) return blocked
    for (const account of await pool.listAccounts()) {
      const verdict = evaluateGuardrails({
        guardrails: settings.guardrails,
        tokensToday: ledger.tokensToday(account.id),
        modelTokensToday: ledger.modelTokensToday(account.id, model),
        // Undefined when this account's billing snapshot was never read: an
        // unmeasured balance is not a low one.
        remainingCredits: getCachedQuotaFor(account.id)?.remainingCredits,
      })
      if (!verdict.allowed) blocked.add(account.id)
    }
    return blocked
  }

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

  private async *requestStream(
    options: GenerateOptions,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)
    const settings = await this.settings()
    const credentials = await this.credentials(settings)
    const catalog = credentials === null ? FALLBACK_MODELS : await this.catalog(credentials)
    const body = JSON.stringify(buildChatRequest({
      ...requestOptions,
      maxTokens: requestOptions.maxTokens ?? maxOutputTokensFor(options.model, catalog),
    }, images))

    const pool = this.accountPool
    const tried = new Set<string>()
    let response: Response | undefined
    // The account that ends up serving, kept outside the rotation block so the
    // usage recorded at the end of the stream is attributed to the right row.
    let servedAccountId: string | undefined
    // Guardrail-blocked accounts are excluded exactly like a tried one: the pool
    // skips them, and `hasAnotherAvailableAccount` sees them, so a pool whose
    // every account is blocked fails here rather than hammering the upstream.
    if (pool !== null) {
      for (const blockedId of await this.guardrailBlockedAccounts(settings, options.model)) tried.add(blockedId)
    }

    // Account rotation. With no pool this runs exactly once and keeps the
    // single-credential behaviour; with one, an account that is rate limited
    // or no longer authenticating steps out of this request while another
    // account serves the same body. The credential's own backend is used every
    // time, so one pool may hold accounts from both regions.
    //
    // Labelled because the renewal below is a second, inner loop that replays
    // the same body on the SAME account: rotating is `continue rotation`, while
    // replaying is a plain iteration of that inner loop.
    rotation: while (true) {
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
          effective = await pool.getEffectiveCredential(tried, fetchFn, options.model)
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
        servedAccountId = accountId
        tried.add(accountId)
        credentials = effective.credentials
      }

      // One forced renewal per account per request, in its own loop because the
      // replay must reuse the SAME picked account rather than ask the pool for
      // another one.
      //
      // A 401 here does not say the credential is dead, and this route must not
      // read it that way. The same bearer is accepted by `/v3/config` and
      // refused on this endpoint — measured on a real pool — so the refusal
      // describes one presentation of the credential (an access token another
      // holder rotated, a session the service ended early), not the end of the
      // sign-in. The local clock cannot see any of that: this line's access
      // tokens live about 28 days, so `needsRefresh` is essentially never true
      // when it happens. The one question answerable from here is whether the
      // token endpoint still honours the account, so a 401 buys one forced
      // renewal of that account and one replay of the identical body. The
      // check-in path has always done exactly this; the chat path used to skip
      // it and write the whole pool dead instead.
      //
      // `refusedDetail` is kept rather than discarded: the branch after this
      // loop classifies the very same text, and a Response body is a one-shot
      // stream — read twice, the second read comes back EMPTY, which the
      // classifier would read as a different verdict than the body stated.
      let renewed = false
      let refusedDetail = ''
      while (true) {
        try {
          response = await fetchWithContextBudgetRecovery(fetchFn)(`${credentials.backend}${CHAT_PATH}`, {
            method: 'POST',
            headers: workBuddyHeaders(
              credentials,
              { accept: 'text/event-stream' },
              {
                ...(requestOptions.sessionId === undefined ? {} : { sessionId: String(requestOptions.sessionId) }),
                // Stable per account: `auto` gives an account one client for its
                // whole life, which is the only shape a device fingerprint tolerates.
                product: resolveOutboundProduct(settings.outboundIdentity, accountId ?? credentials.uid ?? ''),
              },
            ),
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
        refusedDetail = (await response.text().catch(() => '')).slice(0, 600)
        // A pool, a named account and a first refusal: the only shape this line
        // can repair. A second 401 after a renewed token has nothing left to try.
        if (renewed || response.status !== 401 || pool === null || accountId === undefined) break

        renewed = true
        const refusedAccount = accountId
        try {
          credentials = await pool.renewCredential(refusedAccount, fetchFn, credentials)
        } catch (error) {
          // The token endpoint refused the account. THAT verdict is the
          // authoritative one, and the pool has already recorded it through
          // `refreshFailureStatus` — which is why nothing is written here.
          const verdict = error instanceof LlmError
            ? error
            : new LlmError(
                `${PROVIDER_NAME} credential could not be renewed after the service refused it: `
                + `${error instanceof Error ? error.message : String(error)}`,
                'INVALID_CREDENTIAL',
                { cause: error },
              )
          if (await pool.hasAnotherAvailableAccount(tried)) continue rotation
          throw verdict
        }
      }

      if (response.ok) break

      const failure = classifyFailure(response.status, refusedDetail, response.headers)

      if (pool !== null && accountId !== undefined) {
        // The classifier already resolved this: header first, then the reset
        // instant the body named. Reading the header alone would park a 24h
        // allowance for the five-minute default and retry into the same wall.
        const after = failure.failure.providerRetryAfterMs ?? retryAfterMs(response.headers)
        if (failure.code === 'RATE_LIMIT') {
          // Two different refusals arrive as 429. A SHORT one (a transient rate
          // limit, seconds) belongs to the account, exactly as before. A LONG
          // one — the 24h account × model window that `code 6004` names a reset
          // for — parks only that model, so the account keeps serving the rest of
          // its catalog instead of leaving the pool for a day.
          const longWindow = after !== undefined && after > POOL_COOLDOWN_MS
          if (longWindow) {
            if (accountId !== undefined) pool.markModelCooldown(accountId, options.model, after)
            if (await pool.hasAnotherAvailableAccountFor(tried, options.model)) continue
          } else {
            await pool.markCooldown(accountId, after ?? POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`)
              .catch(() => undefined)
            if (await pool.hasAnotherAvailableAccount(tried)) continue
          }
        } else if (failure.code === 'INVALID_CREDENTIAL') {
          // Nothing is written to the pool from here. A request-time 401 is a
          // statement about one presentation of a credential, and this pool has
          // no way back from `authStatus = 'expired'`: no caller ever clears
          // it, so one lane-wide 401 wrote EVERY account dead inside a single
          // request and the line then demanded a fresh sign-in for all of them,
          // permanently. The renewal above is what separates a stale token from a
          // dead sign-in, and a refused renewal is what writes the marker.
          // Rotating stays right — this account cannot serve THIS request — so
          // the next account gets the same body.
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
    // One request's billed tokens, taken from the single `usage` frame the
    // upstream sends (input excludes the cache counts, so they are added back).
    let recordedTokens = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // Bytes on the wire are the liveness signal: a heartbeat or status frame
        // that produces no displayable chunk still proves the connection is alive,
        // so the timer is reset at the transport layer, not at the parser.
        if (value !== undefined && value.byteLength > 0) activity?.pulse()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          // One pulse per complete frame; a pure comment frame (": ping",
          // ": keep-alive") is exactly what the display-layer timer misread as silence.
          activity?.pulse()
          for (const chunk of processStreamLine(line, state)) {
            if (chunk.type === 'usage') {
              recordedTokens = chunk.usage.inputTokens
                + chunk.usage.outputTokens
                + (chunk.usage.cacheReadTokens ?? 0)
                + (chunk.usage.cacheWriteTokens ?? 0)
            }
            yield chunk
          }
          if (state.finished) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim() !== '') {
        for (const line of buffer.split('\n')) {
          for (const chunk of processStreamLine(line, state)) {
            if (chunk.type === 'usage') {
              recordedTokens = chunk.usage.inputTokens
                + chunk.usage.outputTokens
                + (chunk.usage.cacheReadTokens ?? 0)
                + (chunk.usage.cacheWriteTokens ?? 0)
            }
            yield chunk
          }
        }
      }
      if (state.finished) return

      // A connection that ends without a terminal event is a truncated stream,
      // not a completed answer; the watchdog turns a stalled one into an abort.
      assertStreamComplete(state)
      for (const chunk of closeStream(state)) yield chunk
    } finally {
      if (servedAccountId !== undefined && recordedTokens > 0) {
        // Fire-and-forget: a counter that fails to persist must not fail a
        // request the user already paid for.
        void this.options.usageLedger?.record(servedAccountId, options.model, recordedTokens)
      }
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

  // A bare status is not a credential verdict on this route.
  //
  // Every 403 used to be filed as `INVALID_CREDENTIAL`, and the pool then wrote
  // `authStatus = 'expired'` onto EVERY account in turn — because the refusal
  // belongs to the lane, not to one account — after which no request could be
  // sent at all and the user was told to wait out a cooldown that never started.
  //
  // 403 does not mean "your token is bad". It is also what an intermediary
  // answers: a proxy, a lane policy, a WAF, another plugin in the same lane
  // refusing the call. Those bodies carry an application-layer shape rather than
  // an auth one, and telling them apart is exactly what the body is read for
  // here — a refusal the provider itself words as an authentication failure
  // still lands on `INVALID_CREDENTIAL` below.
  if (status === 401 || status === 403) {
    if (status === 403 && refusalIsNotCredential(detail)) {
      return new LlmError(
        `${PROVIDER_NAME} refused this request (403) before it reached the model: `
        + `the refusal did not name a rejected credential, so it most likely came from a proxy, `
        + `a gateway rule or another component on this lane rather than from the subscription. `
        + `The stored credential was left untouched.${detail ? ` ${detail}` : ''}`,
        // PROVIDER_ERROR, deliberately OUTSIDE this route's retry set: the same
        // request meets the same rule, so retrying only spends quota to hear it
        // again. It is also NOT a credential verdict, which is what keeps the
        // pool's accounts out of the `markAuthFailed` path.
        'PROVIDER_ERROR',
        { status },
      )
    }
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
    // A structured Retry-After is authoritative; otherwise the body's reset
    // wall clock is the only thing that says how long the account is out.
    const after = (headers ? retryAfterMs(headers) : undefined) ?? readRateLimitReset(detail)
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
    // The code is overloaded upstream and the message says which reading is
    // meant: "conversation id missing" is the gateway refusing the request's
    // channel verification, while the system-first wording is the history
    // check. Naming only the latter sends the reader down the wrong path.
    const channelRejected = /conversation id/i.test(detail)
    return new LlmError(
      channelRejected
        ? `${PROVIDER_NAME} blocked the request at its channel check (11128): the gateway did not `
          + 'accept it as an official client request. This is a plugin-side gap, not an account problem.'
        : `${PROVIDER_NAME} rejected the message history: the conversation must open with a system prompt.`
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
    isHttpContextOverflow(status, detail) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    { status },
  )
}

/**
 * Whether a 403 body carries POSITIVE evidence that the refusal was not a
 * credential verdict.
 *
 * The test is deliberately one-sided. A body this function cannot read — empty,
 * HTML from a gateway, malformed JSON, a JSON envelope with nothing decisive in
 * it — answers FALSE, which keeps the long-standing `INVALID_CREDENTIAL`
 * behaviour. Failing closed that way is right for a credential gate: unreadable
 * evidence must never be the reason a rejected token stays in rotation.
 *
 * What flips the verdict is the shape this route's own subscriptions do NOT
 * use. The service speaks NUMERIC codes (`readErrorCode`); an
 * application-layer refusal from a proxy or another plugin in the lane speaks a
 * STRING code, and says so in its own field names:
 *
 * - `{"error":{"code":"dsh_compaction_refused","type":"server_error","retryable":false}}`
 *   — measured in the field, from a middleware that owns compression on the lane.
 * - `retryable: false` is the strongest single signal available: no authentication
 *   failure bothers to state that retrying is pointless, because signing in again
 *   is exactly what would fix one.
 *
 * A numeric `code` anywhere, or no decisive field at all, keeps the credential
 * verdict.
 */
function refusalIsNotCredential(detail: string): boolean {
  const text = detail.trim()
  if (text === '' || !text.startsWith('{')) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false

  const envelope = parsed as Record<string, unknown>
  const inner = typeof envelope.error === 'object' && envelope.error !== null
    ? envelope.error as Record<string, unknown>
    : envelope

  // A numeric code is this subscription's own vocabulary, so its verdict stands.
  if (typeof inner.code === 'number' || typeof envelope.code === 'number') return false

  // A string code is a different layer speaking: the subscription never sends one.
  if (typeof inner.code === 'string' && inner.code !== '') return true

  // Otherwise require the explicit "do not retry" statement, paired with a
  // message, so a JSON object carrying neither a code nor a message (an empty
  // envelope) is not read as evidence of anything.
  const retryable = inner.retryable ?? envelope.retryable
  const hasMessage = typeof inner.message === 'string' || typeof envelope.message === 'string'
  if (retryable === false && hasMessage) return true

  const type = inner.type ?? envelope.type
  return typeof type === 'string' && type === 'server_error' && hasMessage
}

/** How far out a reset instant may be and still be treated as one. */
const MAX_RESET_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

const RESET_STAMP_RE = /(?:resets?\s+at|reset\s+at|将在)\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/
const RESET_TZ_RE = /UTC([+-])(\d{1,2})(?::?(\d{2}))?/

/**
 * The reset instant a quota refusal names, as a delay from now.
 *
 * A 24h allowance that is exhausted answers 429 / `code 6004` with the wall
 * clock it lifts — but only in the MESSAGE, never in a header, and in two
 * realm-specific wordings (measured: intl "… resets at 2026-09-20 10:50:48
 * UTC+8", cn "… 将在 2026-10-09 14:44:59 UTC+8 重置"). Reading the status alone
 * therefore loses the only fact that says how long the account is out, and the
 * pool parks a 24-hour limit for five minutes before trying it again.
 *
 * Deliberately tolerant, in the same direction as their gateway: an unparseable
 * body yields `undefined` (callers keep their default cooldown) rather than an
 * error, because this runs on a failure path. An absent `UTC±h` marker means
 * UTC, which is how the sibling implementation reads it too.
 */
export function readRateLimitReset(detail: string, now = Date.now()): number | undefined {
  const stamp = RESET_STAMP_RE.exec(detail)
  if (stamp === null) return undefined
  const [, date, clock] = stamp
  const parts = `${date} ${clock}`.split(/[- :]/).map((part) => Number(part))
  const [year, month, day, hour, minute, second] = parts
  if (parts.length !== 6 || parts.some((part) => !Number.isFinite(part))) return undefined

  const zone = RESET_TZ_RE.exec(detail)
  let offsetMs = 0
  if (zone !== null) {
    const hours = Number(zone[2] ?? '0')
    const minutes = Number(zone[3] ?? '0')
    const sign = zone[1] === '-' ? -1 : 1
    offsetMs = sign * (hours * 60 + minutes) * 60_000
  }

  // The stamp is a wall clock expressed at that offset, so the instant is the
  // UTC reading minus the offset.
  const at = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0) - offsetMs
  if (!Number.isFinite(at)) return undefined
  const delay = at - now
  // A past instant says the window already lifted; an absurdly distant one is
  // a parse artefact, not a 24h allowance. Either way the caller's default wins.
  if (delay <= 0 || delay > MAX_RESET_HORIZON_MS) return undefined
  return delay
}

/** Read the subscription's own numeric error code out of a response body. */
export function readErrorCode(detail: string): number | null {
  const matched = /"code"\s*:\s*(\d+)/.exec(detail)
  if (matched === null) return null
  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

export { PROVIDER_ID, PROVIDER_NAME }
