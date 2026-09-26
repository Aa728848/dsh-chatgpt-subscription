/**
 * DSH adapter for the `claude-subscription` route.
 *
 * This file is the only place the harness talks to. It owns: the model catalog
 * the picker sees, the per-model resolution DSH asks for before a call, the one
 * request loop, and the mapping of a failed response onto a DSH failure. It owns
 * NO credential lifecycle of its own — refreshing is oauth.ts's job, storage is
 * token-store.ts's job, the wire is client.ts's, the body and the SSE parse are
 * mapper.ts's — and it re-implements none of them.
 *
 * ---------------------------------------------------------------------------
 * 1. THE TWO LIMITS ON ACCOUNT ROTATION (the part that is easy to get wrong)
 * ---------------------------------------------------------------------------
 *
 * With a pool installed, one failed response may be retried on a DIFFERENT
 * account. Two rules bound that, and both are load-bearing:
 *
 * (a) WHAT may rotate. Only two conditions are attributable to one account:
 *     a credential verdict (that account's token is dead) and an
 *     ACCOUNT-SCOPED rate limit (that account's own usage window is spent).
 *     Everything else — a global rate limit, an `overloaded_error`, a generic
 *     5xx — is shared by every account behind the same gateway, so rotating
 *     against it burns the pool and can loop. client.ts's classifyFailure
 *     already draws exactly this line (its `accountScoped` field), so the
 *     decision reads that rather than re-deriving it from headers here.
 *
 * (b) HOW FAR. At most {@link MAX_ATTEMPTS} requests per stream, ever. The loop
 *     is additionally driven by the pool's `hasAnotherAvailableAccount`, but
 *     that is a pool property, not a bound: a pool that keeps answering "yes"
 *     would otherwise be retried forever.
 *
 * And one hard rule that outranks both: NO ROTATION ONCE ANYTHING HAS REACHED
 * THE CALLER. A retried request would repeat text the user has already read and
 * re-issue a tool call that may already have executed. Rotation happens only
 * before the response body is touched, which is where a fresh request is still
 * free; once the first chunk has been yielded, a failure is SURFACED instead of
 * retried. That rule is stated once in {@link shouldRotateAccount} so it cannot
 * be quietly lost by a later reordering of this file.
 *
 * ---------------------------------------------------------------------------
 * 2. ONE TOOL-NAME TABLE FOR BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * The body renames every offered tool to its canonical wire spelling
 * ('read' -> 'Read'), and the response side maps that spelling back to what the
 * caller declared. Two independent calls to yaml's translation builder would
 * produce two DIFFERENT tables — a collision that disables normalization on one
 * side only, or a set that changed between build and parse — and the visible
 * failure is a tool call dispatched to a tool the caller never offered. So the
 * table is built once, per request, and handed to BOTH the body builder and
 * `createStreamState`.
 *
 * ---------------------------------------------------------------------------
 * 3. THE PRE-EXISTING SINGLE-CREDENTIAL PATH, AND THE THIN STORE ADAPTER
 * ---------------------------------------------------------------------------
 *
 * Without a pool this route serves the account the credential document offers
 * first — or the one the user pinned in `selectedAccountId`, which the pool
 * mirrors as its primary. oauth.ts's `ensureAccessToken` was written against a
 * two-method `{ read, write }` store because it must not learn the document
 * layout, while FileCredentialStore is a multi-account document keyed by an
 * immutable `internalId`. {@link ClaudeAccountTokenStore} is that seam: it
 * presents exactly one account's credentials as the two methods, and records
 * WHICH record it handed out so a rotated refresh token is written back into
 * that record and not into whichever account happens to be first by the time
 * the refresh lands.
 *
 * ---------------------------------------------------------------------------
 * 4. FAILURE CLASSIFICATION
 * ---------------------------------------------------------------------------
 *
 * client.ts classifies; this file only decides which DSH code that verdict
 * becomes, and what the user is told:
 *
 * - `credential` -> INVALID_CREDENTIAL (sign in again);
 * - an account-scoped or global limit -> RATE_LIMIT;
 * - `overloaded` and `server` -> SERVER;
 * - `request` -> PROVIDER_ERROR;
 * - `network` -> TRANSPORT.
 *
 * A reported-client-version rejection is a REQUEST problem even though it
 * arrives as a 400 that mentions the client: it must NOT sign the user out, and
 * it has a real remedy (raise the reported version), so it is handled
 * explicitly with that remedy in the message. Where the catalog records a
 * model's floor, the same verdict is produced LOCALLY before the request is sent
 * ({@link assertClaudeCliVersionMeetsFloor}), so the ordinary case never spends
 * a request to be told the same thing less precisely; the upstream branch above
 * stays for a claim that is too low for a floor this table has not learned yet.
 *
 * ---------------------------------------------------------------------------
 * 5. ASSUMPTIONS AND JUDGEMENT CALLS
 * ---------------------------------------------------------------------------
 *
 * - A1. The pool seam is typed STRUCTURALLY here rather than against
 *   './account-pool.ts'. That file is written by a sibling chunk of this line;
 *   importing it before it exists would make this adapter uncompilable, and
 *   importing it afterwards changes nothing, because the only methods used are
 *   the five in {@link ClaudeAccountPoolLike}.
 * - A2. The live `GET /v1/models` listing is NOT read on the request path. It
 *   is authoritative for the context window alone (see client.ts), and the only
 *   model fact the body depends on — the thinking form — comes from the frozen
 *   catalog. Loading it per request would add a cached round trip that cannot
 *   change a byte of the body.
 * - A3. A 429 with no `retry-after` and no reset instant cools the account for
 *   {@link POOL_COOLDOWN_MS}. That is deliberately shorter than the 5-hour
 *   window: an account parked for hours after a burst limit recovers would cost
 *   the user the pool, while a too-short cooldown costs one rotation.
 * - A4. Adoption (adopt.ts) is not handled here. An adopted Claude Code
 *   credential is a pool concern — the pool is what must refuse to refresh it —
 *   and this adapter only ever sees the credential the pool or the document
 *   hands it.
 * - A5. The enabled-model rule is stated locally in
 *   {@link resolveEnabledModelIds} because './routes.ts' (the sibling chunk that
 *   owns the settings card for this line) does not exist yet. It mirrors the
 *   sibling providers' rule exactly; once routes.ts lands it is the natural home
 *   for this function and the two should be one.
 */

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
  API_BASE,
  DEFAULT_CONTEXT_WINDOW,
  ERROR_CODE_CLIENT_VERSION_TOO_OLD,
  MESSAGES_PATH,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  claudeCliVersion,
  meetsDottedVersionFloor,
} from './types.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type ClaudeAccountRecord,
  type ClaudeCredentials,
  type ClaudeModelSettings,
  type ClaudePreferenceStore,
} from './token-store.ts'
import {
  DEFAULT_VISIBLE_MODEL_IDS,
  FALLBACK_MODELS,
  claudeMinCliVersionFor,
  claudeModelSupportsImage,
  claudeReasoningEfforts,
  defaultContextWindowFor,
  maxOutputTokensFor,
  resolveClaudeModel,
  type ClaudeModelEntry,
} from './model-catalog.ts'
import {
  buildClaudeHeaders,
  classifyFailure,
  loadCatalog,
  networkFailure,
  type ClaudeFailure,
} from './client.ts'
import {
  assertStreamComplete,
  buildClaudeRequestBody,
  claudeRequestThinks,
  claudeToolNames,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processStreamLine,
  resolveRequestImages,
  type AttachmentImageReader,
  type ClaudeToolNames,
} from './mapper.ts'
import { ClaudeUnauthorizedError, ensureAccessToken, type ClaudeTokenStore } from './oauth.ts'
import { normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'

/**
 * Transient-failure retry policy for the `claude-subscription` route.
 *
 * The subscription is fronted by a shared gateway, so a call can fail with an
 * upstream 5xx or an `overloaded_error` (529) while the credential and the
 * account stay perfectly usable. Those are classified as SERVER/RATE_LIMIT and
 * given bounded backoff. Deliberately outside the set: INVALID_CREDENTIAL (a
 * rejected token fails identically on every attempt) and ABORTED (the caller
 * already cancelled).
 *
 * The values are the SAME ones every sibling provider line in this plugin
 * states, so this route never retries less than the rest of the plugin.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.claude.retry')

/**
 * Hard ceiling on requests one stream may issue while rotating accounts.
 *
 * Three, not "as many as the pool holds": the bound exists so a pool that keeps
 * reporting another available account cannot turn one turn into an unbounded
 * fan-out across every account the user owns.
 */
const MAX_ATTEMPTS = 3

/**
 * Cooldown a 429 imposes when the service names no reset instant.
 *
 * Deliberately far shorter than the 5-hour window it may be reporting: the
 * accurate wait arrives as `retry-after` or as the ISO instant in the error
 * message, and this is only the fallback for a response that states neither.
 */
export const POOL_COOLDOWN_MS = 15 * 60 * 1000

/**
 * Ceiling on any cooldown derived from a stated reset instant.
 *
 * A weekly window can legitimately name a reset days out, and parking one
 * account for days after a misread instant would look exactly like a broken
 * pool. Five hours — the shortest subscription window — is long enough to cover
 * the case this branch exists for and short enough that a wrong reading costs a
 * rotation rather than an account.
 */
const MAX_COOLDOWN_MS = 5 * 60 * 60 * 1000

/** What the user is told when this line has no credential to call with. */
const MISSING_CREDENTIAL_MESSAGE = 'Not signed in to ' + PROVIDER_NAME + '. Sign in from Settings > Claude.'

/**
 * Refuse one model locally, before the request is sent, when the version this
 * route reports is below the floor that model declares.
 *
 * WHY THIS EXISTS. Upstream validates the reported client version — the
 * `user-agent` built by client.ts's `claudeUserAgent` — against a per-model
 * minimum and answers a claim below it with an HTTP 400 whose code is
 * `claude_code_version_too_old`. That refusal is correct but nearly unusable as
 * a diagnosis: the version in its text is OUR OWN claim echoed back, the model
 * is only identifiable from the request that was just consumed, and the number
 * the user has to reach is buried in prose. The predictable consequence was the
 * reported bug — a user reading "your client is too old" about a model this
 * package advertises, whose remedy the text never names, and whose wording reads
 * like a credential problem often enough that people sign in again for nothing.
 *
 * The catalog now records the floor per model (`minCliVersion`), so the same
 * verdict can be produced HERE, at zero cost, naming the model, the version in
 * force, the version required, and the remedy. The upstream refusal is left in
 * place exactly as it was — this is an addition to the path, not a replacement,
 * because a claim that clears every floor this table knows can still be too low
 * for something the table has not learned yet, and `toLlmError` still handles
 * that case with the same remedy.
 *
 * WHAT IT MUST NOT DO. It must not disable a model for anyone who never picks it:
 * the check runs on the REQUEST path, against the model actually being called, so
 * a floor for one row cannot remove another row from the picker. It must not be a
 * credential error either — nothing is wrong with the stored sign-in, and the
 * message says so outright, because signing in again is the wrong move and the
 * upstream text invites it.
 *
 * Called with the model the request is about to name, and with the catalog that
 * request resolved against, so a floor added for a live-only id is honoured too.
 */
export function assertClaudeCliVersionMeetsFloor(
  modelId: string,
  catalog: readonly ClaudeModelEntry[] = FALLBACK_MODELS,
): void {
  const floor = claudeMinCliVersionFor(modelId, catalog)
  // "No known floor" is not "no floor": an absent value is the table declining to
  // assert a restriction, so it lets the request through unchanged.
  if (floor === undefined) return
  const effective = claudeCliVersion()
  if (meetsDottedVersionFloor(effective, floor)) return

  throw new LlmError(
    PROVIDER_NAME + ' will not serve ' + modelId + ' to a client reporting version '
    + effective + ': upstream requires ' + floor + ' or newer for this model, and a lower '
    + 'claim is refused with ' + ERROR_CODE_CLIENT_VERSION_TOO_OLD + '. This was caught locally, '
    + 'before the request was sent. Raise the reported version with the DSH_CLAUDE_CLI_VERSION '
    + 'environment variable, or with a setClaudeCliVersion pin, then retry. The stored sign-in '
    + 'is still valid — this is not a credential problem and signing in again will not change it.',
    'PROVIDER_ERROR',
  )
}

/**
 * The pool surface this adapter uses, stated structurally.
 *
 * See module note A1: './account-pool.ts' is a sibling chunk's file, and typing
 * against the five methods actually called keeps this adapter compilable
 * whether or not that file has landed.
 */
export interface ClaudeAccountPoolLike {
  getEffectiveAccount(
    excludeIds?: ReadonlySet<string>,
    fetchFn?: typeof fetch,
  ): Promise<{ account: { id: string }; credentials: ClaudeCredentials }>
  hasAnotherAvailableAccount(triedAccountIds: ReadonlySet<string>): Promise<boolean>
  markCooldown(accountId: string, durationMs: number, reason: string): Promise<void>
  markAuthFailed(accountId: string, reason: string): Promise<void>
}

export interface ClaudeAdapterOptions {
  fetchFn?: typeof fetch
  /** Attachment seam: durable images become inline bytes for one request. */
  attachments?: AttachmentImageReader
  /** Live catalog loader seam; defaults to this account's managed listing. */
  loadCatalog?: (credentials: ClaudeCredentials) => Promise<readonly ClaudeModelEntry[]>
  /**
   * Multi-account pool this adapter rotates through.
   *
   * Absent leaves the line on its single-credential path, which is what a
   * headless test and any caller that predates the pool use.
   */
  accountPool?: ClaudeAccountPoolLike
}

/**
 * The immutable id of the account a token came from, presented as the two-method
 * store oauth.ts wants. See module note 3.
 */
class ClaudeAccountTokenStore implements ClaudeTokenStore {
  constructor(
    private readonly store: FileCredentialStore,
    /** Captured when this store is created, never re-derived on write. */
    private readonly internalId: string,
  ) {}

  async read(): Promise<ClaudeCredentials | null> {
    const accounts = await this.store.listAccounts()
    return accounts.find((account) => account.internalId === this.internalId)?.credentials ?? null
  }

  async write(credentials: ClaudeCredentials): Promise<void> {
    // Addressing the record by its immutable id is the whole point: the identity
    // aliases of a rotated token are unchanged, but a document holding several
    // accounts must not have this write land on whichever one happens to be
    // first by the time the refresh returns.
    await this.store.saveAccount(credentials, { internalId: this.internalId })
  }
}

export class ClaudeAdapter extends LlmAdapter {
  /** Null keeps the pre-pool single-credential path. */
  private readonly accountPool: ClaudeAccountPoolLike | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: ClaudePreferenceStore,
    private readonly options: ClaudeAdapterOptions = {},
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

  /**
   * This route prices no visual tokens.
   *
   * The subscription bills in subscription windows rather than per image, so
   * there is no per-image price to state and the harness's neutral estimate is
   * the honest answer. Stated explicitly, as every sibling line does, so the
   * absence is a decision rather than an unimplemented method.
   */
  imageRequestPricing(): undefined {
    return undefined
  }

  private settings(): Promise<ClaudeModelSettings> {
    return this.preferences ? Promise.resolve(this.preferences.status()) : this.modelSettings.read()
  }

  /**
   * The account record the single-credential path serves.
   *
   * The pinned account wins while it exists in the document — that is the
   * account the user chose on the card, and honouring it here keeps the
   * single-credential path agreeing with what the card shows. Otherwise the
   * document is in insertion order and the first record is the primary one,
   * which is also what the pool mirrors into this store.
   */
  private async primaryAccount(settings: ClaudeModelSettings): Promise<ClaudeAccountRecord | null> {
    const document = await this.store.read()
    if (document === null || document.accounts.length === 0) return null
    const pinned = settings.selectedAccountId
    if (pinned !== null) {
      const selected = document.accounts.find((account) => account.internalId === pinned)
      if (selected !== undefined) return selected
    }
    return document.accounts[0] ?? null
  }

  /**
   * Catalog for one credential: the account's live listing, or the shipped table.
   *
   * client.ts's loader never rejects and never returns empty — it answers with
   * the shipped table when the call fails, precisely so a failed listing cannot
   * become the hard "model must be in the catalog" gate. The guard here is for a
   * caller-supplied seam that does neither.
   */
  private async catalog(credentials: ClaudeCredentials): Promise<readonly ClaudeModelEntry[]> {
    const load = this.options.loadCatalog
      ?? ((current: ClaudeCredentials) => loadCatalog(current, { fetchFn: this.options.fetchFn }))
    const live = await load(credentials).catch(() => [])
    return live.length > 0 ? live : FALLBACK_MODELS
  }

  /**
   * The catalog a REQUEST should be validated against.
   *
   * The same two branches {@link resolveModel} takes, in the same order, because
   * the live listing is authoritative for which ids exist and a floor recorded
   * for a live-only id would otherwise be skipped. An absent credential is not an
   * error here: with no account there is nothing to list and the shipped table is
   * the only answer available, which is exactly what the preview path already
   * assumes. A credential that cannot be read degrades to the shipped table for
   * the same reason — the floor check must not be the thing that turns a listing
   * failure into a failed request.
   */
  private async catalogForRequest(): Promise<readonly ClaudeModelEntry[]> {
    const record = await this.primaryAccount(await this.settings()).catch(() => null)
    if (record === null) return FALLBACK_MODELS
    // `catalog` already absorbs a failed listing and answers with the shipped
    // table, so there is no second fallback to write here.
    return this.catalog(record.credentials)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const record = await this.primaryAccount(settings)
    // Before a sign-in no listing can be asked for, so the shipped table stands
    // in and the picker stays usable; the credential decides which entries apply
    // once there is one.
    const catalog = record === null ? FALLBACK_MODELS : await this.catalog(record.credentials)
    const enabled = new Set(resolveEnabledModelIds(
      settings.enabledModelIds,
      catalog.map((model) => model.id),
    ))

    return catalog
      .filter((model) => enabled.has(model.id))
      .map((model) => ({
        provider: prov,
        id: model.id,
        name: model.name,
        // No `description`: the sibling routes advertise a name only, and a
        // description here would make the shared picker show a second line for
        // this route alone.
        inputModalities: claudeModelSupportsImage(model.id, catalog)
          ? ['text', 'image'] as const
          : ['text'] as const,
      }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Claude model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const record = await this.primaryAccount(settings)
    const catalog = record === null ? FALLBACK_MODELS : await this.catalog(record.credentials)
    const entry = resolveClaudeModel(modelId, catalog)
    const efforts = claudeReasoningEfforts(modelId, catalog)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)
    const override = settings.contextWindowOverrides[modelId]
    const contextWindow = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : defaultContextWindowFor(modelId, catalog)

    return {
      provider,
      id: modelId,
      name: entry.name,
      inputModalities: entry.supportsImage ? ['text', 'image'] : ['text'],
      context: { contextWindow: contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: maxOutputTokensFor(modelId, catalog),
      // No `systemPromptUpdate: 'in-history'`: the system prompt travels in the
      // body's own `system` field and never as a message, so this route cannot
      // read a later system message as the effective prompt.
      //
      // The ladder is passed through VERBATIM. ReasoningEffortId is an
      // unconstrained brand and the catalog's values are the wire's own effort
      // strings — including 'xhigh' and 'max', which a convergence table would
      // silently collapse. Converting here would advertise a rung the model does
      // not take, and the mapper would then send the collapsed value.
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
    // The idle watchdog owns the deadline: it resets while tokens flow, so a long
    // but active generation is not cut off by a wall-clock cap, and a stalled one
    // becomes a TIMEOUT rather than a hang.
    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(options, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  /**
   * Read one credential for this attempt.
   *
   * Pooled and pre-pool are two different questions. With a pool this is a
   * ROUTING decision — which account should serve this request — answered
   * through cooldowns, auth status and the rotation strategy; the pool also owns
   * refreshing the credential it hands back. Without one there is exactly one
   * account, so the question is whether its token is still usable, and
   * ensureAccessToken answers it single-flightedly (the refresh token rotates,
   * so two callers must not each spend it).
   */
  private async resolveCredential(
    pool: ClaudeAccountPoolLike | null,
    /** Grows as accounts are tried; owned by the rotation loop, not by this call. */
    tried: Set<string>,
    fetchFn: typeof fetch,
    signal: AbortSignal,
  ): Promise<{ credentials: ClaudeCredentials; accountId: string | undefined }> {
    if (pool === null) {
      const record = await this.primaryAccount(await this.settings())
      if (record === null) throw new LlmError(MISSING_CREDENTIAL_MESSAGE, 'MISSING_CREDENTIAL')
      try {
        const credentials = await ensureAccessToken(
          // The store adapter writes a rotated refresh token back into the record
          // it came from, never into whichever account is first by then.
          new ClaudeAccountTokenStore(this.store, record.internalId),
          { fetchFn, signal },
        )
        return { credentials, accountId: undefined }
      } catch (error) {
        if (error instanceof ClaudeUnauthorizedError) {
          throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
        }
        throw new LlmError(
          'Claude credential could not be prepared: ' + (error instanceof Error ? error.message : String(error)),
          'MISSING_CREDENTIAL',
          { cause: error },
        )
      }
    }

    try {
      const effective = await pool.getEffectiveAccount(tried, fetchFn)
      tried.add(effective.account.id)
      return { credentials: effective.credentials, accountId: effective.account.id }
    } catch (error) {
      // The pool's own verdict (an exhausted rotation) is already typed; a plain
      // error means no account is signed in at all.
      if (error instanceof LlmError) throw error
      throw new LlmError(
        error instanceof Error ? error.message : MISSING_CREDENTIAL_MESSAGE,
        'MISSING_CREDENTIAL',
        { cause: error },
      )
    }
  }

  /**
   * One request attempt, after the credential for it has been chosen.
   *
   * A SEPARATE function from the rotation loop on purpose: importing
   * './account-pool.ts' would make this adapter uncompilable while that sibling
   * file is still being written (see the module note), so the rotation loop is
   * driven by {@link shouldRotateAccount}, which bypasses the pool ENTIRELY when
   * no credentials were resolved for it.
   */
  private async attemptRequest(
    credentials: ClaudeCredentials,
    requestOptions: NormalizedGenerateOptions,
    images: Awaited<ReturnType<typeof resolveRequestImages>>,
    toolNames: ClaudeToolNames,
    thinking: boolean,
    signal: AbortSignal,
    fetchFn: typeof fetch,
  ): Promise<Response> {
    const body = JSON.stringify(buildClaudeRequestBody(requestOptions, images, {
      // THE SAME table createStreamState is given — see the module note. Built
      // once by the caller and handed to both sides.
      toolNames,
    }))
    try {
      return await fetchFn(API_BASE + MESSAGES_PATH, {
        method: 'POST',
        // The REAL model, never a default: the haiku rule changes the beta set,
        // so a hardcoded id would send the wrong headers for every haiku call
        // and for every non-haiku one alike.
        headers: buildClaudeHeaders(credentials.accessToken, {
          model: requestOptions.model,
          thinking,
          method: 'POST',
        }),
        body,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new LlmError('Claude request aborted', 'ABORTED', { cause: error })
      throw toLlmError(networkFailure(error))
    }
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)
    // One table for both directions of this request — see module note 2.
    const toolNames = claudeToolNames(requestOptions.tools)
    // The version floor is checked here, BEFORE the credential is resolved and
    // before any request is built: no account rotation and no retry can change a
    // verdict about a client version, so spending a request to learn it would
    // only produce the opaque upstream 400 this replaces. See the function's own
    // doc comment for what it is careful NOT to do.
    assertClaudeCliVersionMeetsFloor(requestOptions.model, await this.catalogForRequest())
    const effort = requestOptions.reasoningEffort === undefined || requestOptions.reasoningEffort === null
      ? undefined
      : String(requestOptions.reasoningEffort)
    // Derived from the SAME catalog rule the body uses, so the beta set and the
    // body cannot disagree about whether this request thinks. It is not a
    // hardcoded true: a mid-convo model thinks whatever the caller asked for,
    // and a model with no thinking form never does.
    const thinking = claudeRequestThinks(requestOptions.model, effort)

    const pool = this.accountPool
    const tried = new Set<string>()
    let response: Response | undefined
    /**
     * Set the moment ANY chunk reaches the caller, and never cleared.
     *
     * Deliberately broader than "a content delta or a tool block": a retry would
     * duplicate a block-start the caller has already seen just as surely, so the
     * conservative reading is the one that cannot be wrong.
     *
     * The rotation decision below is always reached with this false — a
     * non-2xx response is answered before the body is touched, so a rotation is
     * only ever weighed pre-stream. It is still passed in explicitly so the rule
     * "never rotate after output" lives in {@link shouldRotateAccount} alone and
     * a later reordering of this method cannot silently drop it.
     */
    let outputStarted = false

    while (true) {
      const { credentials, accountId } = await this.resolveCredential(pool, tried, fetchFn, signal)
      response = await this.attemptRequest(credentials, requestOptions, images, toolNames, thinking, signal, fetchFn)
      // Every attempt so far has been a pre-body failure, so nothing has reached
      // the caller and a rotation is still free. Once this method starts
      // yielding, outputStarted flips and shouldRotateAccount refuses forever.

      if (response.ok) break

      const detail = (await response.text().catch(() => '')).slice(0, 2_000)
      const failure = classifyFailure(response.status, detail, response.headers)

      // The pool is consulted only through the same branch that already requires
      // an account id, so a caller-supplied pool object can never be reached on
      // the pre-pool path whose credential it never issued.
      if (shouldRotateAccount(failure, outputStarted)
        && accountId !== undefined
        && tried.size < MAX_ATTEMPTS
        && (await poolHasAnotherAccount(pool, tried))) {
        if (failure.kind === 'credential') {
          // A dead credential is that account's problem alone: keep the account
          // (signing in again restores it) and take it out of rotation.
          await pool?.markAuthFailed(accountId, failure.message).catch(() => undefined)
        } else {
          await pool?.markCooldown(accountId, cooldownMsFor(failure), PROVIDER_NAME + ' 429')
            .catch(() => undefined)
        }
        continue
      }

      throw toLlmError(failure)
    }

    if (response === undefined) throw new LlmError('Claude produced no response', 'PROVIDER_ERROR')
    if (response.body === null) throw new LlmError('Claude returned an empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // The SAME tool-name table the body was built with.
    const state = createStreamState(toolNames)
    let buffer = ''

    try {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            for (const chunk of processStreamLine(line, state)) {
              outputStarted = true
              yield chunk
            }
            if (state.finished) return
          }
        }

        buffer += decoder.decode()
        if (buffer.trim() !== '') {
          for (const line of buffer.split('\n')) {
            for (const chunk of processStreamLine(line, state)) {
              outputStarted = true
              yield chunk
            }
          }
        }
        if (state.finished) return

        // A connection that ends without a terminal event is a truncated stream,
        // not a completed answer; the watchdog turns a stalled one into an abort.
        assertStreamComplete(state)
        for (const chunk of closeStream(state)) {
          outputStarted = true
          yield chunk
        }
      } catch (error) {
        // A verdict the mapper already typed (a truncated stream, an in-band
        // error event) is passed through untouched.
        if (error instanceof LlmError) throw error
        if (signal.aborted) throw new LlmError('Claude request aborted', 'ABORTED', { cause: error })
        // A severed connection BEFORE anything reached the caller is a transport
        // failure and may be retried; after the first chunk it is reported as a
        // request problem instead, because a retry would repeat output the user
        // has already seen (see module note 1).
        throw new LlmError(
          'Claude stream failed: ' + (error instanceof Error ? error.message : String(error)),
          outputStarted ? 'PROVIDER_ERROR' : 'TRANSPORT',
          { cause: error },
        )
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}

/**
 * The selection the picker should show, given what the account can call.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models the catalog has since added; treating it as
 * "everything this account can call" keeps a first run from hiding models
 * behind an unedited default. Any explicit edit is honoured exactly. See module
 * note A5 for why this mirrors the sibling providers' own function rather than
 * importing it.
 */
function resolveEnabledModelIds(stored: readonly string[], available: readonly string[]): string[] {
  const shippedDefaults = new Set(DEFAULT_VISIBLE_MODEL_IDS)
  const isUntouchedDefault = stored.length > 0
    && stored.length === shippedDefaults.size
    && stored.every((id) => shippedDefaults.has(id))
  if (isUntouchedDefault) return [...available]
  const known = new Set(available)
  return stored.filter((id) => known.has(id))
}

/**
 * Effort to materialize as this route's default, or nothing.
 *
 * Membership, not convergence: the catalog's ladder IS the wire vocabulary, and
 * a configured level outside it is dropped rather than moved onto a neighbour.
 * Moving it would silently change how hard the model thinks, and the four
 * thinking forms each carry the effort differently, so there is no single
 * correct neighbour to pick. 'xhigh' and 'max' are real rungs on this route and
 * pass through untouched.
 */
export function resolveDefaultReasoningEffort(
  efforts: readonly string[],
  configuredEffort?: string | null,
): ReasoningEffortId | undefined {
  if (efforts.length === 0) return undefined
  if (configuredEffort === undefined || configuredEffort === null || configuredEffort === '') return undefined
  return efforts.includes(configuredEffort) ? ReasoningEffortId(configuredEffort) : undefined
}

/**
 * Whether one failed response may be retried on another account.
 *
 * Only two conditions qualify, and the reason is the same for both: they are
 * properties of ONE account. A credential verdict means that account's token is
 * finished; an ACCOUNT-SCOPED rate limit means that account's own window is
 * spent. A global rate limit, an overload and a generic 5xx are shared by every
 * account behind the same gateway — rotating against them burns the pool and can
 * loop, because the next account fails identically.
 *
 * The one absolute refusal is `outputStarted`: after the first chunk has
 * reached the caller, a retry would repeat text and re-issue a tool call, so the
 * failure is surfaced instead.
 */
export function shouldRotateAccount(failure: ClaudeFailure, outputStarted: boolean): boolean {
  if (outputStarted) return false
  if (failure.kind === 'credential') return true
  return failure.kind === 'rate_limit_account' && failure.accountScoped
}

/**
 * Whether the pool still holds an account this request has not tried.
 *
 * Kept as a free function so the rotation decision reads as one boolean rather
 * than as a chain of `pool !== null` guards, and so the pre-pool path cannot
 * reach a pool method it has no account for.
 */
async function poolHasAnotherAccount(
  pool: ClaudeAccountPoolLike | null,
  tried: ReadonlySet<string>,
): Promise<boolean> {
  if (pool === null) return false
  return pool.hasAnotherAvailableAccount(tried)
}

/** How long a rate-limited account stays out of rotation. */
export function cooldownMsFor(failure: ClaudeFailure, now: number = Date.now()): number {
  const retryAfter = failure.retryAfterMs
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, MAX_COOLDOWN_MS)
  }
  if (failure.resetsAt !== null) {
    const reset = Date.parse(failure.resetsAt)
    if (Number.isFinite(reset) && reset > now) return Math.min(reset - now, MAX_COOLDOWN_MS)
  }
  return POOL_COOLDOWN_MS
}

/** The DSH failure code one classified failure becomes. */
export function codeForFailure(failure: ClaudeFailure): string {
  if (failure.clientVersionTooOld) return 'PROVIDER_ERROR'
  if (failure.kind === 'credential') return 'INVALID_CREDENTIAL'
  if (failure.kind === 'rate_limit_account' || failure.kind === 'rate_limit_global') return 'RATE_LIMIT'
  if (failure.kind === 'overloaded' || failure.kind === 'server') return 'SERVER'
  if (failure.kind === 'network') return 'TRANSPORT'
  return 'PROVIDER_ERROR'
}

/**
 * Turn one classified failure into the DSH error the caller sees.
 *
 * The facts the harness needs ride along: the HTTP status, and the delay the
 * provider asked for, which is where the retry policy reads its backoff from.
 * An unreadable status (0 from a transport failure) is omitted rather than
 * passed on, because LlmError validates it as a real HTTP status.
 */
export function toLlmError(failure: ClaudeFailure): LlmError {
  const status = Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599
    ? failure.status
    : undefined
  const retryAfter = failure.retryAfterMs !== null && failure.retryAfterMs > 0
    ? failure.retryAfterMs
    : undefined
  const options = {
    ...(status === undefined ? {} : { status }),
    ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
  }
  const detail = failure.message === '' ? '' : ' ' + failure.message

  // A reported-version floor is a REQUEST problem, not a credential one, and it
  // is handled before anything else so it can never sign the user out. It is
  // also the one failure with a remedy the user can apply without a republish,
  // so the message names it.
  if (failure.clientVersionTooOld) {
    return new LlmError(
      PROVIDER_NAME + ' refused this request because the client version it was told is below the '
      + "server's floor (" + ERROR_CODE_CLIENT_VERSION_TOO_OLD + '). Raise it with the '
      + 'DSH_CLAUDE_CLI_VERSION environment variable (or a setClaudeCliVersion pin), then retry — '
      + 'the stored sign-in is still valid.' + detail,
      'PROVIDER_ERROR',
      options,
    )
  }

  switch (failure.kind) {
    case 'credential':
      return new LlmError(
        PROVIDER_NAME + ' rejected the stored credential. Sign in again from Settings > Claude.' + detail,
        'INVALID_CREDENTIAL',
        options,
      )
    case 'rate_limit_account':
    case 'rate_limit_global':
      return new LlmError(
        PROVIDER_NAME + ' rate limit reached'
        + (failure.accountScoped ? ' for this account' : '')
        + (failure.resetsAt === null ? '' : ', resets at ' + failure.resetsAt)
        + '. Check the quota card in Settings > Claude.' + detail,
        'RATE_LIMIT',
        options,
      )
    case 'overloaded':
      return new LlmError(PROVIDER_NAME + ' is temporarily overloaded.' + detail, 'SERVER', options)
    case 'server':
      return new LlmError(
        PROVIDER_NAME + ' upstream server error (' + failure.status + ').' + detail,
        'SERVER',
        options,
      )
    case 'request':
      return new LlmError(PROVIDER_NAME + ' rejected the request.' + detail, 'PROVIDER_ERROR', options)
    default:
      return new LlmError(
        PROVIDER_NAME + ' request failed before a response arrived.' + detail,
        'TRANSPORT',
        options,
      )
  }
}

export { PROVIDER_ID, PROVIDER_NAME }
