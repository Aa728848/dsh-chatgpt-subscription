export type CodexModelModality = 'text' | 'image';
export interface CodexModelCatalogEntry {
    id: string;
    name: string;
    contextWindow: number;
    inputModalities: readonly CodexModelModality[];
    defaultReasoningEffort: string;
    reasoningProfile: 'standard' | 'gpt-5.6';
    supportsReasoningSummary: boolean;
}
export declare const CODEX_MODEL_CATALOG: readonly [{
    readonly id: "gpt-5.6-sol";
    readonly name: "5.6 Sol";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
}, {
    readonly id: "gpt-5.6-terra";
    readonly name: "5.6 Terra";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
}, {
    readonly id: "gpt-5.6-luna";
    readonly name: "5.6 Luna";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
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
export declare const DEFAULT_CODEX_MODEL: {
    readonly id: "gpt-5.6-sol";
    readonly name: "5.6 Sol";
    readonly contextWindow: 272000;
    readonly inputModalities: readonly ["text", "image"];
    readonly defaultReasoningEffort: "medium";
    readonly reasoningProfile: "gpt-5.6";
    readonly supportsReasoningSummary: true;
};
export declare function resolveCodexCatalogEntry(model: string): CodexModelCatalogEntry;
export declare function codexModelSupportsImageInput(model: string): boolean;
export declare function codexModelSupportsReasoningSummary(model: string): boolean;
//# sourceMappingURL=model-catalog.d.ts.map