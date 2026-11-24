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
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { localizedProviderName } from '../../common/i18n/index.ts'
import { LlmError, normalizeGenerateOptions } from '../../common/llm-compat.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../../common/context-overflow.ts'
import { STREAM_IDLE_TIMEOUT_CODE, STREAM_IDLE_TIMEOUT_MS, wrapStreamWithWatchdog, type StreamActivity } from '../../common/idle-watchdog.ts'
import {
  offloadOldestRequestImages,
  requestImageTargetOrOriginal,
  resolveRequestImages,
  type AttachmentImageReader,
  type ResolvedRequestImages,
} from '../../common/request-images.ts'
import { withStaticPrefixOrdering } from '../../common/prefix-stability.ts'
import { promptCachePolicyOf, type PromptCacheOverride } from '../../common/prompt-cache-policy.ts'
import { isAuxiliaryRequest } from '../../common/prefix-request-coordinator.ts'
import { stableSessionId } from '../../infra/network/wire-auth.ts'
import { fetchWithContextBudgetRecovery } from '../../common/context-budget-fetch.ts'
import { parseResponsesStream } from '../codex-chatgpt/responses-client.ts'
import type { RelayOneProtocol } from '../../../shared/relayone-contracts.ts'
import { RelayOneCatalogManager } from './catalog-manager.ts'
import {
  fallbackRelayOneProtocol,
  isRelayOneProtocolUnsupported,
  isRelayOneOpenAIModel,
  relayOneModelOptions,
  resolveRelayOneModel,
  type RelayOneModelEntry,
} from './model-catalog.ts'
import {
  RelayOneCredentialStore,
  RelayOneSettingsStore,
  relayOneCredentialFingerprint,
  type RelayOneCredentials,
} from './token-store.ts'
import type { RelayOneAccountPool } from './account-pool.ts'
import {
  PROVIDER_ID,
  PROVIDER_NAME,
  RELAYONE_CHAT_URL,
  RELAYONE_MAX_REQUEST_IMAGE_BYTES,
  RELAYONE_MESSAGES_URL,
  RELAYONE_RESPONSES_URL,
  relayOneHeaders,
  relayOneSafeDetail,
} from './types.ts'
import {
  buildRelayOneResponsesRequest,
  buildRelayOneChatRequest,
  createRelayOneChatStreamState,
  processRelayOneChatLine,
  assertRelayOneChatStreamComplete,
  closeRelayOneChatStream,
} from './mapper-openai.ts'
import {
  buildRelayOneAnthropicRequest,
  createRelayOneAnthropicStreamState,
  processRelayOneAnthropicLine,
  assertRelayOneAnthropicStreamComplete,
  closeRelayOneAnthropicStream,
} from './mapper-anthropic.ts'
import { outputReservation } from '../../common/output-reservation.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'SERVER', 'NETWORK', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.relayone.retry')

export interface RelayOneAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  promptCache?: PromptCacheOverride
  /**
   * The multi-key pool, when this line has one.
   *
   * Absent keeps the pre-pool behaviour exactly: one key from `store`, no
   * rotation. Present makes every chat request resolve a key through the pool
   * and rotate on a rejection or a 429.
   */
  accountPool?: RelayOneAccountPool | null
}

/** How long one key is rested after RelayOne answers 429 for it. */
const RELAYONE_COOLDOWN_MS = 60_000
interface ClassifiedError extends LlmError {
  status?: number
  relayOneStatus?: number
  relayOneDetail?: string
}

function protocolUrl(protocol: RelayOneProtocol): string {
  return protocol === 'openai-responses' ? RELAYONE_RESPONSES_URL
    : protocol === 'anthropic' ? RELAYONE_MESSAGES_URL : RELAYONE_CHAT_URL
}

