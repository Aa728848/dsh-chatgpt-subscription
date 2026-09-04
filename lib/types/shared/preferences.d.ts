import type { CodexOutputVerbosity, CodexReasoningSummary, ProxyMode, SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts';
export declare const PREFERENCES_NAMESPACE = "dsh-chatgpt-subscription";
export declare const SUBAGENT_MAX_DEPTH_LIMIT = 3;
export declare const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'>;
export declare const SEARCH_PROVIDER_DSH: SearchProviderPreference;
export declare const SEARCH_PROVIDER_CODEX: SearchProviderPreference;
export declare function isSearchProviderPreference(value: unknown): value is SearchProviderPreference;
export declare function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity;
export declare function isCodexReasoningSummary(value: unknown): value is CodexReasoningSummary;
export declare function isProxyMode(value: unknown): value is ProxyMode;
//# sourceMappingURL=preferences.d.ts.map