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
import type { CodexCatalogEntry, CodexCatalogLoadOptions } from './codex-catalog.ts'
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
    /**
     * Live listing loader, when the host can sign in. Absent in tests and in a
     * host with no credential, and then the shipped table is the catalog.
     */
    private readonly loadCatalog?: (options?: CodexCatalogLoadOptions) => Promise<readonly CodexCatalogEntry[]>,
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
    return listCodexModels(this.preferences, await this.catalog())
  }

  async resolveModel(_provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return resolveCodexModel(model, this.preferences, await this.catalog(signal))
  }

  /**
   * The live listing, or undefined when this line has no way to fetch one.
   *
   * Never throws: a listing failure must not become a failed picker or a
   * rejected model resolution. `loadCodexCatalog` already answers with the
   * shipped table on failure, so the catch here only covers a throwing loader.
   */
  private async catalog(signal?: AbortSignal): Promise<readonly CodexCatalogEntry[] | undefined> {
    if (this.loadCatalog === undefined) return undefined
    return this.loadCatalog({ signal }).catch(() => undefined)
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
