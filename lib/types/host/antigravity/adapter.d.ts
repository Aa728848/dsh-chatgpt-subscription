import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { FileCredentialStore, FileModelSettingsStore, type AntigravityPreferenceStore } from './token-store.ts';
export declare class AntigravityAdapter extends LlmAdapter {
    private readonly store;
    private readonly modelSettings;
    private readonly preferences?;
    constructor(store?: FileCredentialStore, modelSettings?: FileModelSettingsStore, preferences?: AntigravityPreferenceStore | undefined);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider?: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private requestStream;
}
//# sourceMappingURL=adapter.d.ts.map