export async function classifyRelayOneResponse(response: Response, apiKey?: string): Promise<ClassifiedError> {
  const detail = relayOneSafeDetail(await response.text().catch(() => ''), apiKey)
  const options = { status: response.status }
  let error: ClassifiedError
  if (isHttpContextOverflow(response.status, detail)) error = new LlmError('RelayOne context window exceeded: ' + detail, CONTEXT_OVERFLOW_CODE, options)
  else if (response.status === 401 || response.status === 403) error = new LlmError('RelayOne rejected the API key or its group permissions: ' + detail, 'AUTH', options)
  else if (response.status === 404) error = new LlmError('RelayOne model or endpoint was not found: ' + detail, 'NOT_FOUND', options)
  else if (response.status === 429) error = new LlmError('RelayOne rate limit reached: ' + detail, 'RATE_LIMIT', options)
  else if (response.status >= 500) error = new LlmError('RelayOne upstream service error (' + response.status + '): ' + detail, 'SERVER_ERROR', options)
  else error = new LlmError('RelayOne request failed (' + response.status + '): ' + detail, 'PROVIDER_ERROR', options)
  error.relayOneStatus = response.status
  error.relayOneDetail = detail
  return error
}

export class RelayOneAdapter extends LlmAdapter {
  private readonly fetchFn: typeof fetch
  private readonly fallbacks = new Map<string, RelayOneProtocol>()
  /** The pool, when this line runs several keys; null means the single-key path. */
  private readonly pool: RelayOneAccountPool | null
  constructor(
    private readonly store: RelayOneCredentialStore = new RelayOneCredentialStore(),
    private readonly settingsStore: RelayOneSettingsStore = new RelayOneSettingsStore(),
    private readonly catalog: RelayOneCatalogManager = new RelayOneCatalogManager(store),
    private readonly options: RelayOneAdapterOptions = {},
  ) {
    super()
    this.fetchFn = fetchWithContextBudgetRecovery(options.fetchFn ?? fetch)
    this.pool = options.accountPool ?? null
  }

