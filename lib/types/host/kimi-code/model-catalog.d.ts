/**
 * Static catalog of the models the Kimi Code subscription serves.
 *
 * Transcribed from the official model table at
 * https://www.kimi.com/code/docs/en/kimi-code/models.html. Model version names
 * (K3, K2.8 Preview) are NOT valid request ids: only the ids below may appear in
 * a request body, or the service answers 401 "Your model id does not exist".
 */
import type { KimiCodeReasoningEffort } from '../../shared/kimi-code-contracts.ts';
/** One model the Kimi Code endpoint serves to subscription accounts. */
export interface KimiCodeCatalogModel {
    /** Exact model id to put on the wire. */
    id: string;
    /** Display name shown in the picker. */
    name: string;
    /** Marketing version the id maps to, e.g. K3. */
    version: string;
    /**
     * Context window used unless the user overrides it.
     *
     * For `k3` this is deliberately the Moderato-tier 256K bound rather than the
     * 1M the model can reach: the server rejects a request that exceeds the
     * signed-in plan's entitlement with a 401, so a session that silently grew
     * past 256K on a Moderato account would fail hard instead of compacting.
     * Allegretto-and-above users raise it with the context-window override.
     */
    contextWindow: number;
    /** Context the highest tier unlocks, when it is larger than {@link contextWindow}. */
    maxContextWindow: number | null;
    /** Output cap requested when the caller omits one. */
    maxTokens: number;
    /** Input the model accepts; DSH only maps the text and image entries. */
    inputModalities: readonly ('text' | 'image' | 'video')[];
    /** Thinking levels the model accepts, in escalating order. */
    reasoningEfforts: readonly KimiCodeReasoningEffort[];
    /** Thinking level used when the conversation does not pick one. */
    defaultReasoningEffort: KimiCodeReasoningEffort | null;
    /** Subscription tier needed for the full model, when not every member has it. */
    minimumPlan: string | null;
    /** Subscription tier needed for the full context window, when it differs. */
    contextPlan: string | null;
    /** One-line description from the official table. */
    description: string;
    /**
     * Whether the model accepts message-level tool declarations.
     *
     * Taken from the capability list the official client ships in its own managed
     * model table, which is more specific than the wire documentation (that names
     * K3 alone, because it describes the K3 request schema):
     *
     * - k3, k3-256k, kimi-for-coding -> declared;
     * - kimi-for-coding-highspeed   -> NOT declared.
     *
     * The live `/v1/models` listing remains authoritative when it speaks: its own
     * `supports_dynamic_tools` overrides this flag, including to turn it off.
     */
    supportsDynamicTools: boolean;
    /** Relative quota cost of this model against the cheapest one. */
    quotaMultiplier: number;
    /** How fast the model emits output. */
    speed: 'regular' | 'highspeed';
}
/**
 * The four ids the subscription serves today.
 *
 * `kimi-for-coding` is the alias that never changes: Moonshot upgrades the model
 * behind it in place (K2.7 Code became K2.8 Preview without a config change), so
 * this entry is the durable default a user can leave selected.
 */
export declare const KIMI_CODE_MODELS: readonly KimiCodeCatalogModel[];
/** Registry entry for one model id, or undefined when the id is unknown. */
export declare function kimiCodeModelDef(modelId: string): KimiCodeCatalogModel | undefined;
/** Membership test for one known model id. */
export declare function isKimiCodeModelId(value: unknown): boolean;
/** Display name for one model id, falling back to the raw id so nothing is hidden. */
export declare function kimiCodeModelName(modelId: string): string;
//# sourceMappingURL=model-catalog.d.ts.map