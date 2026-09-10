import { FileCredentialStore, FileModelSettingsStore, type AntigravityCatalogModel } from './token-store.ts';
import type { AntigravityAccountQuota, AntigravityQuotaGroup } from '../../shared/antigravity-contracts.ts';
export declare const ANTIGRAVITY_QUOTA_CACHE_TTL_MS: number;
export declare function defaultUserAgent(): string;
export declare function antigravityHeaders(token: string): Record<string, string>;
export declare function jsonHeaders(token: string): Record<string, string>;
export declare function endpointCandidates(): string[];
export interface AntigravityTierInfo {
    id?: string;
    name?: string;
    description?: string;
}
export interface AntigravityIneligibleTier {
    tierId?: string;
    reasonMessage?: string;
    validationUrl?: string;
}
export interface LoadCodeAssistDetailResult {
    currentTier?: AntigravityTierInfo | null;
    paidTier?: AntigravityTierInfo | null;
    allowedTiers?: AntigravityTierInfo[];
    ineligibleTiers?: AntigravityIneligibleTier[];
    projectId?: string;
    raw?: Record<string, unknown>;
}
export declare function loadCodeAssistDetail(token: string, fetchFn?: typeof fetch, signal?: AbortSignal): Promise<LoadCodeAssistDetailResult | undefined>;
export declare function onboardUser(token: string, fetchFn?: typeof fetch, signal?: AbortSignal): Promise<void>;
export declare function listCloudAICompanionProjects(token: string, fetchFn?: typeof fetch): Promise<string | undefined>;
export declare function loadCodeAssist(token: string, fetchFn?: typeof fetch): Promise<string | undefined>;
export declare function postJson(path: string, token: string, body: Record<string, unknown>, fetchFn?: typeof fetch): Promise<{
    endpoint: string;
    status: number;
    data: unknown;
}>;
export declare function parseQuotaSummary(data: unknown): {
    groups: AntigravityQuotaGroup[];
    description?: string;
};
export declare function parseCatalogModels(data: unknown): AntigravityCatalogModel[];
export declare function fetchAccountQuota(store?: FileCredentialStore, modelSettings?: FileModelSettingsStore, fetchFn?: typeof fetch, force?: boolean): Promise<AntigravityAccountQuota>;
export declare function getCachedQuota(): AntigravityAccountQuota | undefined;
export declare function clearCachedQuota(): void;
//# sourceMappingURL=client.d.ts.map