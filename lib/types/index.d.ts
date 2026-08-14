import type { Context } from '@deepseek-ai/cordis';
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { OAuthService } from './host/oauth-service.ts';
export { CodexChatGptAdapter } from './host/adapter.ts';
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts';
export { UsageService, mapCodexUsage } from './host/usage-service.ts';
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts';
//# sourceMappingURL=index.d.ts.map