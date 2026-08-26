import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { createCodexImageTool } from './host/codex-images.ts'
import { createCodexSearchProvider } from './host/codex-search.ts'
import { OAuthService } from './host/oauth-service.ts'
import { registerPreferenceStore } from './host/preferences.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerRoutes } from './host/routes.ts'
import { createPlatformTokenStore } from './host/platform-token-store.ts'
import { SearchProviderSwitcher } from './host/search-provider-switcher.ts'
import { SubagentContextAdapter } from './host/subagent-context-adapter.ts'
import { installSubagentModelPreference } from './host/subagent-model-preference.ts'
import { installSubagentPolicy } from './host/subagent-policy.ts'
import { UsageService } from './host/usage-service.ts'

export const inject = ['webServer', 'llm', 'attachments', 'tools', 'web', 'settings', 'loader', 'agents']

export function apply(ctx: Context): void {
  const store = createPlatformTokenStore()
  const oauth = new OAuthService(store, { logger: ctx.logger })
  const usage = new UsageService(oauth)
  const preferences = registerPreferenceStore(ctx.settings)
  const responses = new ResponsesClient(oauth, ctx.attachments, {
    localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
    onGenerationFinished: () => usage.invalidate(),
    outputVerbosity: () => preferences.status().outputVerbosity,
  })
  const adapter = new CodexChatGptAdapter(responses, preferences)
  ctx.effect(() => {
    const searchSwitcher = new SearchProviderSwitcher(ctx.loader)
    const applySearchPreference = (searchProvider = preferences.status().searchProvider): void => {
      void searchSwitcher.select(searchProvider).catch(error => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] Search provider preference could not be applied: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const disposeRoutes = registerRoutes(ctx, oauth, usage, preferences)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const subagentContextAdapter = new SubagentContextAdapter(ctx.llm, () => {
      const selected = preferences.status()
      return { provider: selected.subagentProvider, model: selected.subagentModel, contextWindow: selected.subagentContextWindow }
    })
    const disposeSubagentContextAdapter = ctx.llm.registerAdapter([SubagentContextAdapter.provider], subagentContextAdapter)
    const disposeSubagentModelPreference = installSubagentModelPreference(ctx, preferences)
    const disposeSubagentPolicy = installSubagentPolicy(ctx, preferences)
    const disposeImageTool = ctx.tools.register(createCodexImageTool(oauth, ctx.attachments))
    const disposeSearchProvider = ctx.web.registerSearchProvider(createCodexSearchProvider(oauth))
    const disposePreferenceWatch = preferences.watch(next => applySearchPreference(next.searchProvider))
    applySearchPreference()
    return () => {
      disposePreferenceWatch()
      disposeSubagentPolicy()
      disposeSubagentModelPreference()
      disposeSearchProvider()
      disposeImageTool()
      disposeSubagentContextAdapter()
      disposeAdapter()
      disposeRoutes()
      oauth.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export { OAuthService } from './host/oauth-service.ts'
export { CodexChatGptAdapter } from './host/adapter.ts'
export { createCodexImageTool } from './host/codex-images.ts'
export { createCodexSearchProvider } from './host/codex-search.ts'
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
