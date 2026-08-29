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
    allProviders?: ProviderCatalogGroupDto[];
    detectedProxy?: string | null;
    activeProxy?: string | null;
    error?: PublicErrorDto;
}
export type OAuthStatusDto = Omit<PluginStatusDto, 'quota' | 'preferences'>;
export type CodexOutputVerbosity = 'low' | 'medium' | 'high';
export interface CodexContextWindowOverridesDto {
    'gpt-5.6-sol': number;
    'gpt-5.6-terra': number;
    'gpt-5.6-luna': number;
}
export interface ProviderCatalogModelDto {
    id: string;
    name: string;
    reasoningEfforts: string[];
}
export interface ProviderCatalogGroupDto {
    id: string;
    name: string;
    models: ProviderCatalogModelDto[];
}
export type ProxyMode = 'auto' | 'custom' | 'direct';
export interface SubscriptionPreferencesDto {
    quickQuotaVisible: boolean;
    fastMode: boolean;
    outputVerbosity: CodexOutputVerbosity | null;
    visibleModelIds: string[];
    contextWindowOverrides: CodexContextWindowOverridesDto;
    subagentReasoningEffort: string | null;
    subagentContextWindow: number | null;
    subagentMaxDepth: number | null;
    subagentModelEfforts: Record<string, string | null>;
    proxyMode: ProxyMode;
    customProxyUrl: string | null;
    writable: boolean;
}
export interface SubscriptionPreferencesUpdateDto {
    quickQuotaVisible?: boolean;
    fastMode?: boolean;
    outputVerbosity?: CodexOutputVerbosity | null;
    visibleModelIds?: string[];
    contextWindowOverrides?: Partial<CodexContextWindowOverridesDto>;
    subagentReasoningEffort?: string | null;
    subagentContextWindow?: number | null;
    subagentMaxDepth?: number | null;
    subagentModelEfforts?: Record<string, string | null>;
    proxyMode?: ProxyMode;
    customProxyUrl?: string | null;
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