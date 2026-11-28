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
import { localizedProviderName, t } from '../../common/i18n/index.ts'
import { fetchWithContextBudgetRecovery } from '../../common/context-budget-fetch.ts'
import { STREAM_IDLE_TIMEOUT_CODE, STREAM_IDLE_TIMEOUT_MS, wrapStreamWithWatchdog, type StreamActivity } from '../../common/idle-watchdog.ts'
import { LlmError, normalizeGenerateOptions, type GenerateOptions as NormalizedGenerateOptions } from '../../common/llm-compat.ts'
import { SessionEffortMemory } from '../../common/session-effort-memory.ts'
import { outputReservation } from '../../common/output-reservation.ts'
import { sharedPrefixGroupKey, withStaticPrefixOrdering } from '../../common/prefix-stability.ts'
import { promptCachePolicyOf, type PromptCacheOverride } from '../../common/prompt-cache-policy.ts'
import { fetchWithPrefixCoordination, PrefixRequestCoordinator } from '../../common/prefix-request-coordinator.ts'
import { promptCacheActivityStore } from '../../common/cache-activity.ts'
import { recordCacheWarmupUsage } from '../../runtime/cache-warmup/index.ts'
import { evaluateCacheHint } from '../../common/cache-hint.ts'
import { requestImageTargetOrOriginal, type AttachmentImageReader } from '../../common/request-images.ts'
import { catalogModelOptions, resolveQianwenModel } from './model-catalog.ts'
import { QianwenCredentialStore, QianwenSettingsStore } from './token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME, QIANWEN_CHAT_COMPLETIONS_URL, qianwenHeaders } from './types.ts'
import {
  assertQianwenStreamComplete,
  buildQianwenChatRequest,
  classifyQianwenFailure,
  closeQianwenStream,
  createQianwenStreamState,
  offloadOldestQianwenRequestImages,
  processQianwenStreamLine,
  readQianwenCacheUsage,
  resolveRequestImages,
} from './mapper.ts'
import { qianwenPromptTokens, recordQianwenCacheUsage } from './cache-stats.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'INVALID_TOOL_ARGUMENTS'],
  backoff: { initialDelayMs: 1500, maxDelayMs: 15000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.qianwen-token-plan.retry')
const prefixRequests = new PrefixRequestCoordinator({ waitMs: 2500 })
const activityStore = promptCacheActivityStore(PROVIDER_ID)
const ttlMs = (ttl: '5m' | '1h'): number => ttl === '1h' ? 60 * 60_000 : 5 * 60_000

export interface QianwenAdapterOptions {
  fetchFn?: typeof fetch
  attachments?: AttachmentImageReader
  promptCache?: PromptCacheOverride
}

export class QianwenTokenPlanAdapter extends LlmAdapter {
  private readonly store: QianwenCredentialStore
  private readonly settingsStore: QianwenSettingsStore
  private readonly options: QianwenAdapterOptions
  /** 把主回合的 effort 带给压缩/时间线/评审等辅助请求（否则前缀缓存整段失效）。 */
  private readonly effortMemory = new SessionEffortMemory()
  constructor(
    store: QianwenCredentialStore = new QianwenCredentialStore(),
    settingsStore: QianwenSettingsStore = new QianwenSettingsStore(),
    options: QianwenAdapterOptions = {},
  ) {
    super()
    this.store = store
    this.settingsStore = settingsStore
    this.options = options
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
    const credentials = await this.store.read().catch(() => null)
    if (!settings.enabled || credentials === null) return []
    return catalogModelOptions(settings).filter(model => model.enabled).map(model => ({
      provider: provider || PROVIDER_ID,
      id: model.id,
      name: model.name,
      inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
    }))
  }
  async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError(t('sc.modelResolveAborted', { provider: PROVIDER_NAME }), 'ABORTED')
    const settings = await this.settingsStore.read()
    const entry = resolveQianwenModel(model)
    const contextWindow = settings.contextWindowOverrides[model] ?? entry.defaultContextWindow
    const configured = settings.defaultReasoningEffort
    const defaultEffort = configured !== null && entry.reasoningEfforts.includes(configured)
      ? ReasoningEffortId(configured) : undefined
    return {
      provider, id: model, name: entry.name,
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
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 辅助请求（compaction 等）不自带 effort，先在解析默认值之前对齐主回合的档位。
    const followed = this.effortMemory.follow(options)
    yield* wrapStreamWithWatchdog(
      (signal, activity) => this.requestStream(followed, signal, activity),
      options.signal, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE, PROVIDER_NAME,
    )
  }
  private async *requestStream(options: GenerateOptions, signal: AbortSignal, activity?: StreamActivity): AsyncGenerator<StreamChunk> {
    const settings = await this.settingsStore.read()
    const credentials = await this.store.read()
    if (credentials === null) throw new LlmError(t('qwen.notConfigured'), 'MISSING_CREDENTIAL')
    const normalized = withStaticPrefixOrdering(PROVIDER_ID, normalizeGenerateOptions(options), this.options.promptCache)
    const images = await resolveRequestImages(normalized, this.options.attachments, signal)
    const requestOptions = offloadOldestQianwenRequestImages(normalized, images)
    const built = buildQianwenChatRequest(requestOptions, images, settings)
    const startedAt = Date.now()
    let response: Response
    try {
      const groupKey = settings.cacheEnabled
        ? sharedPrefixGroupKey(PROVIDER_ID, requestOptions, 'token-plan', 'single-key') : undefined
      response = await fetchWithPrefixCoordination(
        fetchWithContextBudgetRecovery(this.options.fetchFn ?? fetch),
        prefixRequests, groupKey, settings.cacheEnabled ? ttlMs(settings.cacheTtl) : undefined,
        QIANWEN_CHAT_COMPLETIONS_URL,
        { method: 'POST', headers: { ...qianwenHeaders(credentials.apiKey), accept: 'text/event-stream' }, body: JSON.stringify(built.body), signal },
      )
      activity?.pulse()
    } catch (error) {
      if (signal.aborted) throw new LlmError(t('sc.requestAborted', { provider: PROVIDER_NAME }), 'ABORTED', { cause: error })
      throw new LlmError(t('sc.requestFailed', { provider: PROVIDER_NAME, detail: error instanceof Error ? error.message : String(error) }), 'TRANSPORT', { cause: error })
    }
    if (!response.ok) throw classifyQianwenFailure(response.status, (await response.text().catch(() => '')).slice(0, 600))
    if (response.body === null) throw new LlmError(t('sc.emptyBody', { provider: PROVIDER_NAME }), 'PROVIDER_ERROR')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createQianwenStreamState({
      sessionId: options.sessionId, model: options.model, summaryMode: built.summaryMode,
      encryptedReplays: built.encryptedReplays, missingEncryptedContent: built.missingEncryptedContent,
    })
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
          for (const chunk of processQianwenStreamLine(line, state)) yield chunk
          if (state.finished) return
        }
      }
      buffer += decoder.decode()
      if (buffer.trim() !== '') for (const line of buffer.split('\n')) for (const chunk of processQianwenStreamLine(line, state)) yield chunk
      if (!state.finished) {
        assertQianwenStreamComplete(state)
        for (const chunk of closeQianwenStream(state)) yield chunk
      }
    } finally {
      const usage = readQianwenCacheUsage(state)
      if (usage !== undefined) {
        recordQianwenCacheUsage(usage)
        const totalTokens = qianwenPromptTokens(usage)
        activityStore.record(options.sessionId, totalTokens, startedAt)
        if (options.sessionId !== undefined) recordCacheWarmupUsage({
          sessionId: options.sessionId, provider: PROVIDER_ID,
          inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens,
          outputTokens: usage.outputTokens, totalTokens, at: startedAt,
          cacheTtlMs: ttlMs(settings.cacheTtl), blockAlignedContinuation: false,
        })
      }
      void reader.cancel().catch(() => undefined)
    }
  }
}

export function readQianwenCacheHint(sessionId: string | undefined, settings: { cacheEnabled: boolean; cacheTtl: '5m' | '1h' }): { idleMs: number; totalTokens: number } | null {
  if (!settings.cacheEnabled) return null
  const activity = activityStore.read(sessionId)
  if (activity === undefined) return null
  const decision = evaluateCacheHint({
    now: Date.now(), lastActiveAt: activity.lastActiveAt, totalTokens: activity.totalTokens,
    ttlMs: ttlMs(settings.cacheTtl), minTokensToHint: 100_000,
  })
  return decision.kind === 'hint' ? { idleMs: decision.idleMs, totalTokens: decision.totalTokens } : null
}
export { PROVIDER_ID, PROVIDER_NAME }
