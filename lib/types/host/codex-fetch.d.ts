import { type WebFetchProvider } from '@deepseek-ai/dsh-web';
type FetchLike = typeof fetch;
export interface CodexFetchProviderOptions {
    fetchFn?: FetchLike;
    maxResponseBytes?: number;
    maxBodyChars?: number;
}
export declare function createCodexFetchProvider(options?: CodexFetchProviderOptions): WebFetchProvider;
export {};
//# sourceMappingURL=codex-fetch.d.ts.map