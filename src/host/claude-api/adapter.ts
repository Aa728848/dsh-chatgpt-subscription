import {
  LlmAdapter,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { randomUUID } from 'node:crypto'
import { localizedProviderName } from '../common/i18n/index.ts'
import { LlmError, normalizeGenerateOptions } from '../common/llm-compat.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../common/context-overflow.ts'
import { STREAM_IDLE_TIMEOUT_CODE, STREAM_IDLE_TIMEOUT_MS, wrapStreamWithWatchdog, type StreamActivity } from '../common/idle-watchdog.ts'
import {
  offloadOldestRequestImages,
  requestImageTargetOrOriginal,
  resolveRequestImages,
  type AttachmentImageReader,
} from '../common/request-images.ts'
import type { PromptCacheOverride } from '../common/prompt-cache-policy.ts'
import { promptCacheActivityStore } from '../common/cache-activity.ts'
import { ClaudeCodeFirstPartyTracker } from '../common/claude-code-first-party.ts'
import { signClaudeCodeCch } from '../common/claude-code-cch.ts'
import { isClaudeThinkingTokenCountUnsupported } from '../common/claude-code-corrections.ts'
import type { ClaudeCodeVersionSelection } from '../common/claude-code-version.ts'
import { fetchWithContextBudgetRecovery } from '../common/context-budget-fetch.ts'
import { outputReservation } from '../common/output-reservation.ts'
import { ClaudeApiCatalogManager } from './catalog-manager.ts'
import {
  claudeApiContextWindow,
  convergeClaudeApiSelection,
  resolveClaudeApiModel,
  type ClaudeApiModelEntry,
} from './model-catalog.ts'
import { ClaudeApiCredentialStore, ClaudeApiSettingsStore, claudeApiCredentialFingerprint, type ClaudeApiSettings } from './token-store.ts'
import type { ClaudeApiClientVersionResolver } from './client-version.ts'
import type { ClaudeApiCompactionStore } from './compaction-store.ts'
import { ClaudeApiCapabilityMemory } from './capability-memory.ts'
import {
  CLAUDE_API_MAX_REQUEST_IMAGE_BYTES,
  CLAUDE_API_MESSAGES_PATH,
  PROVIDER_ID,
  PROVIDER_NAME,
  claudeApiSafeDetail,
  claudeApiSessionUuid,
  claudeApiUrl,
} from './types.ts'
import { buildClaudeApiHeaders, parseClaudeApiError } from './client.ts'
import { buildClaudeApiRequest, deriveClaudeApiBetas, type ClaudeApiRequestContext } from './mapper.ts'
import {
  assertClaudeApiStreamComplete,
  closeClaudeApiStream,
  createClaudeApiStreamState,
  processClaudeApiLine,
  type ClaudeApiStreamState,
} from './stream.ts'
import {
  buildClaudeApiCompactionRequest,
  isClaudeApiCompactionBlockInvalid,
  isClaudeApiCompactionRequest,
  isClaudeApiCompactionUnsupported,
  stripClaudeApiCompactionDirective,
} from './compaction.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'SERVER', 'NETWORK', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.claude-api.retry')

/** A pair refused server compaction stays refused for this long (spec: server compaction, fallback). */
const UNSUPPORTED_TTL_MS = 30 * 60_000
/** Upper bound of remembered per-session main-turn efforts; the oldest session is dropped first. */
const SESSION_EFFORT_CAP = 500
/** Wait-time keepalive evidence; only this line's MAIN turns write it. */
const claudeApiCacheActivity = promptCacheActivityStore(PROVIDER_ID)

/** Model-level refusals ("'<model>' does not support ... compaction ...") describe the
 * model and last for the process; parameter/beta-level refusals describe the endpoint,
 * which may be upgraded, and expire after the TTL. */
export function claudeApiUnsupportedUntil(now: number, bodyText: string): number | null {
  const haystack = bodyText.toLowerCase()
  if (haystack.includes('compaction') && haystack.includes('does not support')) return null
  return now + UNSUPPORTED_TTL_MS
}

/** The verified "model does not support the speed parameter" refusal (any error envelope). */
export function isClaudeApiSpeedUnsupported(bodyText: string): boolean {
  const haystack = bodyText.toLowerCase()
  return haystack.includes('speed') && haystack.includes('does not support')
}

/** The verified "model rejects the system role inside messages" refusal. A placement
 * error ("role 'system' must follow ...") is a request bug, NOT a model limitation. */
