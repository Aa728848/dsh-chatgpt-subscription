import type { Context } from '@deepseek-ai/cordis';
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { OAuthService } from './host/oauth-service.ts';
export { CodexChatGptAdapter } from './host/adapter.ts';
export { createCodexImageTool } from './host/codex-images.ts';
export { createCodexSearchProvider } from './host/codex-search.ts';
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts';
export { UsageService, mapCodexUsage, parseCodexUsage } from './host/usage-service.ts';
export { createPlatformTokenStore } from './host/platform-token-store.ts';
export { LinuxFileTokenStore } from './host/token-store-linux.ts';
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts';
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts';
//# sourceMappingURL=index.d.ts.map