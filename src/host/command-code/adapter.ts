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
  PLUGIN_USER_AGENT,
  PROVIDER_ID,
  PROVIDER_NAME,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  inputModalitiesFor,
  maxOutputTokensFor,
  providerUrl,
  reasoningEffortsFor,
  resolveApiEnv,
  wireForModel,
} from './types.ts'
import type { CommandCodeApiEnv } from '../../shared/command-code-contracts.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type CommandCodeCatalogModel,
  type CommandCodePreferenceStore,
} from './token-store.ts'
import { CommandCodeAccountPool } from './account-pool.ts'
import { commandCodeHeaders, loadProviderModels } from './client.ts'
import {
  assertStreamComplete,
  buildRequest,
  closeStream,
  createStreamState,
  offloadOldestRequestImages,
  processAnthropicStreamLine,
  processOpenAIStreamLine,
  resolveRequestImages,
  type AttachmentImageReader,
  type CommandCodeStreamState,
} from './mapper.ts'
import { normalizeGenerateOptions } from '../common/llm-compat.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'
import { retryAfterMs } from '../wire-auth.ts'

/**
 * Transient-failure retry policy for the `command-code` route.
 *
 * Command Code fronts several upstream model providers, so a call can fail with
 * an upstream 502/503/504 (typically `{"error":{"type":"server_error"}}`)
 * while the account and the API key stay perfectly usable. Those failures are
 * classified as `SERVER` and given bounded exponential backoff, mirroring the
 * `codex-chatgpt` route; without an explicit policy the DSH normal defaults
 * would apply anyway, and stating it here pins their exact values so the route
 * never retries less than the rest of the plugin. Codes deliberately outside
 * the set: `INVALID_CREDENTIAL` (a rejected key fails identically on every
 * attempt) and `ABORTED` (the caller already cancelled).
 */
const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.command-code.retry')

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

export interface CommandCodeAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  /** Live catalog loader seam; defaults to the public `/provider/v1/models` call. */
  loadCatalog?: () => Promise<CommandCodeCatalogModel[]>
}

/** Cooldown one rate-limited key takes when the provider states no delay. */
const POOL_COOLDOWN_MS = 15 * 60_000

