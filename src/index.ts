import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { createCodexFetchProvider } from './host/codex-fetch.ts'
import { createCodexImageTool } from './host/codex-images.ts'
import { createCodexSearchProvider } from './host/codex-search.ts'
import { OAuthService } from './host/oauth-service.ts'
import { ProxyManager } from './host/proxy-manager.ts'
import { registerPreferenceStore } from './host/preferences.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerRoutes } from './host/routes.ts'
import { createPlatformTokenStore } from './host/platform-token-store.ts'
import { SearchProviderSwitcher } from './host/search-provider-switcher.ts'
import type { SubscriptionPreferencesDto } from './shared/contracts.ts'
import { UsageService } from './host/usage-service.ts'
import { AntigravityAdapter } from './host/antigravity/adapter.ts'
import { registerAntigravityRoutes } from './host/antigravity/routes.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  registerAntigravityPreferenceStore,
  credentialPath,
  modelSettingsPath,
} from './host/antigravity/token-store.ts'
import { PROVIDER_ID as ANTIGRAVITY_PROVIDER_ID } from './host/antigravity/types.ts'
import {
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  validateDelegationToolNames,
  type SessionsResolver,
} from './host/subagent-model-authorization.ts'

/** Optional deployment configuration for this plugin. */
export interface Config {
  /**
   * Whether the Subagent model allowlist also governs the route a delegation
   * that selects no model would inherit from its parent. Default `true`; set
   * `false` to leave inherited routes to the built-in delegation tool.
   */
  subagentModelAuthorization?: boolean
  /** Delegation tool names the authorization guard recognizes (default `subagent`). */
  subagentModelTools?: string[]
  /**
   * `session` (default) enforces the allowlist a Session recorded, matching the
   * delegation tool's snapshot; `preference` also enforces the current Settings
   * card allowlist for Sessions that recorded none.
   */
  subagentModelScope?: 'session' | 'preference'
}

export const Config: z<Config> = z.object({
  subagentModelAuthorization: z.boolean().default(true),
  subagentModelTools: z.array(z.string()).default([]),
  subagentModelScope: z.union([z.const('session'), z.const('preference')]).default('session'),
})

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'settings', 'loader']

