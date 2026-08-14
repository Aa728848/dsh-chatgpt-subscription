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
import { listCodexModels, PROVIDER_ID, PROVIDER_NAME, resolveCodexModel } from './model-catalog.ts'
import { ResponsesClient } from './responses-client.ts'

const RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'SERVER_ERROR', 'NETWORK'],
  backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.15 },
}, 'dsh-chatgpt-subscription.retry')

export class CodexChatGptAdapter extends LlmAdapter {
  constructor(private readonly client: ResponsesClient) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return RETRY_POLICY
  }

  async listModels(): Promise<readonly LlmModelInfo[]> {
    return listCodexModels()
  }

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveCodexModel(model)
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.client.stream(options)
  }
}

export { PROVIDER_ID }
