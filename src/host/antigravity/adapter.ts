import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
  ROUTING,
  STREAM_IDLE_TIMEOUT_CODE,
  STREAM_IDLE_TIMEOUT_MS,
  type AntigravityModelDef,
} from './types.ts'
import { FileCredentialStore, FileModelSettingsStore, type AntigravityPreferenceStore } from './token-store.ts'
import { ensureApiKey } from './oauth.ts'
import { antigravityHeaders, endpointCandidates } from './client.ts'
import { buildRequest, closeStream, createStreamState, processStreamLine } from './mapper.ts'
import { wrapStreamWithWatchdog } from '../common/idle-watchdog.ts'

export class AntigravityAdapter extends LlmAdapter {
  constructor(
    private readonly store = new FileCredentialStore(),
    private readonly modelSettings = new FileModelSettingsStore(),
    private readonly preferences?: AntigravityPreferenceStore,
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  async listModels(provider?: string): Promise<readonly LlmModelInfo[]> {
    const prov = provider || PROVIDER_ID
    const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read()
    const enabledSet = new Set(settings.enabledModelIds)
    const available = MODELS.filter((m) => enabledSet.has(m.id))
    const overrides = settings.contextWindowOverrides || {}

    return available.map((model) => ({
      provider: prov,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: overrides[model.id] || model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
    }))
  }

  async resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw new LlmError('antigravity model resolution aborted', 'ABORTED')
    const model = MODELS.find((m) => m.id === modelId) || {
      id: modelId,
      name: modelId,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      contextWindow: 128000,
      maxTokens: 65536,
    }

    const settings = this.preferences ? this.preferences.status() : await this.modelSettings.read()
    const overrides = settings.contextWindowOverrides || {}

    const efforts = model.reasoningEfforts || ['low', 'medium', 'high']
    const defaultEffort = settings.defaultReasoningEffort || 'medium'

    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: overrides[model.id] || model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...(model.reasoningEfforts
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({
                id: ReasoningEffortId(effort),
                name: effort,
              })),
              defaultEffort: ReasoningEffortId(defaultEffort),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = MODELS.find((m) => m.id === options.model) || {
      id: options.model,
      name: options.model,
      inputModalities: ['text', 'image'] as Array<'text' | 'image'>,
      contextWindow: 128000,
      maxTokens: 65536,
    }

    const settings = await this.modelSettings.read()
    const effectiveEffort = options.reasoningEffort || settings.defaultReasoningEffort || undefined
    const effectiveOptions: GenerateOptions = effectiveEffort
      ? { ...options, reasoningEffort: effectiveEffort as any }
      : options

    yield* wrapStreamWithWatchdog(
      (watchdogSignal) => this.requestStream(effectiveOptions, model, watchdogSignal),
      options.signal,
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_CODE,
      'Antigravity',
    )
  }

  private async *requestStream(
    options: GenerateOptions,
    model: AntigravityModelDef,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { token, projectId: defaultProj } = await ensureApiKey(this.store)
    const projectId = defaultProj || 'antigravity-default'

    const effort = String(options.reasoningEffort || 'medium').toLowerCase()
    const routing = ROUTING[model.id]
    const initialRuntime = routing?.routing[effort] || routing?.defaultRequestId || model.id
    const fallbackRuntime = routing?.off && routing.off !== initialRuntime ? routing.off : undefined

    const candidates = [initialRuntime]
    if (fallbackRuntime && !candidates.includes(fallbackRuntime)) candidates.push(fallbackRuntime)
    if (routing?.fallbackCandidates) {
      for (const fc of routing.fallbackCandidates) {
        if (!candidates.includes(fc)) candidates.push(fc)
      }
    }

    let response: Response | undefined
    let chosenRuntime = candidates[0]

    for (const runtimeModel of candidates) {
      chosenRuntime = runtimeModel
      const body = JSON.stringify(buildRequest(options, model, projectId, runtimeModel, effort))
      const headers = {
        ...antigravityHeaders(token),
        ...(model.id.startsWith('claude-') ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
      }

      for (const endpoint of endpointCandidates()) {
        try {
          response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers,
            body,
            signal,
          })
          if (response.ok) break
          // 若遇 404 表明该模型在当前架构下未登记，直接跳出尝试下一个降级模型
          if (response.status === 404) break
          // 若遇 429 限流或 5xx 错误，不提前中断，继续尝试下一个备用端点 (如 daily sandbox)
        } catch (err) {
          if (signal.aborted) throw new LlmError('Antigravity request aborted', 'ABORTED', { cause: err })
        }
      }

      if (response && response.ok) break
    }

    if (!response || !response.ok) {
      const status = response?.status ?? 500
      const errText = await response?.text().catch(() => '')
      if (status === 429) {
        throw new LlmError(
          `Antigravity 账号配额已耗尽或请求受限 (429 RESOURCE_EXHAUSTED)。请在插件设置页查看配额剩余百分比及重置倒计时。原始响应: ${errText || 'No response'}`,
          'RATE_LIMIT',
          { status: 429 },
        )
      }
      throw new LlmError(`Antigravity API error (${status}): ${errText || 'No response'}`, 'PROVIDER_ERROR', {
        status,
      })
    }

    if (!response.body) throw new LlmError('Antigravity returned empty response body', 'PROVIDER_ERROR')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createStreamState()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const chunks = processStreamLine(trimmed, state)
          for (const chunk of chunks) yield chunk
        }
      }

      if (buffer.trim()) {
        const chunks = processStreamLine(buffer.trim(), state)
        for (const chunk of chunks) yield chunk
      }

      for (const chunk of closeStream(state)) {
        yield chunk
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  }
}
