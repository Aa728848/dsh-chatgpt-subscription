import { type Server } from 'node:http';
import { FileCredentialStore, type AntigravityCredentials } from './token-store.ts';
export interface WebLoginFlowState {
    status: 'idle' | 'pending' | 'complete' | 'error';
    authUrl?: string;
    startedAt?: number;
    completedAt?: number;
    email?: string;
    error?: string;
}
export declare function callbackPort(): number;
export declare function resolveCallbackHost(raw?: string | undefined): string;
export declare function redirectUri(): string;
export declare function clientId(): string;
export declare function clientSecret(): string;
export declare function generatePKCE(): {
    verifier: string;
    challenge: string;
};
export declare function openBrowser(url: string): void;
export declare function getUserEmail(token: string): Promise<string | undefined>;
export declare function startCallbackServer(expectedState: string): Promise<{
    server: Server;
    waitForCode: () => Promise<{
        code: string;
        state: string;
    }>;
}>;
export declare function exchangeOAuthCode(code: string, verifier: string, callbackUrl: string): Promise<AntigravityCredentials>;
export declare function beginWebLogin(store: FileCredentialStore): Promise<WebLoginFlowState>;
export declare function getWebLoginStatus(): WebLoginFlowState;
export declare function refreshAntigravityToken(credentials: AntigravityCredentials): Promise<AntigravityCredentials>;
export declare function ensureApiKey(store: FileCredentialStore): Promise<{
    token: string;
    projectId?: string;
}>;
export declare function loginAndSave(store: FileCredentialStore, signal?: AbortSignal, onUrl?: (url: string) => void): Promise<AntigravityCredentials>;
//# sourceMappingURL=oauth.d.ts.map