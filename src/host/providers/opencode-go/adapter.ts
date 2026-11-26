import { LlmAdapter, ReasoningEffortId, resolveRetryPolicy, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { localizedProviderName } from '../../common/i18n/index.ts'
import { LlmError, normalizeGenerateOptions } from '../../common/llm-compat.ts'
import { CONTEXT_OVERFLOW_CODE, isHttpContextOverflow } from '../../common/context-overflow.ts'
import { fetchWithContextBudgetRecovery } from '../../common/context-budget-fetch.ts'
import { STREAM_IDLE_TIMEOUT_CODE, STREAM_IDLE_TIMEOUT_MS, wrapStreamWithWatchdog, type StreamActivity } from '../../common/idle-watchdog.ts'
import { outputReservation } from '../../common/output-reservation.ts'
import { requestImageTargetOrOriginal, resolveRequestImages, type AttachmentImageReader } from '../../common/request-images.ts'
import { withStaticPrefixOrdering } from '../../common/prefix-stability.ts'
import type { PromptCacheOverride } from '../../common/prompt-cache-policy.ts'
import { retryAfterMs } from '../../infra/network/wire-auth.ts'
import { SessionEffortMemory } from '../../common/session-effort-memory.ts'
import type { OpenCodeGoAccountPool, OpenCodeGoPoolAccount } from './account-pool.ts'
import { OpenCodeGoCatalogManager, openCodeGoModelOptions, resolveOpenCodeGoModel, type OpenCodeGoModelEntry } from './model-catalog.ts'
import { OpenCodeGoSettingsStore } from './token-store.ts'
import { OPENCODE_GO_COOLDOWN_MS, PROVIDER_ID, PROVIDER_NAME, opencodeGoHeaders, opencodeGoSessionId, type OpenCodeGoCredentials } from './types.ts'
import { offloadOldestOpenCodeGoRequestImages, openCodeGoPlanFromBillingSource } from './mapper.ts'
import { streamOpenCodeGoResponses } from './mapper-responses.ts'
import { streamOpenCodeGoGeminiResponse } from './mapper-gemini.ts'
import { createOpenCodeGoLineDriver, isOpenCodeGoProtocolUnsupported, openCodeGoProtocolTarget } from './protocol.ts'

const RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], backoff: { initialDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2 } }, 'dsh-chatgpt-subscription.opencode-go.retry')

export interface OpenCodeGoAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  accountPool?: OpenCodeGoAccountPool | null
  promptCache?: PromptCacheOverride
}

export function classifyOpenCodeGoFailure(status: number, detail: string): LlmError {
  const options = { status }
  if (isHttpContextOverflow(status, detail)) return new LlmError('OpenCode Go context window exceeded: ' + detail, CONTEXT_OVERFLOW_CODE, options)
  if (status === 401) return new LlmError('OpenCode Go rejected the API key: ' + detail, 'INVALID_CREDENTIAL', options)
  if (status === 403) return new LlmError('OpenCode Go workspace, region or plan permission denied: ' + detail, 'PROVIDER_ERROR', options)
  if (status === 404) return new LlmError('OpenCode Go model or endpoint was not found: ' + detail, 'NOT_FOUND', options)
  if (status === 429) return new LlmError('OpenCode Go rate limit reached: ' + detail, 'RATE_LIMIT', options)
  if (status >= 500) return new LlmError('OpenCode Go upstream service error (' + status + '): ' + detail, 'SERVER', options)
  return new LlmError('OpenCode Go request failed (' + status + '): ' + detail, 'PROVIDER_ERROR', options)
}

