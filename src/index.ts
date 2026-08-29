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

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'web', 'settings', 'loader']

export function apply(ctx: Context): void {
  const store = createPlatformTokenStore()
  const preferences = registerPreferenceStore(ctx.settings)

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

    // Transparently inject reasoning effort overrides for any registered provider/model
    const origResolveCallConfig = ctx.llm.resolveCallConfig?.bind(ctx.llm)
    const origResolveModelInfo = ctx.llm.resolveModelInfo?.bind(ctx.llm)
    if (origResolveCallConfig) {
      ctx.llm.resolveCallConfig = async (options, signal) => {
        const status = preferences.status()
        const modelKey = `${options.provider}/${options.model}`
        const customEffort = status.subagentModelEfforts?.[modelKey]
          ?? (options.provider === PROVIDER_ID ? status.subagentReasoningEffort : undefined)
        if (options.reasoningEffort === undefined && customEffort) {
          options = { ...options, reasoningEffort: customEffort as never }
        }
        return origResolveCallConfig(options, signal)
      }
    }
    if (origResolveModelInfo) {
      ctx.llm.resolveModelInfo = async (provider, model) => {
        const info = await origResolveModelInfo(provider, model)
        const status = preferences.status()
        const modelKey = `${provider}/${model}`
        const customEffort = status.subagentModelEfforts?.[modelKey]
          ?? (provider === PROVIDER_ID ? status.subagentReasoningEffort : undefined)
        if (customEffort && info?.reasoning && (info.reasoning.efforts as readonly { id: string }[]).some(e => e.id === customEffort)) {
          return {
            ...info,
            reasoning: {
              ...info.reasoning,
              defaultEffort: customEffort as never,
            },
          }
        }
        return info
      }
    }

    return () => {
      if (origResolveCallConfig) ctx.llm.resolveCallConfig = origResolveCallConfig
      if (origResolveModelInfo) ctx.llm.resolveModelInfo = origResolveModelInfo
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

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}
