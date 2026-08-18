import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { MultiProviderRuntime } from './multi-provider-runtime.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'NETWORK'],
  backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.15 },
}, 'dsh-subscription-providers.retry')

export class MultiProviderAdapter extends LlmAdapter {
  constructor(private readonly providersRuntime: MultiProviderRuntime) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providersRuntime.providerName(provider) }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.providersRuntime.listModels(provider)
  }

  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return this.providersRuntime.resolveModel(provider, model)
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.providersRuntime.stream(options)
  }
}
