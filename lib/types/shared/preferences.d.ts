import type { SearchProviderPreference, SubscriptionPreferencesDto } from './contracts.ts';
export declare const PREFERENCES_NAMESPACE = "dsh-chatgpt-subscription";
export declare const DEFAULT_PREFERENCES: Omit<SubscriptionPreferencesDto, 'writable'>;
export declare const SEARCH_PROVIDER_DSH: SearchProviderPreference;
export declare const SEARCH_PROVIDER_CODEX: SearchProviderPreference;
export declare function isSearchProviderPreference(value: unknown): value is SearchProviderPreference;
//# sourceMappingURL=preferences.d.ts.map