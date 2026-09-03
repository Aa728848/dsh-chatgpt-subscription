import { FileCredentialStore, FileModelSettingsStore, type AntigravityCatalogModel } from './token-store.ts';
import type { AntigravityAccountQuota, AntigravityQuotaGroup } from '../../shared/antigravity-contracts.ts';
export declare function defaultUserAgent(): string;
export declare function antigravityHeaders(token: string): Record<string, string>;
export declare function jsonHeaders(token: string): Record<string, string>;
export declare function endpointCandidates(): string[];
export declare function listCloudAICompanionProjects(token: string): Promise<string | undefined>;
export declare function loadCodeAssist(token: string): Promise<string | undefined>;
export declare function postJson(path: string, token: string, body: Record<string, unknown>): Promise<{
    endpoint: string;
    status: number;
    data: unknown;
}>;
export declare function parseQuotaSummary(data: unknown): {
    groups: AntigravityQuotaGroup[];
    description?: string;
};
export declare function parseCatalogModels(data: unknown): AntigravityCatalogModel[];
export declare function fetchAccountQuota(store?: FileCredentialStore, modelSettings?: FileModelSettingsStore): Promise<AntigravityAccountQuota>;
export declare function getCachedQuota(): AntigravityAccountQuota | undefined;
//# sourceMappingURL=client.d.ts.map