import { type WebSearchProvider } from '@deepseek-ai/dsh-web';
import { OAuthService } from './oauth-service.ts';
type FetchLike = typeof fetch;
export interface CodexSearchProviderOptions {
    fetchFn?: FetchLike;
    model?: string;
    idFactory?: () => string;
}
export declare function createCodexSearchProvider(oauth: OAuthService, options?: CodexSearchProviderOptions): WebSearchProvider;
export {};
//# sourceMappingURL=codex-search.d.ts.map