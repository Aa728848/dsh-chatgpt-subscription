import { outputReservation } from '../common/output-reservation.ts'
import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FALLBACK_MODELS,
  POOL_COOLDOWN_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  contextWindowFor,
  wireForModel,
  type OllamaCatalogModel,
} from './types.ts'
import { FileCredentialStore, FileModelSettingsStore, type OllamaCredentials } from './token-store.ts'
import { OllamaAccountPool } from './account-pool.ts'
import { loadCatalog, startChat, type OllamaChatMessage, type OllamaRequest } from './client.ts'
import { applyEvent, closeStream, createStreamState } from './mapper.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'
import {
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
} from '../command-code/types.ts'

/**
 * Retry policy for the `ollama` route.
 *
 * A 5xx from a shared inference service says nothing about this key, so it is
 * classified as `SERVER` and given the same bounded backoff the other lines use.
 * Deliberately outside the set: `INVALID_CREDENTIAL` (a rejected key fails
 * identically every time, and the pool rotates past it instead) and `ABORTED`.
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.ollama.retry')

export interface OllamaAdapterOptions {
  fetchFn?: typeof fetch
  /** Test seam; production reads `/api/tags` with the active account's key. */
  loadCatalog?: (fetchFn: typeof fetch, credentials: OllamaCredentials) => Promise<OllamaCatalogModel[]>
}