export function isClaudeApiSystemRoleUnsupported(bodyText: string): boolean {
  const haystack = bodyText.toLowerCase()
  return haystack.includes("role 'system'") && haystack.includes('is not supported')
}

/** The verified "speed needs the fast-mode beta header" refusal (any error envelope). */
export function isClaudeApiSpeedNeedsBeta(bodyText: string): boolean {
  const haystack = bodyText.toLowerCase()
  return haystack.includes('speed') && haystack.includes('anthropic-beta') && haystack.includes('fast-mode')
}

export interface ClaudeApiAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  promptCache?: PromptCacheOverride
  version: ClaudeApiClientVersionResolver
  compactionStore: ClaudeApiCompactionStore
  capabilityMemory?: ClaudeApiCapabilityMemory
}
interface ClassifiedError extends LlmError {
  status?: number
  claudeApiStatus?: number
  claudeApiDetail?: string
  /** Redacted raw error body, so the compaction predicates can read code/type fields too. */
  claudeApiBody?: string
}

/** The stored compaction block a built body replays at the head, or null when it carries none. */
function headCompactionContent(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0] as Record<string, unknown> | undefined
  const content = first !== undefined && Array.isArray(first.content) ? first.content : []
  const block = content[0] as Record<string, unknown> | undefined
  return block !== undefined && block.type === 'compaction' && typeof block.content === 'string' ? block.content : null
}

/** The effort ladder the settings card advertises: 'none' only when thinking can be disabled. */
function effortLadder(entry: ClaudeApiModelEntry): string[] {
  if (entry.thinkingMode === 'none') return []
  return [...(entry.canDisableThinking ? ['none'] : []), ...entry.reasoningEfforts]
}

export async function classifyClaudeApiResponse(response: Response, apiKey?: string): Promise<ClassifiedError> {
  const raw = await response.text().catch(() => '')
  const detail = parseClaudeApiError(response.status, raw, apiKey)
  const options = { status: response.status }
  let error: ClassifiedError
  if (isHttpContextOverflow(response.status, detail.message)) error = new LlmError('Claude API context window exceeded: ' + detail.message, CONTEXT_OVERFLOW_CODE, options)
  else if (response.status === 401 || response.status === 403) error = new LlmError('Claude API rejected the API key: ' + detail.message, 'AUTH', options)
  else if (response.status === 404) error = new LlmError('Claude API model or endpoint was not found: ' + detail.message, 'NOT_FOUND', options)
  else if (response.status === 429) error = new LlmError('Claude API rate limit reached: ' + detail.message, 'RATE_LIMIT', options)
  else if (response.status >= 500) error = new LlmError('Claude API upstream service error (' + response.status + '): ' + detail.message, 'SERVER_ERROR', options)
  else error = new LlmError(detail.message, 'PROVIDER_ERROR', options)
  error.claudeApiStatus = response.status
  error.claudeApiDetail = detail.message
  error.claudeApiBody = claudeApiSafeDetail(raw, apiKey, 8000)
  return error
}

