/**
 * Wire contracts between the Kimi Code host routes and the browser settings
 * card. Everything here is public: no credential ever crosses this boundary.
 *
 * Kimi Code (https://www.kimi.com/code) is a Moonshot AI coding subscription,
 * distinct from the pay-as-you-go Moonshot Open Platform: its credentials come
 * from an OAuth device flow against auth.kimi.com and its inference lives at
 * https://api.kimi.com/coding/v1.
 */
/** Region a Kimi Code account belongs to; decides which hosts the client uses. */
export type KimiCodeRegion = 'mainland-cn' | 'global';
/**
 * Request/response dialect used for the model calls.
 *
 * The official Kimi Code CLI configures its managed provider as `type = "kimi"`,
 * an OpenAI-compatible chat-completions client, so that is the default here.
 * The Anthropic Messages dialect is offered too because the service documents
 * `https://api.kimi.com/coding/` as an Anthropic-compatible base URL for
 * third-party tools, and some models behave better with a thinking budget.
 */
export type KimiCodeWire = 'openai' | 'anthropic';
/**
 * Thinking level a Kimi Code model accepts.
 *
 * Kimi Code maps a tool's effort onto exactly three K3 levels plus a thinking-off
 * switch. The documented mapping is authoritative and deliberately narrower than
 * the generic level set other providers use:
 *
 * - `low`   <- `low` / `minimum` / `light`
 * - `high`  <- `high` / `medium`
 * - `max`   <- `ultra` / `max` / `xhigh`
 * - `none`  -> thinking disabled (`thinking.type = "disabled"`)
 *
 * Anything else the client sends is rejected by the service with HTTP 400, so
 * no other level is ever put on the wire.
 */
