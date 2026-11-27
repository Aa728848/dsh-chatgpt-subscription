/**
 * DSH adapter for the `claude-subscription` route.
 */

import { fetchWithContextBudgetRecovery } from '../../common/context-budget-fetch.ts'
import { localizedProviderName } from '../../common/i18n/index.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../../common/context-overflow.ts'
import { outputReservation } from '../../common/output-reservation.ts'
import { sharedPrefixGroupKey, withStaticPrefixOrdering } from '../../common/prefix-stability.ts'
import { promptCachePolicyOf, type PromptCacheOverride } from '../../common/prompt-cache-policy.ts'
import { fetchWithPrefixCoordination, PrefixRequestCoordinator } from '../../common/prefix-request-coordinator.ts'
import {
  LlmAdapter,
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
import { randomUUID } from 'node:crypto'
import {
  API_BASE,
  CLAUDE_SUBAGENT_CACHE_TTL,
  CLAUDE_SUBSCRIPTION_CACHE_TTL,
  DEFAULT_CONTEXT_WINDOW,
  ERROR_CODE_CLIENT_VERSION_TOO_OLD,
  ANTHROPIC_VERSION,
  MESSAGES_PATH,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_FIRST_OUTPUT_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  claudeCliVersion,
  meetsDottedVersionFloor,
  type ClaudeCacheTtl,
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
  claudeSupportsMidConversationSystemMessages,
  defaultContextWindowFor,
  maxOutputTokensFor,
  resolveClaudeModel,
  type ClaudeModelEntry,
} from './model-catalog.ts'
import {
  buildClaudeHeaders,
  claudeUserAgent,
  classifyFailure,
  loadCatalog,
  networkFailure,
  type ClaudeFailure,
} from './client.ts'
import {
  assertStreamComplete,
  buildClaudeRequestBody,
  MAX_REQUEST_IMAGE_BYTES,
  MAX_SINGLE_REQUEST_IMAGE_BYTES,
  claudeBodyHasToolChanges,
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
import { LlmError, normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../../common/llm-compat.ts'
import { wrapStreamWithWatchdog, type StreamActivity } from '../../common/idle-watchdog.ts'
import {
  offloadRequestImagesWithStickyBudget,
  type ResolvedRequestImages,
} from '../../common/request-images.ts'
import { StickyImageBudgetStore } from '../../common/sticky-image-budget.ts'
import { promptCacheActivityStore } from '../../common/cache-activity.ts'
import { ClaudeCodeVersionResolver, type ClaudeCodeVersionSelection } from '../_claude-shared/claude-code-version.ts'
import {
  ClaudeCodeFirstPartyTracker,
  claudeCodeSessionUuid,
  type ClaudeCodeFirstPartyContext,
} from '../_claude-shared/claude-code-first-party.ts'
import { signClaudeCodeRequest } from '../_claude-shared/claude-code-cch.ts'
import { ClaudeCapabilityMemory, claudeCapabilityMemoryPath } from '../_claude-shared/claude-capability-memory.ts'
import {
  isClaudeSpeedNeedsBeta,
  isClaudeSpeedUnsupported,
  isClaudeSystemRoleUnsupported,
  isClaudeThinkingTokenCountUnsupported,
} from '../_claude-shared/claude-code-corrections.ts'

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
 */
export function assertClaudeCliVersionMeetsFloor(
  modelId: string,
  catalog: readonly ClaudeModelEntry[] = FALLBACK_MODELS,
  reportedVersion = claudeCliVersion(),
): void {
  const floor = claudeMinCliVersionFor(modelId, catalog)
  // "No known floor" is not "no floor": an absent value is the table declining to
  // assert a restriction, so it lets the request through unchanged.
  if (floor === undefined) return
  const effective = reportedVersion
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
  getFreshCredential?(accountId?: string, fetchFn?: typeof fetch): Promise<ClaudeCredentials>
  markCooldown(accountId: string, durationMs: number, reason: string): Promise<void>
  markAuthFailed(accountId: string, reason: string): Promise<void>
}

/** The model's saved max_tokens, capped at its limit; undefined when none is saved. */
function savedMaxTokensFor(settings: ClaudeModelSettings | null, modelId: string, limit: number): number | undefined {
  const saved = settings?.maxTokensOverrides?.[modelId]
  return typeof saved === 'number' && Number.isFinite(saved) && saved > 0 ? Math.min(Math.floor(saved), limit) : undefined
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
  /** Optional deployment override for cache-prefix behaviour. */
  promptCache?: PromptCacheOverride
  /** Shared with claude-api in production; isolated defaults keep unit tests independent. */
  version?: ClaudeCodeVersionResolver
  capabilityMemory?: ClaudeCapabilityMemory
  /**
   * Whether a session belongs to a delegated agent. Its requests, like every
   * request that names a purpose, are outside the main conversation and use
   * that cache tier. Absent treats every session as a main conversation.
   */
  isDelegatedSession?: (sessionId: string) => boolean
}

const claudePrefixRequests = new PrefixRequestCoordinator()
// Drop records depend on the budget. Images evicted under the old 1.5 MB
// limit must be reconsidered after upgrade, including in existing sessions.
const claudeStickyImages = new StickyImageBudgetStore(`claude-${MAX_REQUEST_IMAGE_BYTES}-${MAX_SINGLE_REQUEST_IMAGE_BYTES}`)
/** Wait-time keepalive evidence; only this line's MAIN turns write it. */
const claudeCacheActivity = promptCacheActivityStore(PROVIDER_ID)

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

/**
 * Whether this model may state a tool change in the history.
 *
 * Gated on the same capability that licenses a mid-conversation system message,
 * because that message is what carries the change: a model that folds those
 * messages back into the top-level `system` field cannot take a tool change
 * without moving the head, which is the cost the capability exists to avoid.
 *
 * `DSH_CLAUDE_TOOL_UPDATE=0` turns it off for one account without a code change,
 * mirroring the escape hatch kimi-code and the codex line carry.
 *
 * @param modelId - exact model id.
 * @returns the mode to declare, or undefined when every request must restate the
 * complete tool list.
 */
export function toolUpdateMode(modelId: string): 'in-history' | undefined {
  if (!claudeSupportsMidConversationSystemMessages(modelId)) return undefined
  const raw = (process.env.DSH_CLAUDE_TOOL_UPDATE ?? '').trim().toLowerCase()
  if (raw !== '' && ['0', 'false', 'no', 'off', 'none'].includes(raw)) return undefined
  return 'in-history'
}

interface ClaudeProtocolCorrections {
  fastMode?: 'unsupported' | 'beta'
  systemRoleUnsupported?: boolean
  thinkingTokenCountUnsupported?: boolean
}

interface ClaudeCacheTouchRecord {
  requestId: string
  accountId?: string
}

export class ClaudeAdapter extends LlmAdapter {
  /** Null keeps the pre-pool single-credential path. */
  private readonly accountPool: ClaudeAccountPoolLike | null
  private readonly version: ClaudeCodeVersionResolver
  private readonly capabilityMemory: ClaudeCapabilityMemory
  private readonly firstParty = new ClaudeCodeFirstPartyTracker()
  private readonly sessionEfforts = new Map<string, string | null>()
  private readonly cacheTouchRecords = new Map<string, ClaudeCacheTouchRecord>()
  private readonly cacheTouchFlights = new Map<string, Promise<boolean>>()

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: ClaudePreferenceStore,
    private readonly options: ClaudeAdapterOptions = {},
  ) {
    super()
    this.accountPool = options.accountPool ?? null
    this.version = options.version ?? new ClaudeCodeVersionResolver()
    this.capabilityMemory = options.capabilityMemory ?? new ClaudeCapabilityMemory(claudeCapabilityMemoryPath('claude'))
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: localizedProviderName(provider, PROVIDER_NAME) }
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
      ...outputReservation(contextWindow || DEFAULT_CONTEXT_WINDOW, savedMaxTokensFor(settings, modelId, maxOutputTokensFor(modelId, catalog)) ?? maxOutputTokensFor(modelId, catalog)),
      // `toolUpdate: 'in-history'` for models that accept a mid-conversation
      // system message: a tool change then rides a `tool_addition` /
      // `tool_removal` block in that message, the declaration list at the head
      // never changes, and a withdrawn tool keeps its declaration so the cached
      // prefix survives. `DSH_CLAUDE_TOOL_UPDATE=0` turns it off per account.
      ...(toolUpdateMode(modelId) === undefined ? {} : { toolUpdate: toolUpdateMode(modelId) }),
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
      (watchdogSignal, activity) => this.requestStream(options, watchdogSignal, activity),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      'Claude',
      STREAM_FIRST_OUTPUT_TIMEOUT_MS,
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
  /**
   * The prompt-cache tier this line requests.
   *
   * A stored value wins; nothing stored falls back to the tier the OFFICIAL
   * client uses for a subscription's main conversation, so a user comparing
   * this plugin with Claude Code sees the same cache lifetime rather than half
   * of it.
   *
   * @param settings - the document the caller already read for this turn.
   */
  private static cacheTtlFor(settings: ClaudeModelSettings | null, mainConversation = true): ClaudeCacheTtl {
    // A settings read that failed falls back with everything else: a request
    // must not fail because a preference document could not be read.
    // Outside the main conversation the official client uses five minutes.
    if (!mainConversation) return settings?.subagentCacheTtl ?? CLAUDE_SUBAGENT_CACHE_TTL
    return settings?.cacheTtl ?? CLAUDE_SUBSCRIPTION_CACHE_TTL
  }

  /** Outside the main conversation: any named purpose, or a delegated agent's session. */
  private isMainConversation(options: NormalizedGenerateOptions, sessionId: string | undefined): boolean {
    if (options.purpose !== undefined) return false
    if (sessionId === undefined) return true
    try {
      return this.options.isDelegatedSession?.(sessionId) !== true
    } catch {
      return true
    }
  }

  private async attemptRequest(
    credentials: ClaudeCredentials,
    requestOptions: NormalizedGenerateOptions,
    images: Awaited<ReturnType<typeof resolveRequestImages>>,
    toolNames: ClaudeToolNames,
    settings: ClaudeModelSettings | null,
    signal: AbortSignal,
    fetchFn: typeof fetch,
    version: ClaudeCodeVersionSelection,
    firstParty: ClaudeCodeFirstPartyContext,
    deviceId: string,
    accountId: string | undefined,
    corrections: ClaudeProtocolCorrections,
    cacheTtl: ClaudeCacheTtl,
  ): Promise<Response> {
    // Resolved ONCE and used for both halves of the request: the marker in the
    // body and the beta in the header. They license the same capability, and a
    // request that asks for the one-hour tier in the body without the header is
    // refused — so deriving the header from the body is the only way the two
    // cannot drift.
    //
    // The caller resolves it once per call (see cacheTtlFor): the main
    // conversation and everything else follow separate settings, each `null`
    // meaning "as the official client".
    const catalog = await this.catalog(credentials)
    const capabilityScope = accountId ?? credentials.account?.uuid ?? 'single'
    const remembered = this.capabilityMemory.get(capabilityScope, requestOptions.model)
    const resolvedEntry = resolveClaudeModel(requestOptions.model, catalog)
    const rememberedFastMode = corrections.fastMode ?? remembered.fastMode
    const fastMode = rememberedFastMode === 'unsupported' ? null : rememberedFastMode
    const systemRoleUnsupported = corrections.systemRoleUnsupported === true || remembered.systemRoleUnsupported
    const entry: ClaudeModelEntry = {
      ...resolvedEntry,
      ...(fastMode === undefined ? {} : { fastMode }),
      ...(systemRoleUnsupported ? { midConversationSystem: false } : {}),
    }
    const effectiveCatalog = [entry, ...catalog.filter(candidate => candidate.id !== entry.id)]
    // A saved max_tokens is the final ceiling of a reply that uses the route's
    // default, as the official CLAUDE_CODE_MAX_OUTPUT_TOKENS; a caller's own cap
    // keeps its handling and is only lowered to it. Nothing saved: unchanged.
    const modelLimit = maxOutputTokensFor(requestOptions.model, catalog)
    const saved = savedMaxTokensFor(settings, requestOptions.model, modelLimit)
    const asked = requestOptions.maxTokens
    const usesDefault = saved !== undefined && (asked === undefined || asked === saved || asked === modelLimit)
    const payload = buildClaudeRequestBody({
      ...requestOptions,
      maxTokens: usesDefault ? saved : (asked ?? modelLimit),
    }, images, {
      ...(saved === undefined ? {} : usesDefault ? { maxTokensFinal: true } : { maxOutputLimit: saved }),
      // THE SAME table createStreamState is given — see the module note. Built
      // once by the caller and handed to both sides.
      toolNames,
      // TRUE, and stated here rather than left to the builder's default, because
      // the default is not the mechanism that keeps this working: caching is
      // REQUEST-DRIVEN (Anthropic caches a prefix only where the request puts a
      // cache_control breakpoint), so a request sent without breakpoints bills
      // every turn as fresh input and returns no cache_read_input_tokens. This
      // call site is the one that forgot to ask, which is why the route showed no
      // cache hits at all; writing the intent down here means a future edit that
      // changes the builder's default cannot silently turn caching back off for
      // this provider. See the mapper's section 7 for where the breakpoints go.
      cacheControl: true,
      cacheTtl,
      catalog: effectiveCatalog,
      fastMode: settings?.fastMode === true,
      firstParty: {
        version: version.value,
        deviceId,
        accountUuid: credentials.account?.uuid ?? '',
        context: firstParty,
      },
    })
    try {
      const cachePolicy = promptCachePolicyOf('claude', this.options.promptCache)
      const groupKey = cachePolicy.coldStart === 'off'
        ? undefined
        : sharedPrefixGroupKey('claude', requestOptions, 'subscription', credentials.account?.uuid ?? 'legacy')
      return await fetchWithPrefixCoordination(
        fetchWithContextBudgetRecovery(fetchFn),
        claudePrefixRequests,
        groupKey,
        cachePolicy.coldStart === 'warm' ? cachePolicy.ttlMs : undefined,
        API_BASE + MESSAGES_PATH,
        {
          method: 'POST',
          // The REAL model, never a default: the haiku rule changes the beta set,
          // so a hardcoded id would send the wrong headers for every haiku call
          // and for every non-haiku one alike.
          headers: buildClaudeHeaders(credentials.accessToken, {
            model: requestOptions.model,
            version: version.value,
            firstParty,
            thinkingTokenCount: !(corrections.thinkingTokenCountUnsupported === true || remembered.thinkingTokenCountUnsupported),
            cacheKeepalive: settings?.cacheKeepalive === true,
            fastMode,
            // Read off the body too: the blocks and the beta that licenses them
            // must come from the same request or neither is trustworthy.
            toolChanges: claudeBodyHasToolChanges(payload),
            // The header follows the tier the body just asked for.
            cacheTtl,
            method: 'POST',
          }),
          body: signClaudeCodeRequest(payload, version.seed),
          signal,
        },
      )
    } catch (error) {
      if (signal.aborted) throw new LlmError('Claude request aborted', 'ABORTED', { cause: error })
      throw toLlmError(networkFailure(error))
    }
  }

  private rememberSessionEffort(sessionId: string, effort: string | null): void {
    this.sessionEfforts.delete(sessionId)
    this.sessionEfforts.set(sessionId, effort)
    while (this.sessionEfforts.size > 500) {
      const oldest = this.sessionEfforts.keys().next().value
      if (oldest === undefined) break
      this.sessionEfforts.delete(oldest)
    }
  }

  /** Apply one remembered protocol refusal and retry on the same credential. */
  private async correctProtocolFailure(
    status: number,
    detail: string,
    settings: ClaudeModelSettings | null,
    scope: string,
    model: string,
    corrections: ClaudeProtocolCorrections,
  ): Promise<boolean> {
    if (status !== 400) return false
    if (corrections.systemRoleUnsupported !== true && isClaudeSystemRoleUnsupported(detail)) {
      corrections.systemRoleUnsupported = true
      await this.capabilityMemory.setSystemRoleUnsupported(scope, model)
      return true
    }
    if (settings?.fastMode === true && corrections.fastMode === undefined && isClaudeSpeedUnsupported(detail)) {
      corrections.fastMode = 'unsupported'
      await this.capabilityMemory.setFastMode(scope, model, 'unsupported')
      return true
    }
    if (settings?.fastMode === true && corrections.fastMode !== 'beta' && isClaudeSpeedNeedsBeta(detail)) {
      corrections.fastMode = 'beta'
      await this.capabilityMemory.setFastMode(scope, model, 'beta')
      return true
    }
    if (corrections.thinkingTokenCountUnsupported !== true && isClaudeThinkingTokenCountUnsupported(detail)) {
      corrections.thinkingTokenCountUnsupported = true
      await this.capabilityMemory.setThinkingTokenCountUnsupported(scope, model)
      return true
    }
    return false
  }

  /** Cache-touch is one best-effort attempt; false selects the existing steer warmup. */
  async tryCacheTouch(sessionId: string): Promise<boolean> {
    const existing = this.cacheTouchFlights.get(sessionId)
    if (existing !== undefined) return existing
    const flight = this.performCacheTouch(sessionId).finally(() => { this.cacheTouchFlights.delete(sessionId) })
    this.cacheTouchFlights.set(sessionId, flight)
    return flight
  }

  private async performCacheTouch(sessionId: string): Promise<boolean> {
    const record = this.cacheTouchRecords.get(sessionId)
    if (record === undefined) return false
    try {
      const settings = await this.settings()
      if (!settings.cacheKeepalive || ClaudeAdapter.cacheTtlFor(settings) !== '1h') return false
      const fetchFn = this.options.fetchFn ?? fetch
      const signal = AbortSignal.timeout(30_000)
      let credentials: ClaudeCredentials
      if (this.accountPool !== null && record.accountId !== undefined) {
        if (this.accountPool.getFreshCredential === undefined) return false
        credentials = await this.accountPool.getFreshCredential(record.accountId, fetchFn)
      } else if (this.accountPool === null) {
        credentials = (await this.resolveCredential(null, new Set(), fetchFn, signal)).credentials
      } else {
        return false
      }
      const response = await fetchFn(API_BASE + '/v1/messages/cache_touch', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + credentials.accessToken,
          'content-type': 'application/json',
          'user-agent': claudeUserAgent('cli', this.version.currentProfile().value),
          'x-app': 'cli',
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': 'oauth-2025-04-20,cache-keepalive-2026-09-03',
        },
        body: JSON.stringify({ request_id: record.requestId }),
        signal,
      })
      await response.arrayBuffer().catch(() => undefined)
      if (!response.ok) return false
      const previous = claudeCacheActivity.read(sessionId)
      claudeCacheActivity.record(sessionId, previous?.totalTokens ?? 0, Date.now(), 60 * 60_000)
      return true
    } catch {
      return false
    }
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal, activity?: StreamActivity): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    // RESOLVE THE IMAGES FIRST, THEN OFFLOAD — WITH THE SAME MAP.
    //
    // The order is not interchangeable, and the old order was wrong in a way
    // that cost the user a picture on every turn: the offload pass measured the
    // ESTIMATE of each image's size (its stored raw bytes), while the request
    // actually carried the SCALED-DOWN request version, which is far smaller.
    // An estimate that is too large therefore dropped images the request would
    // have carried comfortably — and the images it dropped were the ones that
    // had been scaled to fit.
    //
    // Measuring the resolved payloads instead means the budget is met by what
    // is really sent, and it also lets the budget see that an image which
    // resolved to 'unavailable' or 'oversized' carries no bytes at all.
    const normalized = withStaticPrefixOrdering('claude', normalizeGenerateOptions(options), this.options.promptCache)
    const images = await resolveRequestImages(normalized, this.options.attachments, signal)
    const stickyImages: ResolvedRequestImages = new Map([...images].map(([id, image]) => [
      id,
      image.kind === 'oversized' ? { kind: 'unavailable' } : image,
    ] as const))
    const sticky = promptCachePolicyOf('claude', this.options.promptCache).stickyImages
      ? offloadRequestImagesWithStickyBudget(
          normalized,
          MAX_REQUEST_IMAGE_BYTES,
          // Trimming back to the low mark must leave room for one legal image.
          MAX_SINGLE_REQUEST_IMAGE_BYTES,
          stickyImages,
          claudeStickyImages.priorDroppedKeys(normalized.sessionId),
          undefined,
          MAX_SINGLE_REQUEST_IMAGE_BYTES,
        )
      : undefined
    const requestOptions = sticky?.options ?? offloadOldestRequestImages(normalized, images)
    if (sticky !== undefined && sticky.newlyDroppedKeys.length > 0) {
      claudeStickyImages.record(normalized.sessionId, sticky.allDroppedKeys)
    }
    // One table for both directions of this request — see module note 2.
    const toolNames = claudeToolNames(requestOptions.tools)
    // The version floor is checked here, BEFORE the credential is resolved and
    // before any request is built: no account rotation and no retry can change a
    // verdict about a client version, so spending a request to learn it would
    // only produce the opaque upstream 400 this replaces. See the function's own
    // doc comment for what it is careful NOT to do.
    const requestCatalog = await this.catalogForRequest()
    await Promise.all([this.version.warm(), this.capabilityMemory.warm()])
    const version = this.version.currentProfile()
    assertClaudeCliVersionMeetsFloor(requestOptions.model, requestCatalog, version.value)
    // Read once per turn, next to the version: every attempt in this call shares both.
    const settings = await this.settings().catch(() => null)
    const sessionId = requestOptions.sessionId?.trim() || undefined
    const namedEffort = typeof requestOptions.reasoningEffort === 'string' && requestOptions.reasoningEffort.trim() !== ''
      ? requestOptions.reasoningEffort.trim() : undefined
    let callOptions = requestOptions
    if (requestOptions.purpose === 'compaction' && namedEffort === undefined && sessionId !== undefined) {
      const remembered = this.sessionEfforts.get(sessionId)
      if (remembered === null) callOptions = { ...requestOptions, reasoningEffort: undefined }
      else if (remembered !== undefined && claudeReasoningEfforts(requestOptions.model, requestCatalog).includes(remembered)) {
        callOptions = { ...requestOptions, reasoningEffort: ReasoningEffortId(remembered) }
      }
    }
    const cacheTtl = ClaudeAdapter.cacheTtlFor(settings, this.isMainConversation(requestOptions, sessionId))
    this.version.noteActivity(cacheTtl, 'claude')
    const deviceId = await this.modelSettings.ensureDeviceId()
    const sessionUuid = sessionId === undefined ? randomUUID() : claudeCodeSessionUuid(sessionId, 'dsh-claude-subscription-session:')
    const firstParty = this.firstParty.begin(sessionUuid, sessionId ?? sessionUuid)

    // Wait-time keepalive evidence: only MAIN turns record, and the idle clock starts
    // when the request is SENT - that is when upstream touches the cache, so a stream
    // that runs for minutes must not push the decision point past the TTL. The tier
    // recorded is the one this request really asks for, read from the SAME settings
    // snapshot attemptRequest builds the body and the beta header from.
    const waitSessionId = sessionId
    const mainTurn = requestOptions.purpose === undefined && waitSessionId !== undefined
    if (mainTurn) this.rememberSessionEffort(waitSessionId, namedEffort ?? settings?.defaultReasoningEffort ?? null)
    const waitTtlMs = cacheTtl === '1h' ? 60 * 60_000 : 5 * 60_000
    let issuedAt = 0

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
    /**
     * The account the response now being streamed was issued with.
     *
     * Hoisted out of the loop because the in-stream failure path needs it: a
     * rate limit reported inside a 200 stream belongs to the account that was
     * asked, and that account is what the failure takes out of rotation — the
     * harness is about to repeat this request, and repeating it against the same
     * exhausted account fails identically.
     */
    let usedAccountId: string | undefined
    const corrections: ClaudeProtocolCorrections = {}
    let retryCredentials: ClaudeCredentials | undefined

    while (true) {
      const resolved = retryCredentials !== undefined
        ? { credentials: retryCredentials, accountId: usedAccountId }
        : await this.resolveCredential(pool, tried, fetchFn, signal)
      retryCredentials = undefined
      const { credentials, accountId } = resolved
      usedAccountId = accountId
      if (mainTurn) {
        issuedAt = Date.now()
        claudeCacheActivity.record(waitSessionId, claudeCacheActivity.read(waitSessionId)?.totalTokens ?? 0, issuedAt, waitTtlMs)
      }
      response = await this.attemptRequest(credentials, callOptions, images, toolNames, settings, signal, fetchFn, version, firstParty, deviceId, accountId, corrections, cacheTtl)
      // Headers are transport activity: the streaming idle budget starts at the
      // hand-off, so a slow prefill is not spent from it.
      activity?.pulse()
      // Every attempt so far has been a pre-body failure, so nothing has reached
      // the caller and a rotation is still free. Once this method starts
      // yielding, outputStarted flips and shouldRotateAccount refuses forever.

      if (response.ok) break

      const detail = (await response.text().catch(() => '')).slice(0, 2_000)
      const scope = accountId ?? credentials.account?.uuid ?? 'single'
      if (await this.correctProtocolFailure(response.status, detail, settings, scope, requestOptions.model, corrections)) {
        retryCredentials = credentials
        continue
      }
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
    if (mainTurn && settings?.cacheKeepalive === true && waitTtlMs === 60 * 60_000) {
      const requestId = response.headers.get('request-id') ?? ''
      if (/^req_[A-Za-z0-9_-]{1,36}$/.test(requestId)) {
        this.cacheTouchRecords.delete(waitSessionId)
        this.cacheTouchRecords.set(waitSessionId, { requestId, ...(usedAccountId === undefined ? {} : { accountId: usedAccountId }) })
        while (this.cacheTouchRecords.size > 256) {
          const oldest = this.cacheTouchRecords.keys().next().value
          if (oldest === undefined) break
          this.cacheTouchRecords.delete(oldest)
        }
      } else {
        this.cacheTouchRecords.delete(waitSessionId)
      }
    } else if (mainTurn) {
      this.cacheTouchRecords.delete(waitSessionId)
    }
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
          // Transport received bytes, whether or not a parser turns them into a
          // visible chunk: a heartbeat frame is proof the connection is alive.
          if (value !== undefined && value.byteLength > 0) activity?.pulse()
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            // One complete frame arrived. A ': ping' comment yields no chunk at
            // all and must still re-time the watchdog.
            if (line.trim() !== '') activity?.pulse()
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
        // error event) is passed through — except an in-band error event that
        // arrived before anything reached the caller, which is classified like
        // the response body it is equivalent to (see inBandStreamVerdict).
        if (error instanceof LlmError) {
          // PROVIDER_ERROR is the ONLY verdict eligible for reclassification, and
          // that restriction is load-bearing rather than tidy: a CONTEXT OVERFLOW
          // the mapper already typed here is the signal the harness compacts on,
          // and rewriting it into a retryable SERVER would throw that recovery
          // away while the request keeps failing the same way. An event can carry
          // a transient `type` AND an overflow message, so the code the mapper
          // chose - not the type on the wire - decides this.
          if (outputStarted || error.code !== 'PROVIDER_ERROR' || state.streamError === undefined) throw error
          const verdict = inBandStreamVerdict(error, state.streamError, response.headers)
          // The rotation cannot happen here — the body is already open — but the
          // account CAN be taken out of rotation, which is what the pre-stream
          // branch does for the same verdict and what makes the harness retry
          // worth taking. Overload and a global limit are shared by every account
          // behind the gateway, so they leave the pool untouched, exactly as
          // shouldRotateAccount refuses to rotate them.
          if (verdict.failure !== null
            && shouldRotateAccount(verdict.failure, outputStarted)
            && usedAccountId !== undefined) {
            await pool?.markCooldown(
              usedAccountId,
              cooldownMsFor(verdict.failure),
              PROVIDER_NAME + ' in-stream 429',
            ).catch(() => undefined)
          }
          throw verdict.error
        }
        if (signal.aborted) throw new LlmError('Claude request aborted', 'ABORTED', { cause: error })
        // A severed connection is a transport failure even after output has
        // started. Account rotation still stops at the first chunk (module note
        // 1), but the route's bounded retry policy must see the retryable code.
        // Keep the original error as the cause so socket diagnostics survive.
        throw new LlmError(
          'Claude stream failed: ' + (error instanceof Error ? error.message : String(error)),
          'TRANSPORT',
          { cause: error },
        )
      }
    } finally {
      // Add the measured prompt size, keeping the issue time: this record must never
      // move lastActiveAt later than the moment the request was sent.
      if (mainTurn) {
        claudeCacheActivity.record(
          waitSessionId,
          state.sawUsage
            ? state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens
            : claudeCacheActivity.read(waitSessionId)?.totalTokens ?? 0,
          issuedAt,
          waitTtlMs,
        )
      }
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
 * The DSH error an in-band `error` event becomes when it arrived BEFORE any
 * chunk reached the caller.
 * @param thrown - the mapper's PROVIDER_ERROR (or context-overflow) verdict.
 * @param streamError - the event's wire `error` object, from the stream state.
 * @param headers - the 200 response's headers, read for the rate-limit verdict.
 */
export function inBandStreamVerdict(
  thrown: LlmError,
  streamError: Record<string, unknown>,
  headers: Headers,
): InBandStreamVerdict {
  const failure = classifyFailure(0, JSON.stringify({ error: streamError }), headers)
  if (failure.type === null || !failure.retryable) return { error: thrown, failure: null }
  const retryAfter = failure.retryAfterMs !== null && failure.retryAfterMs > 0
    ? failure.retryAfterMs
    : undefined
  return {
    error: new LlmError(
      thrown.message,
      codeForFailure(failure),
      retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
    ),
    failure,
  }
}

/** What one in-band `error` event becomes when nothing had reached the caller yet. */
export interface InBandStreamVerdict {
  /** The error the caller sees: the mapper's, or its reclassified replacement. */
  error: LlmError
  /**
   * The envelope classified as a response body, or null when the mapper's own
   * verdict stands. Present only for a RECOGNIZED transient type, so `kind` and
   * `accountScoped` can be read off it directly.
   */
  failure: ClaudeFailure | null
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

  if (failure.kind === 'request' && isHttpContextOverflow(failure.status, failure.message)) {
    return new LlmError(PROVIDER_NAME + ' context window exceeded.' + detail, CONTEXT_OVERFLOW_CODE, options)
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
