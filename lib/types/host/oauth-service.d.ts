import type { LoginEventDto, LoginStartDto, OAuthStatusDto, PublicErrorDto } from '../shared/contracts.ts';
import type { StoredOAuthCredentials, TokenStore } from './token-store.ts';
type FetchLike = typeof fetch;
type LoginListener = (event: LoginEventDto) => void;
interface OAuthClaims {
    email?: unknown;
    chatgpt_account_id?: unknown;
    chatgpt_plan_type?: unknown;
    organizations?: Array<{
        id?: unknown;
    }>;
    'https://api.openai.com/auth'?: {
        chatgpt_account_id?: unknown;
        chatgpt_plan_type?: unknown;
        organizations?: Array<{
            id?: unknown;
        }>;
    };
}
export declare class OAuthServiceError extends Error {
    readonly code: PublicErrorDto['code'];
    constructor(code: PublicErrorDto['code'], message: string);
}
export interface OAuthServiceOptions {
    fetchFn?: FetchLike;
    now?: () => number;
    random?: (size: number) => Buffer;
    logger?: Pick<Console, 'info' | 'warn'>;
    /** Test seam; production always uses the five-minute compatibility default. */
    loginTimeoutMs?: number;
}
export declare class OAuthService {
    private readonly store;
    private readonly fetchFn;
    private readonly now;
    private readonly random;
    private readonly logger;
    private readonly loginTimeoutMs;
    private readonly loginEvents;
    private readonly listeners;
    private activeLogin;
    private refreshPromise;
    private lastLoginError;
    private disposed;
    constructor(store: TokenStore, options?: OAuthServiceOptions);
    status(): Promise<OAuthStatusDto>;
    startLogin(): Promise<LoginStartDto>;
    cancelLogin(loginId: string): void;
    subscribe(loginId: string, listener: LoginListener): (() => void) | null;
    refresh(): Promise<OAuthStatusDto>;
    logout(): Promise<void>;
    credentials(forceRefresh?: boolean): Promise<StoredOAuthCredentials>;
    dispose(): void;
    private exchangeCode;
    private refreshCredentials;
    private performRefresh;
    private loadAuthenticated;
    private statusFromCredentials;
    private completeLogin;
    private failLogin;
    private cancelActive;
    private publish;
    private assertAvailable;
}
export declare function buildAuthorizationUrl(verifier: string, state: string): string;
export declare function parseJwtClaims(token: string | undefined): OAuthClaims | undefined;
export declare function publicError(error: unknown, fallback?: PublicErrorDto['code']): PublicErrorDto;
export {};
//# sourceMappingURL=oauth-service.d.ts.map