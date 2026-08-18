import type { Context } from '@deepseek-ai/cordis';
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { OAuthService } from './host/oauth-service.ts';
export { CodexChatGptAdapter } from './host/adapter.ts';
export { MultiProviderAdapter } from './host/multi-provider-adapter.ts';
export { MultiProviderRuntime, SUBSCRIPTION_PROVIDER_IDS } from './host/multi-provider-runtime.ts';
export { PlatformProviderSecretStore } from './host/provider-secret-store.ts';
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts';
export { UsageService, mapCodexUsage } from './host/usage-service.ts';
export { createPlatformTokenStore } from './host/platform-token-store.ts';
export { LinuxFileTokenStore } from './host/token-store-linux.ts';
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts';
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts';
//# sourceMappingURL=index.d.ts.map