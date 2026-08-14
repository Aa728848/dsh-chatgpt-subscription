import type { ConnectionTestDto, PublicErrorDto, QuotaBucketDto, QuotaStatusDto } from '../shared/contracts.ts';
import { OAuthService } from './oauth-service.ts';
type FetchLike = typeof fetch;
export interface UsageServiceOptions {
    fetchFn?: FetchLike;
    now?: () => number;
}
export declare class UsageService {
    private readonly oauth;
    private readonly fetchFn;
    private readonly now;
    private cache;
    private lastUpstreamAt;
    private blockedUntil;
    private invalidated;
    private inFlight;
    constructor(oauth: OAuthService, options?: UsageServiceOptions);
    status(authenticated: boolean, force?: boolean): Promise<QuotaStatusDto>;
    invalidate(): void;
    clear(): void;
    testConnection(): Promise<ConnectionTestDto>;
    private refreshUpstream;
    private fetch;
    private fromCache;
    private failure;
}
export declare class UsageServiceError extends Error {
    readonly publicError: PublicErrorDto;
    constructor(publicError: PublicErrorDto);
}
export declare function mapCodexUsage(value: unknown): QuotaBucketDto[];
export {};
//# sourceMappingURL=usage-service.d.ts.map