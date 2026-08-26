export interface SanitizedAccountDto {
    email: string | null;
    planType: string | null;
    accountIdSuffix: string | null;
    tokenExpiresAt: number;
}
export type CredentialStorageKind = 'windows-dpapi' | 'macos-keychain' | 'linux-file' | 'memory';
export interface CredentialStorageDto {
    kind: CredentialStorageKind;
    encrypted: boolean;
    available: boolean;
}
export interface PluginStatusDto {
    authenticated: boolean;
    account: SanitizedAccountDto | null;
    storage: CredentialStorageDto;
    login: {
        active: boolean;
        loginId: string | null;
        expiresAt: number | null;
    };
    quota: QuotaStatusDto;
    preferences: SubscriptionPreferencesDto;
    error?: PublicErrorDto;
}
export type OAuthStatusDto = Omit<PluginStatusDto, 'quota' | 'preferences'>;
export type SearchProviderPreference = 'dsh' | 'codex';
export interface CodexContextWindowOverridesDto {
    'gpt-5.6-sol': number;
    'gpt-5.6-terra': number;
    'gpt-5.6-luna': number;
}
export interface SubagentModelCatalogDto {
    providers: Array<{
        id: string;
        name: string;
        models: Array<{
            id: string;
            name: string;
            description?: string;
            contextWindow?: number;
            maxContextWindow?: number;
            reasoning?: {
                efforts: Array<{
                    id: string;
                    name: string;
                    description?: string;
                }>;
                defaultEffort?: string;
            };
        }>;
    }>;
    failures: Array<{
        id: string;
        name: string;
        message: string;
    }>;
}
export interface SubscriptionPreferencesDto {
    quickQuotaVisible: boolean;
    visibleModelIds: string[];
    searchProvider: SearchProviderPreference;
    subagentProvider: string;
    subagentModel: string;
    subagentReasoningEffort: string | null;
    subagentContextWindow: number;
    subagentMaxDepth: number;
    subagentMaxAgents: number;
    contextWindowOverrides: CodexContextWindowOverridesDto;
    writable: boolean;
}
export interface SubscriptionPreferencesUpdateDto {
    quickQuotaVisible?: boolean;
    visibleModelIds?: string[];
    searchProvider?: SearchProviderPreference;
    subagentProvider?: string;
    subagentModel?: string;
    subagentReasoningEffort?: string | null;
    subagentContextWindow?: number;
    subagentMaxDepth?: number;
    subagentMaxAgents?: number;
    contextWindowOverrides?: Partial<CodexContextWindowOverridesDto>;
}
export interface QuotaWindowDto {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
}
export interface QuotaBucketDto {
    id: string;
    name: string;
    planType: string | null;
    primary: QuotaWindowDto | null;
    secondary: QuotaWindowDto | null;
    windows: QuotaWindowDto[];
}
export interface QuotaCreditDto {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
}
export interface QuotaIndividualLimitDto {
    limit: string | null;
    used: string | null;
    remainingPercent: number | null;
    resetsAt: number | null;
}
export interface QuotaResetCreditsDto {
    availableCount: number;
    /** Earliest expiration among currently available reset credits, as Unix seconds. */
    expiresAt: number | null;
}
export interface QuotaUsageDto {
    buckets: QuotaBucketDto[];
    credits: QuotaCreditDto | null;
    individualLimit: QuotaIndividualLimitDto | null;
    spendControlReached: boolean | null;
    resetCredits: QuotaResetCreditsDto | null;
}
export interface QuotaStatusDto {
    state: 'signed-out' | 'empty' | 'ready' | 'stale' | 'error';
    buckets: QuotaBucketDto[];
    credits: QuotaCreditDto | null;
    individualLimit: QuotaIndividualLimitDto | null;
    spendControlReached: boolean | null;
    resetCredits: QuotaResetCreditsDto | null;
    fetchedAt: number | null;
    stale: boolean;
    error?: PublicErrorDto;
}
export interface ConnectionTestDto {
    connected: true;
    latencyMs: number;
    checkedAt: number;
}
export interface LoginStartDto {
    loginId: string;
    authUrl: string;
    expiresAt: number;
}
export type LoginEventDto = {
    type: 'pending';
    loginId: string;
} | {
    type: 'completed';
    loginId: string;
} | {
    type: 'cancelled';
    loginId: string;
} | {
    type: 'failed';
    loginId: string;
    error: PublicErrorDto;
};
export interface PublicErrorDto {
    code: 'bad-request' | 'csrf-rejected' | 'login-active' | 'login-cancelled' | 'login-expired' | 'oauth-callback-invalid' | 'oauth-token-exchange-failed' | 'not-authenticated' | 'refresh-failed' | 'storage-failed' | 'connection-failed' | 'quota-failed' | 'preference-failed' | 'rate-limited' | 'internal';
    message: string;
}
export type ApiEnvelope<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: PublicErrorDto;
};
//# sourceMappingURL=contracts.d.ts.map