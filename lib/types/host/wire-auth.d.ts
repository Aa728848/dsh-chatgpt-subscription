import type { StoredOAuthCredentials } from './token-store.ts';
export declare function codexHeaders(credentials: StoredOAuthCredentials, sessionId?: string): Record<string, string>;
export declare function stableSessionId(value: string | undefined): string;
export declare function retryAfterMs(headers: Headers): number | undefined;
//# sourceMappingURL=wire-auth.d.ts.map