export type KimiCodeReasoningEffort = 'low' | 'high' | 'max' | 'none';
/** Every level, in escalating order; the settings card renders exactly these. */
export declare const KIMI_CODE_REASONING_EFFORTS: readonly KimiCodeReasoningEffort[];
/** One model offered by the Kimi Code coding endpoint. */
export interface KimiCodeModelOption {
    id: string;
    name: string;
    /** Enabled models are the ones DSH offers in the conversation model picker. */
    enabled: boolean;
    /** Context window the catalog reports for this model. */
    defaultContextWindow: number;
    /** Effective context window: the override when one is saved, else the default. */
    contextWindow: number;
    /** Maximum output tokens this route requests when a caller omits one. */
    defaultMaxTokens: number;
    /** Thinking levels this model accepts; absent for a model that cannot reason. */
    reasoningEfforts?: string[];
    /** Thinking level used when the conversation does not pick one. */
    defaultReasoningEffort?: string;
    /** Request/response dialect the adapter uses on the wire. */
    wire: KimiCodeWire;
    /** Human description from the official model table. */
    description: string | null;
    /** Whether the model accepts video input as well as images. */
    supportsVideo: boolean;
    /** Subscription tier the model needs, when it is not open to every member. */
    minimumPlan: string | null;
}
/** One quota window reported for the signed-in account. */
export interface KimiCodeUsageWindow {
    id: string;
    label: string;
    /** Used fraction in [0, 1]. */
    usedFraction: number;
    /** Convenience integer for the card and badge. */
    usedPercent: number;
    /** Nominal window length in minutes, when the service states one. */
    windowDurationMins: number | null;
    /** Unix milliseconds the window resets, when reported. */
    resetsAt: number | null;
    /** Allowance as the service reports it (request counts), when reported. */
    limit: string | null;
    used: string | null;
    remaining: string | null;
}
/** Pay-as-you-go wallet the account can fall back on once a window is spent. */
export interface KimiCodeExtraUsage {
    /** Remaining wallet balance in the currency's minor unit. */
    balanceCents: number | null;
    totalCents: number | null;
    monthlyChargeLimitEnabled: boolean;
    monthlyChargeLimitCents: number | null;
    monthlyUsedCents: number | null;
    currency: string | null;
}
/** Account identity, resolved from the token and the usage response. */
export interface KimiCodeAccount {
    userId: string | null;
    nickname: string | null;
    email: string | null;
    /** Subscription tier display name, for example Moderato. */
    planName: string | null;
    /** Machine tier level when the service reports one. */
    planLevel: string | null;
    region: KimiCodeRegion | null;
    authenticatedAt: number | null;
}
/** One point-in-time quota snapshot for the signed-in Kimi Code account. */
export interface KimiCodeAccountQuota {
    account: KimiCodeAccount;
    /** Subscription tier display name, when the service reports one. */
    planName: string | null;
    /** Every quota window the account currently has. */
    windows: KimiCodeUsageWindow[];
    /** Pay-as-you-go booster wallet, when the account has one. */
    extraUsage: KimiCodeExtraUsage | null;
    /** Unix milliseconds this snapshot was fetched. */
    fetchedAt: number;
    /** Endpoint paths that answered, kept for diagnostics in the card. */
    sources: string[];
}
/** Everything the settings card and the composer badge render. */
export interface KimiCodeWebStatus {
    authenticated: boolean;
    hasCredentials: boolean;
    storagePath: string;
    region: KimiCodeRegion;
    oauthHost: string;
    codingBaseUrl: string;
    account: KimiCodeAccount | null;
    quota: KimiCodeAccountQuota | null;
    lastFetchedAt: number | null;
    /** When true the stored refresh token was rejected and sign-in is required. */
    credentialsRejected: boolean;
    /**
     * Why the quota could not be read, when the last attempt failed.
     *
     * Reported beside the snapshot rather than in place of it: a transient
     * failure should explain itself without hiding the account that is signed in.
     */
    quotaError?: string | null;
    /** Rolling prefix-cache effectiveness for this process, when requests ran. */
    cache: KimiCodeCacheStatsDto | null;
    /** Whether Preserved Thinking is currently requested on the wire. */
    preserveThinking: boolean;
    models: KimiCodeModelOption[];
    contextWindowOverrides: Record<string, number>;
    defaultReasoningEffort: KimiCodeReasoningEffort | null;
    /** Region used for the next login flow. */
    loginRegion: KimiCodeRegion;
    /** Route the plugin currently serves; false when another plugin owns it. */
    serving: boolean;
    /** Diagnostic when the route is owned by a different adapter family. */
    conflict: string | null;
}
/**
 * How well Kimi's automatic prefix cache is working for this process.
 *
 * Reported because the cache is invisible otherwise: it is content-hash based
 * with no marker to set, so the read ratio is the only evidence a session is
 * actually reusing its prefix.
 */
export interface KimiCodeCacheStatsDto {
    requests: number;
    cachedTokens: number;
    freshTokens: number;
    outputTokens: number;
    /** Cached / (cached + fresh); null until a request reports usage. */
    hitRatio: number | null;
}
/** Patch accepted by the models/settings routes. */
export interface KimiCodeSettingsUpdateDto {
    enabledModelIds?: string[];
    contextWindowOverrides?: Record<string, number>;
    defaultReasoningEffort?: KimiCodeReasoningEffort | null;
}
/** Live state of the device-code login flow the card polls. */
export interface KimiCodeLoginFlowStatus {
    status: 'idle' | 'pending' | 'complete' | 'error';
    /** Page the user must open, including the pre-filled user code. */
    verificationUriComplete?: string;
    verificationUri?: string;
    userCode?: string;
    startedAt?: number;
    completedAt?: number;
    /** Unix milliseconds the device code stops being valid. */
    expiresAt?: number;
    progress?: string;
    error?: string;
}
/** Result of an explicit connection test. */
export interface KimiCodeConnectionDto {
    connected: boolean;
    latencyMs: number;
    account: KimiCodeAccount | null;
}
//# sourceMappingURL=kimi-code-contracts.d.ts.map