export class OpenCodeGoAdapter extends LlmAdapter {
  private readonly pool: OpenCodeGoAccountPool | null
  private readonly settingsStore: OpenCodeGoSettingsStore
  private readonly catalog: OpenCodeGoCatalogManager
  private readonly options: OpenCodeGoAdapterOptions
  /** An auxiliary request names no effort; this lets it reuse the session's level so the prefix cache still hits. */
  private readonly effortMemory = new SessionEffortMemory()
  constructor(settingsStore: OpenCodeGoSettingsStore = new OpenCodeGoSettingsStore(), catalog: OpenCodeGoCatalogManager = new OpenCodeGoCatalogManager(), options: OpenCodeGoAdapterOptions = {}) {
    super()
    this.settingsStore = settingsStore
    this.catalog = catalog
    this.options = options
    this.pool = options.accountPool ?? null
  }

  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: localizedProviderName(provider, PROVIDER_NAME) } }
  providerRetryPolicy(): ResolvedRetryPolicy { return RETRY_POLICY }
  imageRequestPricing(): undefined { return undefined }
  imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef) { return requestImageTargetOrOriginal(image) }

  private async hasCredential(): Promise<boolean> {
    if (this.pool === null) return false
    const data = await this.pool.read().catch(() => null)
    return (data?.accounts.length ?? 0) > 0
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const settings = await this.settingsStore.read()
    if (!settings.enabled || this.pool === null || !(await this.hasCredential())) return []
    const target = await this.pool.getEffectiveCredential(undefined, this.options.fetchFn ?? fetch, { preferAccountIds: settings.selectedAccountId === null ? undefined : [settings.selectedAccountId] })
    const entries = await this.catalog.warm(target, this.options.fetchFn ?? fetch)
    return openCodeGoModelOptions(entries, settings).filter(model => model.enabled).map(model => ({ provider: provider || PROVIDER_ID, id: model.id, name: model.name, inputModalities: model.supportsImages ? ['text', 'image'] : ['text'] }))
  }

  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('OpenCode Go model resolution was aborted.', 'ABORTED')
    if (this.pool === null) throw new LlmError('OpenCode Go is not configured.', 'MISSING_CREDENTIAL')
    const settings = await this.settingsStore.read()
    const target = await this.pool.getEffectiveCredential(undefined, this.options.fetchFn ?? fetch, { preferAccountIds: settings.selectedAccountId === null ? undefined : [settings.selectedAccountId] })
    const entries = await this.catalog.warm(target, this.options.fetchFn ?? fetch)
    const entry = resolveOpenCodeGoModel(entries, model)
    const contextWindow = settings.contextWindowOverrides[model] ?? entry.contextWindow
    const configured = settings.defaultReasoningEffort
    const defaultEffort = configured !== null && entry.reasoningEfforts.includes(configured) ? ReasoningEffortId(configured) : undefined
    return {
      provider, id: entry.id, name: entry.name,
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      ...outputReservation(contextWindow, entry.maxOutputTokens),
      ...(entry.reasoningEfforts.length === 0 ? {} : { reasoning: { efforts: entry.reasoningEfforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })), ...(defaultEffort === undefined ? {} : { defaultEffort }) } }),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    return { model: resolved, stream: options => this.stream(options) }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const followed = this.effortMemory.follow(options)
    yield* wrapStreamWithWatchdog((signal, activity) => this.requestStream(followed, signal, activity), options.signal, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE, PROVIDER_NAME)
  }

  private async *requestStream(options: GenerateOptions, signal: AbortSignal, activity?: StreamActivity): AsyncGenerator<StreamChunk> {
    if (this.pool === null) throw new LlmError('OpenCode Go is not configured.', 'MISSING_CREDENTIAL')
    const settings = await this.settingsStore.read()
    const normalized = withStaticPrefixOrdering(PROVIDER_ID, normalizeGenerateOptions(options), this.options.promptCache)
    const images = await resolveRequestImages(normalized, this.options.attachments, signal)
    const requestOptions = offloadOldestOpenCodeGoRequestImages(normalized, images)
    const tried = new Set<string>()
    const allowanceModel = this.catalog.snapshot().entries.find(entry => entry.id === options.model)
    let produced = false

    while (true) {
      const picked = await this.pool.getEffectiveCredential(tried, this.options.fetchFn ?? fetch, {
        preferAccountIds: settings.selectedAccountId === null ? undefined : [settings.selectedAccountId],
        ...(allowanceModel === undefined ? {} : { model: allowanceModel }),
      })
      tried.add(picked.account.id)
      const entries = await this.catalog.warm(picked, this.options.fetchFn ?? fetch)
      const entry = resolveOpenCodeGoModel(entries, options.model)
      const sessionId = opencodeGoSessionId(options.sessionId, picked.account.id)
      let protocol = entry.protocol
      let response: Response
      try {
        for (;;) {
          const target = openCodeGoProtocolTarget(protocol, requestOptions, images, entry, settings)
          response = await fetchWithContextBudgetRecovery(this.options.fetchFn ?? fetch)(target.url, {
            method: 'POST',
            headers: { ...opencodeGoHeaders(picked.credentials, sessionId), accept: 'text/event-stream' },
            body: JSON.stringify(target.body), signal,
          })
          if (protocol !== 'chat-completions' && !response.ok) {
            const detail = await response.clone().text().catch(() => '')
            if (isOpenCodeGoProtocolUnsupported(response.status, detail)) { protocol = 'chat-completions'; continue }
          }
          break
        }
        activity?.pulse()
      } catch (error) {
        if (signal.aborted) throw new LlmError('OpenCode Go request was aborted.', 'ABORTED', { cause: error })
        throw new LlmError('OpenCode Go request failed: ' + (error instanceof Error ? error.message : String(error)), 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 600)
        const failure = classifyOpenCodeGoFailure(response.status, detail)
        if (response.status === 401) {
          await this.pool.markAuthFailed(picked.account.id, failure.message).catch(() => undefined)
          if (!produced && await this.pool.hasAnotherAvailableAccount(tried)) continue
        }
        if (response.status === 429) {
          await this.pool.markCooldown(picked.account.id, retryAfterMs(response.headers) ?? OPENCODE_GO_COOLDOWN_MS, failure.message).catch(() => undefined)
          if (!produced && await this.pool.hasAnotherAvailableAccount(tried)) continue
        }
        throw failure
      }
      if (protocol === 'responses') {
        let billingSource: string | null = null
        let allowance: number | null = null
        for await (const chunk of streamOpenCodeGoResponses(response, signal, activity, metadata => {
          billingSource = metadata?.billingSource ?? null
          allowance = metadata?.allowance ?? null
        })) { produced = true; yield chunk }
        await this.finishAccount(picked.account, entry, billingSource, allowance)
        return
      }
      if (protocol === 'generate-content') {
        let billingSource: string | null = null
        let allowance: number | null = null
        for await (const chunk of streamOpenCodeGoGeminiResponse(response, signal, activity, metadata => {
          billingSource = metadata?.billingSource ?? null
          allowance = metadata?.allowance ?? null
        })) { produced = true; yield chunk }
        await this.finishAccount(picked.account, entry, billingSource, allowance)
        return
      }
      if (response.body === null) throw new LlmError('OpenCode Go returned an empty response body.', 'PROVIDER_ERROR')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const driver = createOpenCodeGoLineDriver(protocol)
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined && value.byteLength > 0) activity?.pulse()
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            activity?.pulse()
            for (const chunk of driver.process(line)) { produced = true; yield chunk }
            if (driver.finished()) {
              await this.finishAccount(picked.account, entry, driver.billingSource(), driver.allowance())
              return
            }
          }
        }
        buffer += decoder.decode()
        if (buffer.trim() !== '') for (const line of buffer.split('\n')) for (const chunk of driver.process(line)) { produced = true; yield chunk }
        if (!driver.finished()) {
          driver.assertComplete()
          for (const chunk of driver.close()) { produced = true; yield chunk }
        }
        await this.finishAccount(picked.account, entry, driver.billingSource(), driver.allowance())
        return
      } finally {
        void reader.cancel().catch(() => undefined)
      }
    }
  }

  private async finishAccount(account: OpenCodeGoPoolAccount, entry: OpenCodeGoModelEntry, billingSource: string | null, allowance: number | null): Promise<void> {
    if (this.pool === null) return
    await this.pool.recordModel(account.id, entry.id)
    const plan = openCodeGoPlanFromBillingSource(billingSource)
    if (plan !== undefined) await this.pool.recordPlan(account.id, plan)
    if (allowance !== null) await this.pool.recordAllowance(account.id, entry, allowance, plan)
  }
}

export { PROVIDER_ID, PROVIDER_NAME }
