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
    // DSH_COMPAT_REMOVE(subagent-report-settlement-dedup): remove with the isolated compat module.
    const disposeSubagentReportCompat = installSubagentReportDedupCompat(ctx)
    return () => {
      disposeSubagentReportCompat()
      disposeAdapter()
      disposeRoutes()
      oauth.dispose()
    }
  }, 'dsh-chatgpt-subscription: adapter, routes, and lifecycle')
}

export { OAuthService } from './host/oauth-service.ts'
export { CodexChatGptAdapter } from './host/adapter.ts'
export { ResponsesClient, parseResponsesStream } from './host/responses-client.ts'
export { UsageService, mapCodexUsage } from './host/usage-service.ts'
export { createPlatformTokenStore } from './host/platform-token-store.ts'
export { LinuxFileTokenStore } from './host/token-store-linux.ts'
export { WindowsDpapiTokenStore } from './host/token-store-windows.ts'
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts'

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}
