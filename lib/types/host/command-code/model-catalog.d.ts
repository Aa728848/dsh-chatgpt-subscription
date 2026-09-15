/**
 * Command Code model capability table.
 *
 * Transcribed from the official CLI's own model registry (the table it builds
 * `createModelRegistry` over), which is the only authoritative source for which
 * models accept image input and which reasoning levels each one exposes: the
 * public `/provider/v1/models` listing carries an id, a display name, and a
 * context length, but says nothing about modalities or reasoning.
 *
 * Family heuristics are not a substitute. Within one vendor the split is not
 * derivable from the id: `deepseek/deepseek-v4-flash` is text-only while
 * `deepseek/deepseek-v4.1-flash` and `deepseek/deepseek-v4-flash-vision-exp` take
 * images, and `z-ai/glm-5.3-flash` takes images while `zai-org/GLM-5.3` does not.
 */
export interface CommandCodeModelDef {
    id: string;
    name: string;
    /** Accepted request modalities, exactly as the registry declares them. */
    inputModalities: Array<'text' | 'image'>;
    /** Selectable reasoning levels; empty when the model exposes none. */
    reasoningEfforts: string[];
    /** Context window the registry declares, when it declares one. */
    contextWindow: number | null;
    /** Output cap the registry declares, when it declares one. */
    maxTokens: number | null;
}
/** Every model the Command Code registry describes, in registry order. */
export declare const COMMAND_CODE_MODELS: readonly CommandCodeModelDef[];
/** Registry entry for one model id, or undefined when it describes no such model. */
export declare function commandCodeModelDef(modelId: string): CommandCodeModelDef | undefined;
//# sourceMappingURL=model-catalog.d.ts.map