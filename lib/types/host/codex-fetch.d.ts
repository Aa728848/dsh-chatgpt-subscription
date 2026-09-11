import { type WebFetchProvider } from '@deepseek-ai/dsh-web';
type FetchLike = typeof fetch;
/** Resolves a hostname to every address this machine's resolver returns. */
export type HostAddressResolver = (hostname: string) => Promise<readonly string[]>;
export interface CodexFetchProviderOptions {
    fetchFn?: FetchLike;
    maxResponseBytes?: number;
    maxBodyChars?: number;
    /**
     * Address lookup behind the destination policy. Overridden only by focused
     * tests; the policy itself is what every request goes through.
     */
    resolveHostAddresses?: HostAddressResolver;
}
export declare function createCodexFetchProvider(options?: CodexFetchProviderOptions): WebFetchProvider;
export {};
//# sourceMappingURL=codex-fetch.d.ts.map