import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { installSubagentReportDedupCompat } from './host/subagent-report-scheduling-compat.ts'
import { OAuthService } from './host/oauth-service.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerRoutes } from './host/routes.ts'
import { createPlatformTokenStore } from './host/platform-token-store.ts'
import { UsageService } from './host/usage-service.ts'
import { MultiProviderAdapter } from './host/multi-provider-adapter.ts'
import { MultiProviderRuntime, SUBSCRIPTION_PROVIDER_IDS } from './host/multi-provider-runtime.ts'
import { registerMultiProviderRoutes } from './host/multi-provider-routes.ts'
import { PlatformProviderSecretStore } from './host/provider-secret-store.ts'

export const inject = ['webServer', 'llm', 'attachments', 'agents']

export function apply(ctx: Context): void {
  const store = createPlatformTokenStore()
  const oauth = new OAuthService(store, { logger: ctx.logger })
  const usage = new UsageService(oauth)
  const responses = new ResponsesClient(oauth, ctx.attachments, {
    localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
    onGenerationFinished: () => usage.invalidate(),
  })
  const adapter = new CodexChatGptAdapter(responses)
  ctx.effect(() => {
    const disposeRoutes = registerRoutes(ctx, oauth, usage)
    const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const disposeProviderAdapters: Array<() => void> = []
    let disposeProviderRoutes = (): void => {}
    let providerRuntime: MultiProviderRuntime | null = null
    try {
      const providerTokenStore = createPlatformTokenStore(undefined, 'providers')
      const providerSecretStore = new PlatformProviderSecretStore(providerTokenStore)
      providerRuntime = new MultiProviderRuntime({ secretStore: providerSecretStore, attachments: ctx.attachments })
      const providerAdapter = new MultiProviderAdapter(providerRuntime)
      disposeProviderRoutes = registerMultiProviderRoutes(ctx, providerRuntime, providerTokenStore.storage)
      for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
        try {
          disposeProviderAdapters.push(ctx.llm.registerAdapter([providerId], providerAdapter))
        } catch (error) {
          ctx.logger.warn(`[dsh-chatgpt-subscription] provider ${providerId} registration skipped: ${safeLogMessage(error)}`)
        }
      }
      void providerRuntime.init().catch((error: unknown) => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] multi-provider initialization failed: ${safeLogMessage(error)}`)
      })
    } catch (error) {
      ctx.logger.warn(`[dsh-chatgpt-subscription] optional providers unavailable; Codex remains active: ${safeLogMessage(error)}`)
    }
    // DSH_COMPAT_REMOVE(subagent-report-settlement-dedup): remove with the isolated compat module.
    const disposeSubagentReportCompat = installSubagentReportDedupCompat(ctx)
    return () => {
      disposeSubagentReportCompat()
      for (const disposeProviderAdapter of disposeProviderAdapters.reverse()) disposeProviderAdapter()
      disposeAdapter()
      disposeProviderRoutes()
      disposeRoutes()
      void providerRuntime?.dispose().catch((error: unknown) => {
        ctx.logger.warn(`[dsh-chatgpt-subscription] provider disposal failed: ${safeLogMessage(error)}`)
      })
      oauth.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export { OAuthService } from './host/oauth-service.ts'
export { CodexChatGptAdapter } from './host/adapter.ts'
export { MultiProviderAdapter } from './host/multi-provider-adapter.ts'
export { MultiProviderRuntime, SUBSCRIPTION_PROVIDER_IDS } from './host/multi-provider-runtime.ts'
export { PlatformProviderSecretStore } from './host/provider-secret-store.ts'
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts'
export { UsageService, mapCodexUsage } from './host/usage-service.ts'
export { createPlatformTokenStore } from './host/platform-token-store.ts'
export { LinuxFileTokenStore } from './host/token-store-linux.ts'
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts'
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts'

function safeLogMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/((?:token|secret|authorization|code|verifier|api.?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}
