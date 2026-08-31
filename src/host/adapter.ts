import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { listCodexModels, PROVIDER_ID, PROVIDER_NAME, resolveCodexModel } from './model-catalog.ts'
import { ResponsesClient } from './responses-client.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'SERVER', 'NETWORK', 'TIMEOUT', 'TRANSPORT'],
  backoff: { initialDelayMs: 1_500, maxDelayMs: 15_000, jitterRatio: 0.2 },
}, 'dsh-chatgpt-subscription.retry')

export class CodexChatGptAdapter extends LlmAdapter {
  constructor(
    private readonly client: ResponsesClient,
    private readonly preferences?: SubscriptionPreferenceStore,
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  imageRequestPricing(_provider?: string, _model?: string): undefined {
    return undefined
  }

  async listModels(): Promise<readonly LlmModelInfo[]> {
    return listCodexModels(this.preferences)
  }

  async resolveModel(_provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return resolveCodexModel(model, this.preferences)
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.client.stream(options)
  }
}

export { PROVIDER_ID }
