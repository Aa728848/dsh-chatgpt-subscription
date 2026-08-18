export interface SanitizedAccountDto {
    email: string | null;
    planType: string | null;
    accountIdSuffix: string | null;
    tokenExpiresAt: number;
}
export type CredentialStorageKind = 'windows-dpapi' | 'linux-file' | 'memory';
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
    error?: PublicErrorDto;
}
export type OAuthStatusDto = Omit<PluginStatusDto, 'quota'>;
export interface QuotaWindowDto {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
}
export interface QuotaBucketDto {
    id: 'codex' | 'code-review';
    name: string;
    planType: string | null;
    primary: QuotaWindowDto | null;
    secondary: QuotaWindowDto | null;
}
export interface QuotaStatusDto {
    state: 'signed-out' | 'empty' | 'ready' | 'stale' | 'error';
    buckets: QuotaBucketDto[];
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
export interface ProviderAccountDto {
    providerId: string;
    accountId: string;
    displayName: string | null;
    email: string | null;
    subscription: Record<string, unknown>;
    quota: Record<string, unknown>;
    refresh: Record<string, unknown>;
    resources: Record<string, unknown>;
    health: Record<string, unknown>;
}
export interface ProviderStatusDto {
    providerId: string;
    displayName: string;
    capabilities: string[];
    policy: string;
    defaultAccountId: string | null;
    accounts: ProviderAccountDto[];
    source?: string;
    diagnostics?: string[];
    candidates?: Array<{
        candidateId: string;
        accountId?: string;
        displayName?: string;
        email?: string;
        source?: string;
        imported?: boolean;
    }>;
}
export interface MultiProviderStatusDto {
    csrfToken: string;
    generatedAt: string;
    providers: ProviderStatusDto[];
    storage: CredentialStorageDto;
}
export interface ProviderAuthorizationDto {
    status: string;
    providerId?: string;
    sessionId?: string;
    authorizationUrl?: string;
    instructions?: string;
    browserOpened?: boolean;
    inputRequired?: boolean;
    authorizationCodeRequired?: boolean;
    diagnostic?: string;
    accounts?: ProviderAccountDto[];
}
export interface PublicErrorDto {
    code: 'bad-request' | 'csrf-rejected' | 'login-active' | 'login-cancelled' | 'login-expired' | 'oauth-callback-invalid' | 'oauth-token-exchange-failed' | 'not-authenticated' | 'refresh-failed' | 'storage-failed' | 'connection-failed' | 'quota-failed' | 'rate-limited' | 'internal';
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