export function apply(ctx: Context, pluginConfig: Config = {}): void {
  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)

  const antigravityStore = new FileCredentialStore()
  const antigravityModelSettings = new FileModelSettingsStore()
  const antigravityPreferences = registerAntigravityPreferenceStore(ctx.settings, antigravityModelSettings)

  // The allowlist a Session recorded outranks the current settings document,
  // because the built-in delegation tool snapshot it when the Session started.
  const delegationToolNames = normalizeDelegationToolNames(pluginConfig.subagentModelTools)
  if (pluginConfig.subagentModelAuthorization !== false) {
    ctx.inject(['sessions'], scoped => {
      const sessions = scoped.get('sessions') as SessionsResolver | undefined
      if (sessions === undefined) return
      scoped.effect(() => {
        // A tools service without the guard extension keeps the built-in
        // delegation behavior instead of failing this plugin's load.
        if (typeof scoped.tools?.guard !== 'function') return () => undefined
        return installSubagentModelAuthorization(scoped, sessions, {
          toolNames: delegationToolNames,
          scope: pluginConfig.subagentModelScope ?? 'session',
        })
      }, 'dsh-chatgpt-subscription: subagent model authorization')
    })
  }

  ctx.effect(() => {
    const proxyManager = new ProxyManager({
      getPreferences: () => preferences.status(),
      logger: ctx.logger,
    })
    const proxyFetch = proxyManager.createFetch()
    const antigravityAdapter = new AntigravityAdapter(
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      { fetchFn: proxyFetch },
    )
    const disposeAntigravityAdapter = ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER_ID], antigravityAdapter)
    const disposeAntigravityRoutes = registerAntigravityRoutes(
      ctx,
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
      proxyFetch,
    )
    const oauth = new OAuthService(store, { fetchFn: proxyFetch, logger: ctx.logger })
    const usage = new UsageService(oauth, { fetchFn: proxyFetch })
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: proxyFetch,
      localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
      onGenerationFinished: () => usage.invalidate(),
      outputVerbosity: () => preferences.status().outputVerbosity,
      fastMode: () => preferences.status().fastMode,
      reasoningSummary: () => preferences.status().reasoningSummary,
    })
    const adapter = new CodexChatGptAdapter(responses, preferences)

    const searchSwitcher = new SearchProviderSwitcher(ctx.loader)
    // DSH's built-in fetch provider resolves and pins the addresses this machine's resolver
    // returns, and it proxies only when the process environment names a proxy — the OS proxy this
    // plugin reads is invisible to it. On a machine whose proxy tool answers DNS with its own
    // fake-ip range (Clash/Mihomo's 198.18.0.0/15, the usual companion of a system proxy) that
    // combination fails every `web_fetch` with WEB_BLOCKED_URL before the proxy is ever consulted.
    // While this plugin has a proxy to route through, its own provider serves the tool instead:
    // the proxy resolves the origin, exactly like a hop DSH routes through a proxy, and the
    // provider still refuses non-public addresses a URL states outright. With no proxy configured
    // the built-in provider keeps the tool, resolution pinning and all.
    const applyWebProviders = (current: SubscriptionPreferencesDto = preferences.status()): void => {
      const pluginFetch = proxyManager.resolveActiveProxyUrl() !== null
      void searchSwitcher.select(current.searchProvider, { pluginFetch }).catch(error => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] Web provider selection could not be applied: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences, proxyManager)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }))

    // Rebind providers when web reloads without resetting the saved default provider selection.
    ctx.inject(['web'], ctx => {
      ctx.web.registerSearchProvider(createCodexSearchProvider(oauth, { fetchFn: proxyFetch }))
      ctx.web.registerFetchProvider(createCodexFetchProvider({ fetchFn: proxyFetch }))
      applyWebProviders()
    })

    // Any preference can change the selection: the search picker chooses the search backend, and
    // the proxy settings decide whether this plugin's provider is the one that can reach the web.
    const disposePreferenceWatch = preferences.watch(next => applyWebProviders(next))

    return () => {
      disposePreferenceWatch()
      disposeImageTool()
      disposeAdapter()
      disposeRoutes()
      disposeAntigravityRoutes()
      disposeAntigravityAdapter()
      oauth.dispose()
      proxyManager.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export { ProxyManager, detectSystemProxy } from './host/proxy-manager.ts'
export {
  SUBAGENT_MODEL_SELECTION_NAMESPACE,
  SUBAGENT_POLICY_EVENT,
  authorizedRoutesFor,
  createSubagentAuthorization,
  delegationDenialReason,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  parseAllowedRoutes,
  policyRoutesOf,
  subagentModelSelectionPreference,
  unauthorizedRouteReason,
  validateAuthorizationScope,
  validateDelegationToolNames,
} from './host/subagent-model-authorization.ts'
export { OAuthService } from './host/oauth-service.ts'
export { CodexChatGptAdapter } from './host/adapter.ts'
export { createCodexImageTool } from './host/codex-images.ts'
export { createCodexSearchProvider } from './host/codex-search.ts'
export { createCodexFetchProvider } from './host/codex-fetch.ts'
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts'
export { UsageService, mapCodexUsage, parseCodexUsage } from './host/usage-service.ts'
export { createPlatformTokenStore } from './host/platform-token-store.ts'
export { MacKeychainTokenStore } from './host/token-store-macos.ts'
export { LinuxFileTokenStore } from './host/token-store-linux.ts'
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts'
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts'

export { AntigravityAdapter } from './host/antigravity/adapter.ts'
export {
  FileCredentialStore,
  FileModelSettingsStore,
  credentialPath,
  modelSettingsPath,
} from './host/antigravity/token-store.ts'
export { loginAndSave, beginWebLogin, refreshAntigravityToken } from './host/antigravity/oauth.ts'
export { clearCachedQuota, fetchAccountQuota, getCachedQuota } from './host/antigravity/client.ts'

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}