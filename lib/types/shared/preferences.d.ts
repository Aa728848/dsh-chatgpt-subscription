import type { CodexOutputVerbosity, ProxyMode, SubscriptionPreferencesDto } from './contracts.ts';
export declare const PREFERENCES_NAMESPACE = "dsh-chatgpt-subscription";
export declare const SUBAGENT_MAX_DEPTH_LIMIT = 3;
export declare const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'>;
export declare function isCodexOutputVerbosity(value: unknown): value is CodexOutputVerbosity;
export declare function isProxyMode(value: unknown): value is ProxyMode;
//# sourceMappingURL=preferences.d.ts.map