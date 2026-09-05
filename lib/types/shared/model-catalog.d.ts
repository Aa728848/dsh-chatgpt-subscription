export type CodexModelModality = 'text' | 'image';
export declare const GPT_56_MAX_CONTEXT_WINDOW = 1000000;
export declare const GPT_6_ASTRA_MAX_CONTEXT_WINDOW = 872000;
export interface CodexModelCatalogEntry {
    id: string;
    name: string;
    contextWindow: number;
    inputModalities: readonly CodexModelModality[];
    defaultReasoningEffort: string;
    reasoningProfile: 'standard' | 'gpt-5.6' | 'gpt-6-astra';
    supportsReasoningSummary: boolean;
    fallbackModelId?: string;
}
export declare const CODEX_MODEL_CATALOG: readonly [{
    readonly id: "gpt-5.6-sol";
    readonly name: "5.6 Sol";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
    readonly fallbackModelId: "gpt-5.6-terra";
}, {
    readonly id: "gpt-6-astra";
    readonly name: "6 Astra";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-6-astra";
    readonly supportsReasoningSummary: true;
}, {
    readonly id: "gpt-5.6-terra";
    readonly name: "5.6 Terra";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
    readonly fallbackModelId: "gpt-5.5";
}, {
    readonly id: "gpt-5.6-luna";
    readonly name: "5.6 Luna";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
    readonly fallbackModelId: "gpt-5.5";
}, {
    readonly id: "gpt-5.5";
    readonly name: "5.5";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "standard";
    readonly supportsReasoningSummary: true;
}, {
    readonly id: "gpt-5.4";
    readonly name: "5.4";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "none";
    readonly reasoningProfile: "standard";
    readonly supportsReasoningSummary: true;
    readonly fallbackModelId: "gpt-5.4-mini";
}, {
    readonly id: "gpt-5.4-mini";
    readonly name: "5.4 Mini";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "none";
    readonly reasoningProfile: "standard";
    readonly supportsReasoningSummary: true;
}, {
    readonly id: "gpt-5.3-codex-spark";
    readonly name: "5.3 Codex Spark";
    readonly contextWindow: 258000;
    readonly inputModalities: readonly ["text"];
    readonly defaultReasoningEffort: "high";
    readonly reasoningProfile: "standard";
    readonly supportsReasoningSummary: false;
}];
export type CodexModelId = typeof CODEX_MODEL_CATALOG[number]['id'];
export declare const DEFAULT_VISIBLE_CODEX_MODEL_IDS: readonly ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna"];
export declare const DEFAULT_CODEX_MODEL: {
    readonly id: "gpt-5.6-sol";
    readonly name: "5.6 Sol";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
    readonly fallbackModelId: "gpt-5.6-terra";
};
export declare const CONFIGURABLE_CONTEXT_MODEL_IDS: readonly ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
export type ConfigurableContextModelId = typeof CONFIGURABLE_CONTEXT_MODEL_IDS[number];
export declare const STANDARD_REASONING_EFFORTS: readonly ["none", "low", "medium", "high", "xhigh"];
export declare const GPT_56_REASONING_EFFORTS: readonly ["none", "low", "medium", "high", "xhigh", "max"];
export declare const GPT_6_ASTRA_REASONING_EFFORTS: readonly ["low", "medium", "high", "xhigh", "max"];
export type CodexReasoningEffort = typeof GPT_56_REASONING_EFFORTS[number];
export declare function reasoningEffortsForModel(model: string): readonly CodexReasoningEffort[];
export declare function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort;
export declare function modelSupportsReasoningEffort(model: string, effort: unknown): effort is CodexReasoningEffort;
export declare function isCodexModelId(model: unknown): model is CodexModelId;
export declare function isConfigurableContextModelId(model: unknown): model is ConfigurableContextModelId;
export declare function contextWindowLimitForModel(model: ConfigurableContextModelId): number;
export declare function resolveCodexCatalogEntry(model: string): CodexModelCatalogEntry;
export declare function codexModelSupportsImageInput(model: string): boolean;
export declare function codexModelSupportsReasoningSummary(model: string): boolean;
export declare function resolveCodexFallbackModel(model: string): CodexModelCatalogEntry | undefined;
//# sourceMappingURL=model-catalog.d.ts.map