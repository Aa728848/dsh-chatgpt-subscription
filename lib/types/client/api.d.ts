import type { LoginEventDto, LoginStartDto, PluginStatusDto, QuotaStatusDto, ConnectionTestDto } from '../shared/contracts.ts';
export declare class SubscriptionApi {
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
}
export declare function parseLoginEvent(event: MessageEvent<string>): LoginEventDto | null;
//# sourceMappingURL=api.d.ts.map