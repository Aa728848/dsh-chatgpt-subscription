import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { FileCredentialStore, FileModelSettingsStore, type CommandCodeCatalogModel, type CommandCodePreferenceStore } from './token-store.ts';
import { type AttachmentImageReader } from './mapper.ts';
/** Configured effort when the model supports it, else the adapter's preference order. */
export declare function resolveDefaultReasoningEffort(efforts: readonly string[], configuredEffort?: string | null): ReasoningEffortId | undefined;
export interface CommandCodeAdapterOptions {
    fetchFn?: typeof fetch;
    attachments?: AttachmentImageReader;
    /** Live catalog loader seam; defaults to the public `/provider/v1/models` call. */
    loadCatalog?: () => Promise<CommandCodeCatalogModel[]>;
}
export declare class CommandCodeAdapter extends LlmAdapter {
    private readonly store;
    private readonly modelSettings;
    private readonly preferences?;
    private readonly options;
    constructor(store?: FileCredentialStore, modelSettings?: FileModelSettingsStore, preferences?: CommandCodePreferenceStore | undefined, options?: CommandCodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    imageRequestPricing(): undefined;
    private settings;
    /**
     * Catalog for the picker: the live Command Code listing when reachable, the
     * shipped fallback otherwise, narrowed by the user's enabled selection.
     */
    private catalog;
    private contextWindowFor;
    listModels(provider?: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private requestStream;
}
//# sourceMappingURL=adapter.d.ts.map