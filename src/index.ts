import type { Context } from '@deepseek-ai/cordis'
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

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'web', 'settings', 'loader']

export function apply(ctx: Context): void {
  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)

  // 挂载 Antigravity 独立 Provider 与 Web 路由
  const antigravityStore = new FileCredentialStore()
  const antigravityModelSettings = new FileModelSettingsStore()
  const antigravityPreferences = registerAntigravityPreferenceStore(ctx.settings, antigravityModelSettings)
  const antigravityAdapter = new AntigravityAdapter(antigravityStore, antigravityModelSettings, antigravityPreferences)

  ctx.effect(() => {
    const disposeAntigravityAdapter = ctx.llm.registerAdapter([ANTIGRAVITY_PROVIDER_ID], antigravityAdapter)
    const disposeAntigravityRoutes = registerAntigravityRoutes(
      ctx,
      antigravityStore,
      antigravityModelSettings,
      antigravityPreferences,
    )

    return () => {
      disposeAntigravityRoutes()
      disposeAntigravityAdapter()
    }
  }, 'dsh-antigravity: adapter, routes, and lifecycle')

  ctx.effect(() => {
    const proxyManager = new ProxyManager({
      getPreferences: () => preferences.status(),
      logger: ctx.logger,
    })
    const proxyFetch = proxyManager.createFetch()
    const oauth = new OAuthService(store, { fetchFn: proxyFetch, logger: ctx.logger })
    const usage = new UsageService(oauth, { fetchFn: proxyFetch })
    const responses = new ResponsesClient(oauth, ctx.attachments, {
      fetchFn: proxyFetch,
      localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
      onGenerationFinished: () => usage.invalidate(),
      outputVerbosity: () => preferences.status().outputVerbosity,
      fastMode: () => preferences.status().fastMode,
    })
    const adapter = new CodexChatGptAdapter(responses, preferences)

    const searchSwitcher = new SearchProviderSwitcher(ctx.loader)
    const applySearchPreference = (searchProvider = preferences.status().searchProvider): void => {
      void searchSwitcher.select(searchProvider).catch(error => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] Search provider preference could not be applied: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences, proxyManager)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments, { fetchFn: proxyFetch }))

    // Bind search and fetch providers dynamically to ctx.web so they survive loader reloads
    let disposeWebProviders = () => {}
    const registerWebProviders = () => {
      disposeWebProviders()
      if (ctx.web) {
        const d1 = ctx.web.registerSearchProvider(createCodexSearchProvider(oauth, { fetchFn: proxyFetch }))
        const d2 = ctx.web.registerFetchProvider(createCodexFetchProvider({ fetchFn: proxyFetch }))
        disposeWebProviders = () => { d1(); d2() }
      }
    }
    registerWebProviders()

    const disposePreferenceWatch = preferences.watch(next => applySearchPreference(next.searchProvider))
    applySearchPreference()

    return () => {
      disposePreferenceWatch()
      disposeWebProviders()
      disposeImageTool()
      disposeAdapter()
      disposeRoutes()
      oauth.dispose()
      proxyManager.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export { ProxyManager, detectSystemProxy } from './host/proxy-manager.ts'
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
export { fetchAccountQuota, getCachedQuota } from './host/antigravity/client.ts'

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}
