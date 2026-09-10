import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Optional deployment configuration for this plugin. */
export interface Config {
    /**
     * Whether the Subagent model allowlist also governs the route a delegation
     * that selects no model would inherit from its parent. Default `true`; set
     * `false` to leave inherited routes to the built-in delegation tool.
     */
    subagentModelAuthorization?: boolean;
    /** Delegation tool names the authorization guard recognizes (default `subagent`). */
    subagentModelTools?: string[];
    /**
     * `session` (default) enforces the allowlist a Session recorded, matching the
     * delegation tool's snapshot; `preference` also enforces the current Settings
     * card allowlist for Sessions that recorded none.
     */
    subagentModelScope?: 'session' | 'preference';
}
export declare const Config: z<Config>;
export declare const inject: string[];
export declare function apply(ctx: Context, pluginConfig?: Config): void;
export { ProxyManager, detectSystemProxy } from './host/proxy-manager.ts';
export { SUBAGENT_MODEL_SELECTION_NAMESPACE, SUBAGENT_POLICY_EVENT, authorizedRoutesFor, createSubagentAuthorization, delegationDenialReason, installSubagentModelAuthorization, normalizeDelegationToolNames, parseAllowedRoutes, policyRoutesOf, subagentModelSelectionPreference, unauthorizedRouteReason, validateAuthorizationScope, validateDelegationToolNames, } from './host/subagent-model-authorization.ts';
export { OAuthService } from './host/oauth-service.ts';
export { CodexChatGptAdapter } from './host/adapter.ts';
export { createCodexImageTool } from './host/codex-images.ts';
export { createCodexSearchProvider } from './host/codex-search.ts';
export { createCodexFetchProvider } from './host/codex-fetch.ts';
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts';
export { UsageService, mapCodexUsage, parseCodexUsage } from './host/usage-service.ts';
export { createPlatformTokenStore } from './host/platform-token-store.ts';
export { MacKeychainTokenStore } from './host/token-store-macos.ts';
export { LinuxFileTokenStore } from './host/token-store-linux.ts';
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts';
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts';
export { AntigravityAdapter } from './host/antigravity/adapter.ts';
export { FileCredentialStore, FileModelSettingsStore, credentialPath, modelSettingsPath, } from './host/antigravity/token-store.ts';
export { loginAndSave, beginWebLogin, refreshAntigravityToken } from './host/antigravity/oauth.ts';
export { clearCachedQuota, fetchAccountQuota, getCachedQuota } from './host/antigravity/client.ts';
//# sourceMappingURL=index.d.ts.map