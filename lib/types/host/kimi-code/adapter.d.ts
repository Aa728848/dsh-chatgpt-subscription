import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PROVIDER_ID, reasoningEffortsFor } from './types.ts';
import { FileCredentialStore, FileModelSettingsStore, type KimiCodeCatalogModel, type KimiCodePreferenceStore } from './token-store.ts';
import { buildModelOptions, clearCachedCatalog } from './client.ts';
import { type AttachmentImageReader, type AttachmentVideoReader } from './mapper.ts';
/**
 * Transient-failure retry policy for the `kimi-code` route.
 *
 * Kimi Code fronts the model providers, so a call can fail with a 502/503/504
 * while the subscription and the credential stay perfectly usable. The service
 * publishes exactly this case, and the body is usually
 * `{"error":{"message":"Upstream model provider is temporarily unavailable.
 * Please try again in a moment.","type":"server_error"}}` — which is precisely a
 * message telling the client to try again.
 *
 * The retryable set is therefore:
 *
 * - `SERVER` — any 5xx, including that upstream-unavailable 502;
 * - `RATE_LIMIT` — a 429 that is genuine back-pressure ("too many requests",
 *   "the engine is currently overloaded"), which the documentation describes as
 *   transient;
 * - `TRANSPORT` — a connection that produced no response at all;
 * - `TIMEOUT` — a stalled stream, handled by the idle watchdog.
 *
 * Deliberately outside the set:
 *
 * - `INVALID_CREDENTIAL` — a rejected access token fails identically on every
 *   attempt;
 * - `PROVIDER_ERROR` — a 400, a 401 that is really a plan-entitlement refusal,
 *   or a 403 quota limit. Retrying a quota that resets in hours only burns
 *   requests and delays the message the user needs to see;
 * - `ABORTED` — the caller already cancelled.
 *
 * The DSH normal defaults would apply anyway; stating the values here pins them
 * so this route never retries less than the rest of the plugin.
 */
export declare const KIMI_CODE_RETRY_POLICY_CONFIG: {
    mode: 'normal';
    maxRetries: number;
    retryableCodes: string[];
    backoff: {
        initialDelayMs: number;
        maxDelayMs: number;
        jitterRatio: number;
    };
};
/** Configured effort when the model supports it, else the adapter's preference order. */
export declare function resolveDefaultReasoningEffort(efforts: readonly string[], configuredEffort?: string | null): ReasoningEffortId | undefined;
/**
 * What one failed response means for the retry policy.
 *
 * The service overloads a single status for unrelated problems — a 401 covers
 * both "your token is bad" and "your plan does not include k3", and a 429
 * covers both ordinary back-pressure and a spent quota that must not be
 * retried. The body text is what separates them, so the classification reads
 * it rather than trusting the status alone.
 */
export interface KimiFailureClassification {
    /** DSH error code; decides whether the route retries. */
    code: string;
    /** Message shown to the user, with the provider's own text appended. */
    message: string;
    /** True only when the failure is worth retrying. */
    retryable: boolean;
}
/** Short, single-line excerpt of one error body, safe to show a user. */
export declare function summarizeFailureBody(raw: string): string;
/**
 * Classify one non-2xx response for the retry policy.
 *
 * @param status - HTTP status the service answered with.
 * @param bodyText - raw response body, used to separate overloaded statuses.
 */
export declare function classifyKimiFailure(status: number, bodyText: string): KimiFailureClassification;
export interface KimiCodeAdapterOptions {
    fetchFn?: typeof fetch;
    attachments?: AttachmentImageReader;
    /**
     * Video reader seam.
     *
     * DSH's attachment service stores images only, so a deployment that produces
     * video references injects the reader here. Absent, video occurrences degrade
     * to an explicit text placeholder rather than silently vanishing.
     */
    videos?: AttachmentVideoReader;
    /** Live catalog loader seam; defaults to the managed `/models` call. */
    loadCatalog?: () => Promise<KimiCodeCatalogModel[]>;
}
export declare class KimiCodeAdapter extends LlmAdapter {
    private readonly store;
    private readonly modelSettings;
    private readonly preferences?;
    private readonly options;
    constructor(store?: FileCredentialStore, modelSettings?: FileModelSettingsStore, preferences?: KimiCodePreferenceStore | undefined, options?: KimiCodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(): ResolvedRetryPolicy;
    imageRequestPricing(): undefined;
    private settings;
    /**
     * Catalog for the picker: the live managed listing when reachable, the
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
export { clearCachedCatalog, buildModelOptions, reasoningEffortsFor, PROVIDER_ID };
//# sourceMappingURL=adapter.d.ts.map