export class CommandCodeAdapter extends LlmAdapter {
  /**
   * Rotation pool, or null for the single stored key.
   *
   * The pool is only ever installed by the plugin entry, which owns its storage.
   * An adapter built without one must keep reading the one credential file and
   * must not create pool state on its own: that state outlives the process and
   * would leak cooldowns between unrelated runs.
   */
  private readonly accountPool: CommandCodeAccountPool | null

  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: CommandCodePreferenceStore,
    private readonly options: CommandCodeAdapterOptions = {},
    accountPool?: CommandCodeAccountPool,
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
   * Catalog for the picker: the live Command Code listing when reachable, the
   * shipped fallback otherwise, narrowed by the user's enabled selection.
   */
  private async catalog(): Promise<CommandCodeCatalogModel[]> {
    const load = this.options.loadCatalog
      ?? (() => loadProviderModels({ fetchFn: this.options.fetchFn, apiEnv: resolveApiEnv() }))
    const live = await load().catch(() => [])
    if (live.length > 0) return live
    return FALLBACK_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    }))
  }

  private contextWindowFor(
    modelId: string,
    entry: CommandCodeCatalogModel | undefined,
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
      inputModalities: inputModalitiesFor(model.id),
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('Command Code model resolution aborted', 'ABORTED')
    const settings = await this.settings()
    const catalog = await this.catalog()
    const entry = catalog.find((model) => model.id === modelId)
    const efforts = reasoningEffortsFor(modelId)
    const defaultEffortId = resolveDefaultReasoningEffort(efforts, settings.defaultReasoningEffort)

    return {
      provider,
      id: modelId,
      name: entry?.name ?? modelId,
      inputModalities: inputModalitiesFor(modelId),
      context: { contextWindow: this.contextWindowFor(modelId, entry, settings.contextWindowOverrides) },
      defaultMaxTokens: maxOutputTokensFor(modelId),
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

    const wire = wireForModel(options.model)
    // DSH delivers pasted images as durable references because this route
    // declares image input; both wires need bytes, so resolve them once up
    // front and reuse the result for every attempt below.
    const requestOptions = offloadOldestRequestImages(normalizeGenerateOptions(options))
    const images = await resolveRequestImages(requestOptions, this.options.attachments, signal)
    const body = JSON.stringify(buildRequest(requestOptions, wire, images))

    // Account rotation. The payload is key-independent, so it is built once and
    // replayed unchanged while another key in the pool can still serve it: a
    // rate-limited or rejected key ends its part of the turn, not the turn.
    const pool = this.accountPool
    const tried = new Set<string>()
    let response: Response | undefined
    let detail = ''
    let accountId: string | undefined

    while (true) {
      let apiKey: string
      let apiEnv: CommandCodeApiEnv
      if (pool === null) {
        const credentials = await this.store.read()
        if (credentials === null) {
          throw new LlmError(
            `Not signed in to ${PROVIDER_NAME}. Sign in from Settings > Command Code, or paste an API key there.`,
            'MISSING_CREDENTIAL',
          )
        }
        apiKey = credentials.apiKey
        apiEnv = credentials.apiEnv ?? resolveApiEnv()
      } else {
        const effective = await pool.getEffectiveCredential(tried, fetchFn)
        accountId = effective.account.id
        tried.add(accountId)
        apiKey = effective.credentials.apiKey
        apiEnv = effective.apiEnv
      }

      const endpoint = `${providerUrl(apiEnv)}${wire === 'anthropic' ? '/messages' : '/chat/completions'}`
      const headers = wire === 'anthropic'
        ? {
            ...commandCodeHeaders(apiKey),
            'user-agent': PLUGIN_USER_AGENT,
            accept: 'text/event-stream',
            'anthropic-version': '2023-06-01',
          }
        : {
            ...commandCodeHeaders(apiKey),
            'user-agent': PLUGIN_USER_AGENT,
            accept: 'text/event-stream',
          }

      try {
        response = await fetchFn(endpoint, { method: 'POST', headers, body, signal })
      } catch (error) {
        if (signal.aborted) throw new LlmError('Command Code request aborted', 'ABORTED', { cause: error })
        // A connection that never produced a response is a transport failure, not
        // a verdict from the provider: the same request is eligible for the
        // bounded backoff above instead of failing the turn outright.
        throw new LlmError(
          `Command Code request failed: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT',
          { cause: error },
        )
      }

      if (response.ok) break
      // The body is read here rather than later: a retried attempt needs the
      // detail of the attempt that actually failed.
      detail = (await response.text().catch(() => '')).slice(0, 600)
      // Without a pool there is nothing to rotate to; the classification below
      // reports the failure exactly as it did before the pool existed.
      if (pool === null || accountId === undefined) break

      if (response.status === 401 || response.status === 403) {
        // A rejected key is a permanent verdict for that account alone: keep the
        // account (signing in again restores it) but take it out of rotation.
        await pool.markAuthFailed(
          accountId,
          `${PROVIDER_NAME} rejected the stored API key (${response.status}).`,
          'invalid',
        ).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      if (response.status === 429) {
        const after = retryAfterMs(response.headers)
        await pool.markCooldown(accountId, after ?? POOL_COOLDOWN_MS, `${PROVIDER_NAME} 429`).catch(() => undefined)
        if (await pool.hasAnotherAvailableAccount(tried)) continue
        break
      }
      break
    }

    if (response === undefined || !response.ok) {
      const status = response?.status ?? 500
      if (status === 401 || status === 403) {
        throw new LlmError(
          `${PROVIDER_NAME} rejected the stored API key (${status}). Sign in again from Settings > Command Code.${detail ? ` ${detail}` : ''}`,
          'INVALID_CREDENTIAL',
          { status },
        )
      }
      if (status === 429) {
        // A provider-requested delay is honored verbatim by the DSH retry
        // policy; omitting it leaves the bounded local backoff in charge.
        const after = response === undefined ? undefined : retryAfterMs(response.headers)
        throw new LlmError(
          `${PROVIDER_NAME} rate limit or plan quota reached (429). Check the quota card in Settings > Command Code.${detail ? ` ${detail}` : ''}`,
          'RATE_LIMIT',
          { status: 429, ...(after === undefined ? {} : { providerRetryAfterMs: after }) },
        )
      }
      if (status >= 500) {
        // The API fronts several upstream model providers, so a 502/503/504
        // ("Upstream model provider is temporarily unavailable") says nothing
        // about this request or this credential: it is a transient server-side
        // failure and is retried under the bounded policy above.
        throw new LlmError(
          `${PROVIDER_NAME} upstream server error (${status}): ${detail || 'No response'}`,
          'SERVER',
          { status },
        )
      }
      throw new LlmError(
        `${PROVIDER_NAME} API error (${status}): ${detail || 'No response'}`,
        'PROVIDER_ERROR',
        { status },
      )
    }

    if (response.body === null) throw new LlmError('Command Code returned an empty response body', 'PROVIDER_ERROR')

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

function processLine(line: string, state: CommandCodeStreamState, wire: 'openai' | 'anthropic'): StreamChunk[] {
  return wire === 'anthropic'
    ? processAnthropicStreamLine(line, state)
    : processOpenAIStreamLine(line, state)
}