export class OllamaAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored key.
   *
   * Only the plugin entry installs it, because the entry owns the storage; an
   * adapter built without one must keep reading the one credential file rather
   * than minting pool state that would outlive the process.
   */
  private readonly accountPool: OllamaAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly options: OllamaAdapterOptions = {},
    accountPool?: OllamaAccountPool,
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
    return this.modelSettings.read()
  }

  /**
   * Catalog for the picker: the live `/api/tags` listing when a key can reach it,
   * the shipped fallback otherwise, narrowed by the user's enabled selection.
   *
   * Ollama's model set moves quickly, so a stale local table would be the wrong
   * default; the fallback exists only so the line is usable before the first
   * successful sync.
   */
  private async catalog(): Promise<OllamaCatalogModel[]> {
    const load = this.options.loadCatalog ?? loadCatalog
    const fetchFn = this.options.fetchFn ?? fetch
    const credentials = await this.anyCredentials()
    if (credentials !== null) {
      const live = await load(fetchFn, credentials).catch(() => [])
      if (live.length > 0) {
        // Persist the sync so a later offline start still sees the last good list.
        await this.modelSettings.storeCatalog(live).catch(() => undefined)
        return live
      }
    }
    const cached = this.modelSettings.status().catalogModels
    if (cached.length > 0) return cached
    return [...FALLBACK_MODELS]
  }

  /** Any usable key, for the catalog call; the pool decides real routing later. */
  private async anyCredentials(): Promise<OllamaCredentials | null> {
    if (this.accountPool !== null) {
      const effective = await this.accountPool.getEffectiveCredential(new Set(), this.options.fetchFn ?? fetch)
        .catch(() => null)
      return effective?.credentials ?? null
    }
    return this.store.read().catch(() => null)
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = await this.settings()
    if (settings.enabled === false) return []
    const catalog = await this.catalog()
    const enabled = new Set(settings.enabledModelIds)
    // An empty selection means "whatever the catalog returned", which is what a
    // user sees before narrowing it; a non-empty one is an explicit filter.
    const available = settings.enabledModelIds.length === 0
      ? catalog
      : catalog.filter((model) => enabled.has(model.id))
    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name ?? model.id,
      // Ollama cloud models take images on the OpenAI surface; the native surface
      // is text-only for the same models, and the mapper sends bytes only when a
      // request actually has them.
      inputModalities: ['text', 'image'],
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Ollama model resolution aborted', 'ABORTED')
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: ['text', 'image'],
      context: { contextWindow: contextWindowFor(entry) },
      // Ollama does not publish a per-model output ceiling, so this is a request
      // level default rather than a claim about the model.
      ...outputReservation(contextWindowFor(entry), DEFAULT_MAX_OUTPUT_TOKENS),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(options, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      PROVIDER_NAME,
    )
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const fetchFn = this.options.fetchFn ?? fetch
    const wire = wireForModel(options.model)
    const request = toOllamaRequest(options)

    // Account rotation. The payload is key-independent, so it is built once and
    // replayed unchanged while another key can still serve it: a rate-limited or
    // rejected key ends its part of the turn, not the turn.
    const pool = this.accountPool
    const tried = new Set<string>()
    let lastStatus: number | undefined
    let lastDetail = ''
    let accountId: string | undefined

    for (;;) {
      let credentials: OllamaCredentials
      if (pool === null) {
        const stored = await this.store.read()
        if (stored === null) {
          throw new LlmError(
            `No ${PROVIDER_NAME} API key configured. Add one from Settings > ${PROVIDER_NAME} (create a key at https://ollama.com/settings/keys).`,
            'MISSING_CREDENTIAL',
          )
        }
        credentials = stored
      } else {
        const effective = await pool.getEffectiveCredential(tried, fetchFn)
        accountId = effective.account.id
        tried.add(accountId)
        credentials = effective.credentials
      }

      const call = startChat(fetchFn, credentials, wire, { ...request, signal })
      const state = createStreamState()
      let opened = false
      let openedStatus: number | undefined
      void call.status.then((value) => {
        opened = true
        openedStatus = value
      })

      // Collected here and recorded only once the turn completes, so a stream
      // that dies part-way does not leave a half-turn counted against the key.
      let spent: { inputTokens: number; outputTokens: number } | null = null

      let failed = false
      for await (const event of call.events) {
        if (event.type === 'error') {
          lastStatus = openedStatus
          lastDetail = event.message
          failed = true
          break
        }
        if (event.type === 'usage') {
          spent = event.usage
          continue
        }
        if (event.type === 'text' || event.type === 'tool_call') {
          for (const chunk of applyEvent(state, event)) yield chunk
          continue
        }
      }
      // A completed turn, including one that legitimately ended on a tool call.
      if (!failed) {
        // Close whatever the stream left open before the turn ends, so a model
        // cut off mid-sentence still yields the text that did arrive.
        for (const chunk of closeStream(state)) yield chunk
        // Counted against the key that actually served the turn, after it
        // completed, and best-effort: a lost count must never fail a reply.
        if (pool !== null && accountId !== undefined && spent !== null) {
          await pool.recordUsage(accountId, spent.inputTokens, spent.outputTokens)
        }
        return
      }

      if (pool === null || accountId === undefined) break
      // Only a status that names this account is a verdict about this account.
      // Anything else is about the request and the same key would fail again.
      if (lastStatus === 401 || lastStatus === 403) {
        await pool.markAuthFailed(
          accountId,
          `${PROVIDER_NAME} rejected the API key (${lastStatus}).`,
          'invalid',
        ).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      if (lastStatus === 429) {
        await pool.markCooldown(accountId, POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      break
    }

    const status = lastStatus
    if (status === 401 || status === 403) {
      throw new LlmError(
        `${PROVIDER_NAME} rejected the API key (${status}). Replace it from Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'INVALID_CREDENTIAL',
        { status },
      )
    }
    if (status === 429) {
      throw new LlmError(
        `${PROVIDER_NAME} rate limit or plan quota reached (429). Add another key, or wait for the cooldown shown in Settings > ${PROVIDER_NAME}.${lastDetail ? ` ${lastDetail}` : ''}`,
        'RATE_LIMIT',
        { status: 429 },
      )
    }
    throw new LlmError(
      `${PROVIDER_NAME} request failed${status === undefined ? '' : ` (${status})`}.${lastDetail}`,
      status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
      status === undefined ? {} : { status },
    )
  }
}

/** Project DSH's request shape onto Ollama's, per surface. */
export function toOllamaRequest(options: GenerateOptions): Omit<OllamaRequest, 'signal'> {
  const messages: OllamaChatMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        content: textOf(message.content),
        // The result has to name the call it answers, or the next turn's call
        // history is unpaired and the model repeats itself.
        toolCallId: message.toolCallId,
      })
      continue
    }
    const toolCalls = assistantToolCalls(message.content)
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: textOf(message.content), toolCalls })
      continue
    }
    // DSH can carry a 'developer' role; both Ollama surfaces take it as a system
    // instruction, and sending an unknown role is rejected outright.
    messages.push({
      role: message.role === 'developer' ? 'system' : message.role,
      content: textOf(message.content),
    })
  }
  const request: Omit<OllamaRequest, 'signal'> = { model: options.model, messages }
  if (options.maxTokens !== undefined) request.maxOutputTokens = options.maxTokens
  if (options.temperature !== undefined) request.temperature = options.temperature
  const tools = options.tools
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  return request
}

/** Tool calls an assistant turn carries, read from its content blocks. */
function assistantToolCalls(content: unknown): { id: string; name: string; arguments: string }[] {
  if (!Array.isArray(content)) return []
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (fields.type !== 'tool-call') continue
    const id = fields.id
    const name = fields.name
    if (typeof id !== 'string' || typeof name !== 'string') continue
    calls.push({
      id,
      name,
      arguments: typeof fields.arguments === 'string' ? fields.arguments : JSON.stringify(fields.arguments ?? {}),
    })
  }
  return calls
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') return text
        }
        return ''
      })
      .join('')
  }
  return ''
}
