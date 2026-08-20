import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
/**
 * A private provider route that delegates streaming to a selected registered
 * provider while exposing a user-selected effective context window to DSH.
 */
export declare class SubagentContextAdapter extends LlmAdapter {
    private readonly llm;
    private readonly selection;
    static readonly provider = "dsh-subagent-model-override";
    constructor(llm: Context['llm'], selection: () => {
        provider: string;
        model: string;
        contextWindow: number;
    });
    providerInfo(): {
        id: string;
        name: string;
    };
    listModels(): Promise<readonly LlmModelInfo[]>;
    resolveModel(_provider: string, _model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=subagent-context-adapter.d.ts.map