export class ClaudeApiAdapter extends LlmAdapter {
  private readonly fetchFn: typeof fetch
  private readonly capabilityMemory: ClaudeApiCapabilityMemory
  private readonly firstParty = new ClaudeCodeFirstPartyTracker()
  /** Endpoint-level compaction refusals (30 min, in memory only); model-level facts live in the capability memory. */
  private readonly unsupported = new Map<string, number>()
  /** The effort each session's most recent MAIN turn resolved; null means "no effort sent". */
  private readonly sessionEfforts = new Map<string, string | null>()
  constructor(
    private readonly store: ClaudeApiCredentialStore,
    private readonly settingsStore: ClaudeApiSettingsStore,
    private readonly catalog: ClaudeApiCatalogManager,
    private readonly options: ClaudeApiAdapterOptions,
  ) {
    super()
    this.fetchFn = fetchWithContextBudgetRecovery(options.fetchFn ?? fetch)
    this.capabilityMemory = options.capabilityMemory ?? new ClaudeApiCapabilityMemory()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: localizedProviderName(provider, PROVIDER_NAME) }
  }
  providerRetryPolicy(): ResolvedRetryPolicy { return RETRY_POLICY }
  imageRequestPricing(): undefined { return undefined }
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return requestImageTargetOrOriginal(image)
  }

  async listModels(provider?: string): Promise<readonly LlmResolvedModelInfo[]> {
    const [settings, credentials] = await Promise.all([this.settingsStore.read(), this.store.read().catch(() => null)])
    await this.catalog.warm()
    await this.capabilityMemory.warm()
    if (!settings.enabled || credentials === null) return []
    const snapshot = this.catalog.snapshot()
    const allowed = convergeClaudeApiSelection(snapshot.entries, settings, snapshot.live)
    return snapshot.entries.filter(entry => allowed.has(entry.id)).map(entry => this.modelInfo(provider || PROVIDER_ID, entry, settings))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Claude API model resolution was aborted.', 'ABORTED')
    const [settings] = await Promise.all([this.settingsStore.read(), this.catalog.warm(), this.capabilityMemory.warm()])
    const entry = resolveClaudeApiModel(model, this.catalog.snapshot().entries)
    const contextWindow = claudeApiContextWindow(entry, settings)
    return {
      ...this.modelInfo(provider, entry, settings),
      ...outputReservation(contextWindow, entry.maxOutputTokens),
    }
  }

  private modelInfo(provider: string, entry: ClaudeApiModelEntry, settings: ClaudeApiSettings): LlmResolvedModelInfo {
    const ladder = effortLadder(entry)
    const configured = settings.defaultReasoningEffort
    const defaultEffort = configured !== null && ladder.includes(configured) ? ReasoningEffortId(configured) : undefined
    return {
      provider, id: entry.id, name: entry.name,
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: claudeApiContextWindow(entry, settings) },
      // A model that keeps system messages in history can take tool changes there too.
      ...(entry.midConversationSystem && !this.capabilityMemory.get(settings.baseUrl, entry.id).systemRoleUnsupported
        ? { toolUpdate: 'in-history' as const } : {}),
      ...(ladder.length === 0 ? {} : {
        reasoning: {
          efforts: ladder.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        },
      }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    const entry = resolveClaudeApiModel(resolved.id, this.catalog.snapshot().entries)
    return { model: resolved, stream: options => this.streamWithEntry(options, entry) }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.catalog.warm()
    const entry = resolveClaudeApiModel(options.model, this.catalog.snapshot().entries)
    yield* this.streamWithEntry(options, entry)
  }

  private async *streamWithEntry(rawOptions: GenerateOptions, entry: ClaudeApiModelEntry): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (signal, activity) => this.requestStream(rawOptions, entry, signal, activity),
      rawOptions.signal, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE, PROVIDER_NAME,
    )
  }

  private rememberSessionEffort(sessionId: string, effort: string | null): void {
    // Delete-then-set refreshes recency, so the cap drops the least recently used session.
    this.sessionEfforts.delete(sessionId)
    this.sessionEfforts.set(sessionId, effort)
    if (this.sessionEfforts.size > SESSION_EFFORT_CAP) {
      const oldest = this.sessionEfforts.keys().next().value
      if (oldest !== undefined) this.sessionEfforts.delete(oldest)
    }
  }

  private isUnsupported(baseUrl: string, model: string): boolean {
    const until = this.unsupported.get(baseUrl + '\n' + model)
    if (until !== undefined) {
      if (Date.now() < until) return true
      this.unsupported.delete(baseUrl + '\n' + model)
    }
    return this.capabilityMemory.get(baseUrl, model).compactionUnsupported
  }
  private async markUnsupported(baseUrl: string, model: string, bodyText: string): Promise<void> {
    const until = claudeApiUnsupportedUntil(Date.now(), bodyText)
    if (until === null) await this.capabilityMemory.setCompactionUnsupported(baseUrl, model)
    else this.unsupported.set(baseUrl + '\n' + model, until)
  }

  private async openRequest(
    body: Record<string, unknown>,
    entry: ClaudeApiModelEntry,
    apiKey: string,
    version: ClaudeCodeVersionSelection,
    sessionUuid: string,
    baseUrl: string,
    signal: AbortSignal,
    firstParty: ClaudeApiRequestContext['firstParty'],
    thinkingTokenCount: boolean,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchFn(claudeApiUrl(baseUrl, CLAUDE_API_MESSAGES_PATH), {
        method: 'POST',
        headers: buildClaudeApiHeaders({ apiKey, version: version.value, sessionUuid, betas: deriveClaudeApiBetas(body, entry, thinkingTokenCount), stream: true, firstParty }),
        body: signClaudeCodeCch(JSON.stringify(body), version.seed),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new LlmError('Claude API request was aborted.', 'ABORTED')
      throw new LlmError('Claude API request failed: ' + claudeApiSafeDetail(error, apiKey), 'TRANSPORT')
    }
    if (!response.ok) throw await classifyClaudeApiResponse(response, apiKey)
    return response
  }

  private async *pump(response: Response, state: ClaudeApiStreamState, activity?: StreamActivity): AsyncGenerator<StreamChunk> {
    if (response.body === null) throw new LlmError('Claude API returned no response stream.', 'PROVIDER_ERROR')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!state.finished) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined && value.byteLength > 0) activity?.pulse()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          activity?.pulse()
          for (const chunk of processClaudeApiLine(line, state)) yield chunk
          if (state.finished) break
        }
      }
      if (!state.finished) {
        buffer += decoder.decode()
        if (buffer.trim() !== '') for (const line of buffer.split('\n')) for (const chunk of processClaudeApiLine(line, state)) yield chunk
      }
      if (!state.finished) {
        assertClaudeApiStreamComplete(state)
        for (const chunk of closeClaudeApiStream(state)) yield chunk
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private async *requestStream(
    rawOptions: GenerateOptions,
    entry: ClaudeApiModelEntry,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    const [settings, credentials] = await Promise.all([this.settingsStore.read(), this.store.read()])
    if (credentials === null) throw new LlmError('Claude API key is not configured.', 'MISSING_CREDENTIAL')
    await this.options.compactionStore.warm()
    await this.capabilityMemory.warm()
    // History is sent append-only: no static-prefix reordering on this line. The billing
    // block already differs per conversation, and hoisting reminders past a checkpoint
    // would both defeat the block replay and shift every earlier turn's prefix.
    const normalized = normalizeGenerateOptions(rawOptions)
    const images = await resolveRequestImages(normalized, this.options.attachments, signal)
    const requestOptions = offloadOldestRequestImages(normalized, CLAUDE_API_MAX_REQUEST_IMAGE_BYTES, images)
    const sessionId = requestOptions.sessionId?.trim() || undefined
    // A compaction request follows the session's CURRENT effort (user decision). The host's
    // compaction engine names no reasoningEffort, so without this the settings default -
    // possibly stale since the user switched the session's effort - would win. The chosen
    // value applies to the WHOLE call: server body, client-side fallback and every retry.
    const namedEffort = typeof requestOptions.reasoningEffort === 'string' && requestOptions.reasoningEffort.trim() !== ''
      ? requestOptions.reasoningEffort.trim() : undefined
    let callOptions = requestOptions
    let callSettings = settings
    if (isClaudeApiCompactionRequest(requestOptions) && namedEffort === undefined && sessionId !== undefined) {
      const remembered = this.sessionEfforts.get(sessionId)
      if (remembered === null) {
        // "No effort sent" is a remembered value too: suppress the settings default.
        callSettings = { ...settings, defaultReasoningEffort: null }
      } else if (remembered !== undefined && effortLadder(entry).includes(remembered)) {
        callOptions = { ...requestOptions, reasoningEffort: ReasoningEffortId(remembered) }
      }
      // Nothing remembered, or the remembered effort is not on this model's ladder
      // (the session switched model): keep the settings-default fallback.
    }
    await this.options.version.warm()
    // Read ONCE per call: this is where a pending version may be adopted, before the call
    // counts as activity. Every request inside the call shares this one value.
    const version = this.options.version.currentProfile()
    this.options.version.noteActivity(settings.cacheTtl)
    try {
      const sessionUuid = sessionId !== undefined ? claudeApiSessionUuid(sessionId) : randomUUID()
      const deviceId = await this.settingsStore.ensureDeviceId()
      // Stored blocks are replayed only against the credential + endpoint that produced them.
      const scope = claudeApiCredentialFingerprint(credentials, settings.baseUrl)
      // Unknown claude-* ids try fast mode optimistically ('ga' first); the capability
      // memory holds what upstream taught us about this endpoint+model.
      const fastEligible = settings.fastMode && entry.known === false && entry.id.toLowerCase().startsWith('claude-')
      const facts = this.capabilityMemory.get(settings.baseUrl, entry.id)
      let activeEntry: ClaudeApiModelEntry = fastEligible
        ? { ...entry, fastMode: facts.fastMode === 'unsupported' ? null : facts.fastMode === 'beta' ? 'beta' : 'ga' }
        : entry
      // A remembered system-role refusal folds system messages up front, no failing attempt.
      if (entry.midConversationSystem && facts.systemRoleUnsupported) {
        activeEntry = { ...activeEntry, midConversationSystem: false }
      }
      // A block goes to the mapper only for a model that can take it on an unmarked pair;
      // otherwise the checkpoint keeps its text form and the block stays stored.
      const firstParty = this.firstParty.begin(sessionUuid, sessionId ?? sessionUuid)
      const context: ClaudeApiRequestContext = {
        entry: activeEntry, settings: callSettings, version: version.value, deviceId, sessionUuid, firstParty,
        compactionBlocks: {
          lookup: summary => entry.serverCompaction && !this.isUnsupported(settings.baseUrl, entry.id)
            ? this.options.compactionStore.lookup(summary, scope)
            : undefined,
        },
      }
      // Fast-mode corrections: at most once each per call, always before any output.
      const speedState = { unsupported: false, beta: false }
      const systemState = { corrected: false }
      const thinkingState = { corrected: false }
      const openCorrected = async (rebuild: () => Record<string, unknown>): Promise<Response> => {
        try {
          return await this.openRequest(rebuild(), activeEntry, credentials.apiKey, version, sessionUuid, settings.baseUrl, signal, context.firstParty, !thinkingState.corrected && !facts.thinkingTokenCountUnsupported)
        } catch (error) {
          const classified = error as ClassifiedError
          const errorBody = classified.claudeApiBody ?? classified.claudeApiDetail ?? ''
          if (classified.claudeApiStatus !== 400) throw error
          if (!systemState.corrected && entry.midConversationSystem && isClaudeApiSystemRoleUnsupported(errorBody)) {
            systemState.corrected = true
            await this.capabilityMemory.setSystemRoleUnsupported(settings.baseUrl, entry.id)
            activeEntry = { ...activeEntry, midConversationSystem: false }
          } else if (!thinkingState.corrected && isClaudeThinkingTokenCountUnsupported(errorBody)) {
            thinkingState.corrected = true
            await this.capabilityMemory.setThinkingTokenCountUnsupported(settings.baseUrl, entry.id)
          } else if (!fastEligible) {
            throw error
          } else if (!speedState.unsupported && isClaudeApiSpeedUnsupported(errorBody)) {
            speedState.unsupported = true
            await this.capabilityMemory.setFastMode(settings.baseUrl, entry.id, 'unsupported')
            activeEntry = { ...activeEntry, fastMode: null }
          } else if (!speedState.beta && isClaudeApiSpeedNeedsBeta(errorBody)) {
            speedState.beta = true
            await this.capabilityMemory.setFastMode(settings.baseUrl, entry.id, 'beta')
            activeEntry = { ...activeEntry, fastMode: 'beta' }
          } else {
            throw error
          }
          context.entry = activeEntry
          // Recurse so several corrections compose; the per-call flags bound the depth.
          return await openCorrected(rebuild)
        }
      }

      // Server-side compaction whenever every gate holds - including a compaction another
      // line deliberately routed to this one; otherwise the unchanged client-side request.
      const stripped = isClaudeApiCompactionRequest(requestOptions) ? stripClaudeApiCompactionDirective(requestOptions) : null
      const eligible = stripped !== null && settings.serverCompaction && entry.serverCompaction
        && !this.isUnsupported(settings.baseUrl, entry.id)
      if (eligible) {
        let compBody = buildClaudeApiCompactionRequest(callOptions, images, context)
        let response: Response | null = null
        try {
          response = await openCorrected(() => {
            compBody = buildClaudeApiCompactionRequest(callOptions, images, context)
            return compBody
          })
        } catch (error) {
          const classified = error as ClassifiedError
          const errorBody = classified.claudeApiBody ?? classified.claudeApiDetail ?? ''
          const staleContent = headCompactionContent(compBody)
          if (classified.claudeApiStatus === 400 && staleContent !== null && isClaudeApiCompactionBlockInvalid(400, errorBody)) {
            // The stored head block failed its validity check: forget it and retry the
            // compaction once with the checkpoint in text form. NOT an unsupported pair.
            await this.options.compactionStore.forget(staleContent, scope)
            try {
              response = await openCorrected(() => {
                compBody = buildClaudeApiCompactionRequest(callOptions, images, context)
                return compBody
              })
            } catch (retryError) {
              const retryClassified = retryError as ClassifiedError
              const retryBody = retryClassified.claudeApiBody ?? retryClassified.claudeApiDetail ?? ''
              if (!(retryClassified.claudeApiStatus === 400 && isClaudeApiCompactionUnsupported(400, retryBody))) throw retryError
              await this.markUnsupported(settings.baseUrl, entry.id, retryBody)
            }
          } else if (classified.claudeApiStatus === 400 && isClaudeApiCompactionUnsupported(400, errorBody)) {
            await this.markUnsupported(settings.baseUrl, entry.id, errorBody)
          } else {
            throw error
          }
        }
        if (response !== null) {
          // Buffer the whole compaction answer: nothing is yielded unless the block is usable.
          const state = createClaudeApiStreamState()
          const buffered: StreamChunk[] = []
          for await (const chunk of this.pump(response, state, activity)) buffered.push(chunk)
          const comp = state.compaction
          if (comp !== null && comp.content.trim() !== '') {
            await this.options.compactionStore.remember({
              content: comp.content, signature: comp.signature,
              ...(comp.toolChanges !== undefined ? { toolChanges: comp.toolChanges } : {}),
              model: entry.id, scope,
            })
            for (const chunk of buffered) yield chunk
            return
          }
          await this.markUnsupported(settings.baseUrl, entry.id, '')
        }
        // Fall through: the SAME call now sends the original client-side request.
      }

      const mainTurn = requestOptions.purpose === undefined && sessionId !== undefined
      // Remember the effort this MAIN turn resolves, at issuance (even if the request
      // later fails): the session's next compaction follows exactly this value.
      if (mainTurn) {
        this.rememberSessionEffort(sessionId, namedEffort ?? settings.defaultReasoningEffort)
      }
      // Wait-time keepalive: the idle clock starts when the request is SENT, because that
      // is when upstream last touched the cache - a stream that runs for minutes must not
      // push the decision point past the TTL. The recorded lifetime is the tier gate: only
      // a 1h session matches the policy ttl. Auxiliary purposes never record.
      const waitTtlMs = settings.cacheTtl === '1h' ? 60 * 60_000 : 5 * 60_000
      const issuedAt = Date.now()
      if (mainTurn) {
        claudeApiCacheActivity.record(sessionId, claudeApiCacheActivity.read(sessionId)?.totalTokens ?? 0, issuedAt, waitTtlMs)
      }
      let body: Record<string, unknown> = {}
      let response: Response
      try {
        response = await openCorrected(() => {
          body = buildClaudeApiRequest(callOptions, images, context)
          return body
        })
      } catch (error) {
        const classified = error as ClassifiedError
        const staleContent = headCompactionContent(body)
        const errorBody = classified.claudeApiBody ?? classified.claudeApiDetail ?? ''
        const blockRejected = staleContent !== null && classified.claudeApiStatus === 400
        if (blockRejected && isClaudeApiCompactionBlockInvalid(400, errorBody)) {
          // A stale/misplaced block is forgotten and retried once in text form.
          await this.options.compactionStore.forget(staleContent, scope)
        } else if (blockRejected && isClaudeApiCompactionUnsupported(400, errorBody)) {
          // The model/endpoint cannot take compaction at all: mark the pair and retry once
          // in text form, but KEEP the block for models that do support it.
          await this.markUnsupported(settings.baseUrl, entry.id, errorBody)
        } else {
          throw error
        }
        response = await openCorrected(() => {
          body = buildClaudeApiRequest(callOptions, images, context)
          return body
        })
      }
      activity?.pulse()
      const mainState = createClaudeApiStreamState()
      try {
        yield* this.pump(response, mainState, activity)
      } finally {
        // Add the measured prompt size, keeping the issue time: this record must never
        // move lastActiveAt later than the moment the request was sent.
        if (mainTurn) {
          claudeApiCacheActivity.record(
            sessionId,
            mainState.sawUsage
              ? mainState.inputTokens + mainState.cacheReadTokens + mainState.cacheWriteTokens
              : claudeApiCacheActivity.read(sessionId)?.totalTokens ?? 0,
            issuedAt,
            waitTtlMs,
          )
        }
      }
    } finally {
      // The call's stream ended or failed: refresh the idle window for the next adoption.
      this.options.version.noteActivity(settings.cacheTtl)
    }
  }
}

export { PROVIDER_ID, PROVIDER_NAME }
