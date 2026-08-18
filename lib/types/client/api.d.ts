import type { LoginEventDto, LoginStartDto, PluginStatusDto, QuotaStatusDto, ConnectionTestDto, MultiProviderStatusDto, ProviderAuthorizationDto } from '../shared/contracts.ts';
export declare class SubscriptionApi {
    private providerCsrfToken;
    status(): Promise<PluginStatusDto>;
    startLogin(): Promise<LoginStartDto>;
    cancelLogin(loginId: string): Promise<{
        cancelled: boolean;
    }>;
    logout(): Promise<{
        authenticated: false;
    }>;
    refresh(): Promise<PluginStatusDto>;
    refreshQuota(): Promise<QuotaStatusDto>;
    testConnection(): Promise<ConnectionTestDto>;
    events(loginId: string): EventSource;
    providers(): Promise<MultiProviderStatusDto>;
    scanProvider(providerId?: string): Promise<ProviderOperationDto>;
    importProviderCandidate(providerId: string, candidateId: string): Promise<ProviderOperationDto>;
    startProviderLogin(providerId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>>;
    pollProviderLogin(providerId: string, sessionId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>>;
    submitProviderCode(providerId: string, sessionId: string, code: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>>;
    cancelProviderLogin(providerId: string, sessionId: string): Promise<ProviderOperationDto<ProviderAuthorizationDto>>;
    refreshProvider(providerId?: string): Promise<ProviderOperationDto>;
    removeProviderAccount(providerId: string, accountId: string): Promise<ProviderOperationDto>;
    private providerPost;
}
export interface ProviderOperationDto<T = unknown> {
    result: T;
    snapshot: MultiProviderStatusDto;
}
export declare function parseLoginEvent(event: MessageEvent<string>): LoginEventDto | null;
//# sourceMappingURL=api.d.ts.map