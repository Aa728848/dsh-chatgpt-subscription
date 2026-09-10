import { type Server } from 'node:http';
import { FileCredentialStore, type AntigravityCredentials } from './token-store.ts';
import { type LoadCodeAssistDetailResult } from './client.ts';
export interface WebLoginFlowState {
    status: 'idle' | 'pending' | 'complete' | 'error';
    authUrl?: string;
    startedAt?: number;
    completedAt?: number;
    email?: string;
    error?: string;
    validationUrl?: string;
    progress?: string;
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
export declare function getUserEmail(token: string, fetchFn?: typeof fetch): Promise<string | undefined>;
export declare function startCallbackServer(expectedState: string): Promise<{
    server: Server;
    waitForCode: () => Promise<{
        code: string;
        state: string;
    }>;
}>;
export declare function extractGoogleValidationUrl(text: string): string | undefined;
export declare function assertFreeTierEligible(payload: LoadCodeAssistDetailResult): void;
export declare function discoverAntigravityProject(token: string, fetchFn?: typeof fetch, signal?: AbortSignal, onProgress?: (stage: string) => void): Promise<string | undefined>;
export declare function exchangeOAuthCode(code: string, verifier: string, callbackUrl: string, fetchFn?: typeof fetch, signal?: AbortSignal, onProgress?: (stage: string) => void): Promise<AntigravityCredentials>;
export declare function beginWebLogin(store: FileCredentialStore, fetchFn?: typeof fetch, signal?: AbortSignal): Promise<WebLoginFlowState>;
export declare function getWebLoginStatus(): WebLoginFlowState;
export declare function refreshAntigravityToken(credentials: AntigravityCredentials, fetchFn?: typeof fetch): Promise<AntigravityCredentials>;
export declare function ensureApiKey(store: FileCredentialStore, fetchFn?: typeof fetch): Promise<{
    token: string;
    projectId?: string;
}>;
export declare function loginAndSave(store: FileCredentialStore, signal?: AbortSignal, onUrl?: (url: string) => void, fetchFn?: typeof fetch, onProgress?: (stage: string) => void): Promise<AntigravityCredentials>;
//# sourceMappingURL=oauth.d.ts.map