  /**
   * Whether the line has any key at all.
   *
   * Through the pool this asks the pool, so an install that migrated its single
   * key into the pool is not reported as unconfigured by a `store` that the
   * mirror has not written yet.
   */
  private async hasCredential(): Promise<boolean> {
    if (this.pool !== null) return (await this.pool.anyCredential().catch(() => null)) !== null
    return (await this.store.read().catch(() => null)) !== null
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: localizedProviderName(provider, PROVIDER_NAME) }
  }
  providerRetryPolicy(): ResolvedRetryPolicy { return RETRY_POLICY }
  imageRequestPricing(): undefined { return undefined }
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) {
    return requestImageTargetOrOriginal(image)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const settings = await this.settingsStore.read()
    const configured = await this.hasCredential()
    await this.catalog.warm()
    if (!settings.enabled || !configured) return []
    return relayOneModelOptions(this.catalog.snapshot().entries, settings)
      .filter(model => model.kind === 'chat' && model.enabled)
      .map(model => ({
        provider: provider || PROVIDER_ID,
        id: model.id,
        name: model.name,
        inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('RelayOne model resolution was aborted.', 'ABORTED')
    const [settings] = await Promise.all([this.settingsStore.read(), this.catalog.warm()])
    const entry = resolveRelayOneModel(this.catalog.snapshot().entries, model)
    if (entry === undefined || entry.kind !== 'chat') {
      throw new LlmError('RelayOne model "' + model + '" is not in the current key catalog. Refresh the line settings.', 'NOT_FOUND')
    }
    const contextWindow = settings.contextWindowOverrides[model] ?? entry.contextWindow
    const configured = settings.defaultReasoningEffort
    const defaultEffort = configured !== null && entry.reasoningEfforts.includes(configured)
      ? ReasoningEffortId(configured) : undefined
    return {
      provider, id: entry.id, name: entry.name,
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      ...outputReservation(contextWindow, entry.maxOutputTokens),
      ...(entry.reasoningEfforts.length === 0 ? {} : {
        reasoning: {
          efforts: entry.reasoningEfforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        },
      }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    const entry = resolveRelayOneModel(this.catalog.snapshot().entries, resolved.id)!
    return { model: resolved, stream: options => this.streamWithEntry(options, entry) }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.catalog.warm()
    const entry = resolveRelayOneModel(this.catalog.snapshot().entries, options.model)
    if (entry === undefined || entry.kind !== 'chat') throw new LlmError('RelayOne model is absent from the current key catalog.', 'NOT_FOUND')
    yield* this.streamWithEntry(options, entry)
  }

  private async *streamWithEntry(rawOptions: GenerateOptions, entry: RelayOneModelEntry): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (signal, activity) => this.requestStream(rawOptions, entry, signal, activity),
      rawOptions.signal, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE, PROVIDER_NAME,
    )
  }

  private buildRequest(
    protocol: RelayOneProtocol,
    options: ReturnType<typeof normalizeGenerateOptions>,
    images: ResolvedRequestImages,
    entry: RelayOneModelEntry,
    settings: Awaited<ReturnType<RelayOneSettingsStore['read']>>,
    sessionKey: string | undefined,
  ): Record<string, unknown> {
    // New API's reference affinity rules read prompt_cache_key on Responses and metadata.user_id
    // on Messages. Most other Chat-compatible vendors do not declare the OpenAI cache-key field.
    if (protocol === 'anthropic') {
      const body = buildRelayOneAnthropicRequest(options, images, entry, settings)
      if (sessionKey !== undefined) body.metadata = { user_id: sessionKey }
      return body
    }
    const responses = protocol === 'openai-responses'
    const body = responses ? buildRelayOneResponsesRequest(options, images, entry, settings)
      : buildRelayOneChatRequest(options, images, entry, settings)
    if (sessionKey !== undefined && (responses || isRelayOneOpenAIModel(entry.id, entry.vendor))) body.prompt_cache_key = sessionKey
    return body
  }

  private async openRequest(
    protocol: RelayOneProtocol,
    body: Record<string, unknown>,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchFn(protocolUrl(protocol), {
        method: 'POST',
        headers: {
          ...relayOneHeaders(apiKey),
          accept: 'text/event-stream',
          ...(protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new LlmError('RelayOne request was aborted.', 'ABORTED')
      throw new LlmError('RelayOne request failed: ' + relayOneSafeDetail(error, apiKey), 'TRANSPORT')
    }
    if (!response.ok) throw await classifyRelayOneResponse(response, apiKey)
    return response
  }

  /**
   * Resolve the key that serves this request.
   *
   * The pool answers with the key the user selected — there is no rotation, so
   * this is stable across requests until the selection changes. A refusal still
   * marks the account, so the card can show which key is bad and offer the next
   * one, but it never retries on a different key behind the user's back.
   */
  private async resolveKey(): Promise<{ apiKey: string; accountId: string | null }> {
    if (this.pool === null) {
      const credentials = await this.store.read()
      if (credentials === null) throw new LlmError('RelayOne API key is not configured.', 'MISSING_CREDENTIAL')
      return { apiKey: credentials.apiKey, accountId: null }
    }
    const effective = await this.pool.getEffectiveCredential(undefined, this.fetchFn)
    return { apiKey: effective.credentials.apiKey, accountId: effective.account.id }
  }

  /**
   * Record what an upstream refusal means for the key that got it.
   *
   * Only a status that names this key is a verdict about this key: 401 and 403
   * mean it is refused, 429 means its allowance is spent for now. Every other
   * status is about the request and would fail identically on any key, so it is
   * left to the harness retry policy.
   */
  private async noteAccountVerdict(accountId: string | null, error: ClassifiedError): Promise<void> {
    if (this.pool === null || accountId === null) return
    const status = error.relayOneStatus ?? error.status ?? 0
    if (status === 401 || status === 403) {
      await this.pool.markAuthFailed(accountId, 'RelayOne 拒绝了这个 API Key（' + status + '）。', 'invalid')
        .catch(() => undefined)
      return
    }
    if (status === 429) {
      await this.pool.markCooldown(accountId, RELAYONE_COOLDOWN_MS, 'RelayOne 429').catch(() => undefined)
    }
  }

  private async *requestStream(
    rawOptions: GenerateOptions,
    entry: RelayOneModelEntry,
    signal: AbortSignal,
    activity?: StreamActivity,
  ): AsyncGenerator<StreamChunk> {
    const settings = await this.settingsStore.read()
    const { apiKey: key, accountId } = await this.resolveKey()
    const credentials: RelayOneCredentials = { apiKey: key, authenticatedAt: 0 }
    const normalized = withStaticPrefixOrdering(PROVIDER_ID, normalizeGenerateOptions(rawOptions), this.options.promptCache)
    const images = await resolveRequestImages(normalized, this.options.attachments, signal)
    const requestOptions = offloadOldestRequestImages(normalized, RELAYONE_MAX_REQUEST_IMAGE_BYTES, images)
    const scope = relayOneCredentialFingerprint(credentials)
    // Never generate a random fallback or key on prompt content: a retry, tool reply, or
    // compaction belongs to the same DSH session. Do not send its local ID to the gateway.
    const sessionId = requestOptions.sessionId?.trim()
    const sessionKey = sessionId && !isAuxiliaryRequest(requestOptions)
      && !requestOptions.messages.some(message => String(message.source?.kind) === 'dsh-session-title-llm')
      && promptCachePolicyOf(PROVIDER_ID, this.options.promptCache).mode !== 'none'
      ? stableSessionId(JSON.stringify([PROVIDER_ID, scope, entry.id, sessionId])) : undefined
    const primary = entry.protocol
    if (primary === null) throw new LlmError('RelayOne selected a media-only model for a chat request.', 'NOT_FOUND')
    const fallbackKey = scope + ':' + entry.id + ':' + primary
    let protocol = this.fallbacks.get(fallbackKey) ?? primary
    let body = this.buildRequest(protocol, requestOptions, images, entry, settings, sessionKey)
    let response: Response
    try {
      response = await this.openRequest(protocol, body, key, signal)
    } catch (error) {
      const classified = error as ClassifiedError
      // The selected key refused the request. Record what that means for it, so
      // the card can show the state, but do NOT retry on another key: the user
      // chose this one, and spending a different account silently is the
      // behaviour this line deliberately does not have.
      await this.noteAccountVerdict(accountId, classified)
      const fallback = fallbackRelayOneProtocol(entry, protocol)
      if (fallback === null || protocol !== primary
        || !isRelayOneProtocolUnsupported(classified.relayOneStatus ?? classified.status ?? 0, classified.relayOneDetail ?? '')) throw error
      this.fallbacks.set(fallbackKey, fallback)
      protocol = fallback
      body = this.buildRequest(protocol, requestOptions, images, entry, settings, sessionKey)
      response = await this.openRequest(protocol, body, key, signal)
    }
    if (accountId !== null && this.pool !== null) await this.pool.recordModel(accountId, entry.id).catch(() => undefined)
    activity?.pulse()
    if (protocol === 'openai-responses') {
      try {
        yield* parseResponsesStream(response, signal, undefined, activity)
      } catch (error) {
        if (error instanceof LlmError && /Codex|ChatGPT/.test(error.message)) {
          throw new LlmError(error.message.replace(/Codex|ChatGPT/g, 'RelayOne'), error.code, { cause: error })
        }
        throw error
      } finally {
        await response.body?.cancel().catch(() => undefined)
      }
      return
    }
    if (response.body === null) throw new LlmError('RelayOne returned no response stream.', 'PROVIDER_ERROR')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = protocol === 'openai-chat' ? createRelayOneChatStreamState() : createRelayOneAnthropicStreamState()
    let buffer = ''
    const process = (line: string): StreamChunk[] => protocol === 'openai-chat'
      ? processRelayOneChatLine(line, state as ReturnType<typeof createRelayOneChatStreamState>)
      : processRelayOneAnthropicLine(line, state as ReturnType<typeof createRelayOneAnthropicStreamState>)
    const finished = (): boolean => state.finished
    try {
      while (!finished()) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined && value.byteLength > 0) activity?.pulse()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          activity?.pulse()
          for (const chunk of process(line)) yield chunk
          if (finished()) break
        }
      }
      if (!finished()) {
        buffer += decoder.decode()
        if (buffer.trim() !== '') for (const line of buffer.split('\n')) for (const chunk of process(line)) yield chunk
      }
      if (!finished()) {
        if (protocol === 'openai-chat') assertRelayOneChatStreamComplete(state as ReturnType<typeof createRelayOneChatStreamState>)
        else assertRelayOneAnthropicStreamComplete(state as ReturnType<typeof createRelayOneAnthropicStreamState>)
        const chunks = protocol === 'openai-chat'
          ? closeRelayOneChatStream(state as ReturnType<typeof createRelayOneChatStreamState>)
          : closeRelayOneAnthropicStream(state as ReturnType<typeof createRelayOneAnthropicStreamState>)
        for (const chunk of chunks) yield chunk
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
}

export { PROVIDER_ID, PROVIDER_NAME }
