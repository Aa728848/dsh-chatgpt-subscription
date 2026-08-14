import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PROVIDER_ID } from './model-catalog.ts';
import { ResponsesClient } from './responses-client.ts';
export declare class CodexChatGptAdapter extends LlmAdapter {
    private readonly client;
    constructor(client: ResponsesClient);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    listModels(): Promise<readonly LlmModelInfo[]>;
    resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export { PROVIDER_ID };
//# sourceMappingURL=adapter.d.ts.map