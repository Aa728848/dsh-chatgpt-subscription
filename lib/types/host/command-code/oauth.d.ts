import { type Server } from 'node:http';
import { FileCredentialStore } from './token-store.ts';
import type { CommandCodeAccount } from '../../shared/command-code-contracts.ts';
export type CommandCodeLoginStatus = 'idle' | 'pending' | 'complete' | 'error';
export interface CommandCodeLoginFlowState {
    status: CommandCodeLoginStatus;
    authUrl?: string;
    startedAt?: number;
    completedAt?: number;
    progress?: string;
    account?: CommandCodeAccount;
    error?: string;
}
/** Credential body the studio POSTs back to the loopback callback. */
export interface CommandCodeCallbackCredentials {
    apiKey: string;
    state: string;
    userId: string;
    userName: string;
    keyName: string;
}
export declare function getWebLoginStatus(): CommandCodeLoginFlowState;
/** Reset the flow so a cancelled attempt cannot keep a later one from starting. */
export declare function resetWebLogin(): void;
export declare function openBrowser(url: string): void;
/** Browser sign-in URL; identical shape to the official CLI's. */
export declare function buildAuthUrl(input: {
    port: number;
    state: string;
}): string;
/** State token the studio must echo back; 32 random bytes, base64url. */
export declare function generateState(): string;
/**
 * First free loopback port in the CLI's probe range.
 *
 * The studio receives the port in the callback URL, so any free port works;
 * starting at the CLI's own default keeps behavior identical on a machine where
 * a server-side allowlist is ever introduced.
 */
export declare function findAvailablePort(start?: number, attempts?: number): Promise<number>;
export interface CommandCodeAuthServerHandle {
    server: Server;
    port: number;
    /** Resolves once the studio has posted a credential (or rejects on denial). */
    waitForCredentials: () => Promise<CommandCodeCallbackCredentials>;
    close: () => void;
}
/**
 * One-shot loopback server the Command Code studio page posts the freshly
 * minted API key to.
 *
 * The contract is the official CLI's, because the studio page is the same
 * client: the browser POSTs `{apiKey,state,userId,userName,keyName}` as JSON or
 * form data from `https://commandcode.ai`, so the endpoint must answer the
 * cross-origin preflight (including Chrome's private-network request header)
 * and then redirect the tab to a human-readable completion page.
 *
 * @param port - loopback port to bind; the caller resolved a free one.
 * @param expectedState - state token the studio must echo back.
 * @param options - landing grace and clock seams for tests.
 */
export declare function createAuthServer(port: number, expectedState: string, options?: {
    landingGraceMs?: number;
}): Promise<CommandCodeAuthServerHandle>;
/**
 * Start the browser sign-in.
 *
 * Resolves immediately with the flow state the settings card polls; the
 * credential is validated against `/alpha/whoami` and persisted in the
 * background, exactly like the manual key path, so a key that cannot
 * authenticate is never stored.
 */
export declare function beginWebLogin(store: FileCredentialStore, options?: {
    fetchFn?: typeof fetch;
    openBrowser?: (url: string) => void;
    timeoutMs?: number;
}): Promise<CommandCodeLoginFlowState>;
/**
 * Persist a manually entered API key after proving it authenticates.
 *
 * Manual entry is the recovery path when the browser flow is unavailable
 * (headless host, blocked popup, or a key minted in Command Code Studio).
 */
export declare function saveApiKey(store: FileCredentialStore, apiKey: string, options?: {
    fetchFn?: typeof fetch;
}): Promise<CommandCodeAccount>;
/** Stable per-attempt id the settings card can correlate; kept for symmetry with other routes. */
export declare function newLoginAttemptId(): string;
//# sourceMappingURL=oauth.d.ts.map