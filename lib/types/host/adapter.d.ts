import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PROVIDER_ID } from './model-catalog.ts';
import { ResponsesClient } from './responses-client.ts';
import type { SubscriptionPreferenceStore } from './preferences.ts';
export declare class CodexChatGptAdapter extends LlmAdapter {
    private readonly client;
    private readonly preferences?;
    constructor(client: ResponsesClient, preferences?: SubscriptionPreferenceStore | undefined);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    listModels(): Promise<readonly LlmModelInfo[]>;
    resolveModel(_provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export { PROVIDER_ID };
//# sourceMappingURL=adapter.d.ts.map