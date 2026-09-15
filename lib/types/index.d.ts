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
export { RELAY_PROBE_ENV, RELAY_PROBE_FILE_ENV, RELAY_PROBE_FILE_NAME, RELAY_PROBE_MAX_BYTES, RELAY_SOURCE_KINDS, RelayProbe, createFileRelayProbeSink, installRelayProbe, relayProbeEnabled, relayProbeEnvFile, relayProbeEnvValue, relayProbeLogPath, } from './host/relay-probe.ts';
export type { AgentsLookup, ProbeAgent, ProbeEvent, ProbeSession, RelayProbeContext, RelayProbeOptions, RelayProbeSink, } from './host/relay-probe.ts';
export { ProxyManager, detectSystemProxy } from './host/proxy-manager.ts';
export { SUBAGENT_MODEL_SELECTION_NAMESPACE, SUBAGENT_POLICY_EVENT, authorizedRoutesFor, createSubagentAuthorization, delegationDenialReason, installSubagentModelAuthorization, normalizeDelegationToolNames, parseAllowedRoutes, policyRoutesOf, subagentModelSelectionPreference, unauthorizedRouteReason, validateAuthorizationScope, validateDelegationToolNames, } from './host/subagent-model-authorization.ts';
export { OAuthService } from './host/oauth-service.ts';
export { CodexChatGptAdapter } from './host/adapter.ts';
export { createCodexImageTool } from './host/codex-images.ts';
export { createCodexSearchProvider } from './host/codex-search.ts';
export { createCodexFetchProvider } from './host/codex-fetch.ts';
export { SearchProviderSwitcher, type SearchProviderSwitcherStatus } from './host/search-provider-switcher.ts';
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts';
export { UsageService, mapCodexUsage, parseCodexUsage } from './host/usage-service.ts';
export { createPlatformTokenStore } from './host/platform-token-store.ts';
export { MacKeychainTokenStore } from './host/token-store-macos.ts';
export { LinuxFileTokenStore } from './host/token-store-linux.ts';
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts';
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts';
export { AntigravityAdapter } from './host/antigravity/adapter.ts';
export { CommandCodeAdapter } from './host/command-code/adapter.ts';
export { FileCredentialStore as CommandCodeCredentialStore, FileModelSettingsStore as CommandCodeModelSettingsStore, credentialPath as commandCodeCredentialPath, modelSettingsPath as commandCodeModelSettingsPath, registerCommandCodePreferenceStore, } from './host/command-code/token-store.ts';
export { beginWebLogin as startCommandCodeLogin, getWebLoginStatus as getCommandCodeLoginStatus, saveApiKey as saveCommandCodeApiKey, } from './host/command-code/oauth.ts';
export { getCommandCodeWebStatus, registerCommandCodeRoutes } from './host/command-code/routes.ts';
export { fetchAccountQuota as fetchCommandCodeQuota, clearCachedQuota as clearCommandCodeQuota, getCachedQuota as getCommandCodeQuota, loadProviderModels as loadCommandCodeModels, } from './host/command-code/client.ts';
export { KimiCodeAdapter, classifyKimiFailure, KIMI_CODE_RETRY_POLICY_CONFIG } from './host/kimi-code/adapter.ts';
export { FileCredentialStore as KimiCodeCredentialStore, FileModelSettingsStore as KimiCodeModelSettingsStore, credentialPath as kimiCodeCredentialPath, modelSettingsPath as kimiCodeModelSettingsPath, registerKimiCodePreferenceStore, resolveRegion as resolveKimiCodeRegion, } from './host/kimi-code/token-store.ts';
export { beginWebLogin as beginKimiCodeLogin, ensureAccessToken as ensureKimiCodeAccessToken, getWebLoginStatus as getKimiCodeLoginStatus, refreshAccessToken as refreshKimiCodeToken, requestDeviceAuthorization as requestKimiCodeDeviceAuthorization, } from './host/kimi-code/oauth.ts';
export { fetchAccountQuota as fetchKimiCodeQuota, fetchUserInfo as fetchKimiCodeUserInfo, loadProviderModels as loadKimiCodeModels, clearCachedQuota as clearKimiCodeQuota, getCachedQuota as getKimiCodeQuota, } from './host/kimi-code/client.ts';
export { getKimiCodeWebStatus, registerKimiCodeRoutes } from './host/kimi-code/routes.ts';
export { KIMI_CODE_MODELS, kimiCodeModelDef, } from './host/kimi-code/model-catalog.ts';
export { FileCredentialStore, FileModelSettingsStore, credentialPath, modelSettingsPath, } from './host/antigravity/token-store.ts';
export { loginAndSave, beginWebLogin, refreshAntigravityToken } from './host/antigravity/oauth.ts';
export { clearCachedQuota, fetchAccountQuota, getCachedQuota } from './host/antigravity/client.ts';
//# sourceMappingURL=index.d.ts.map