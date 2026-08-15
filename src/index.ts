import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { CodexChatGptAdapter, PROVIDER_ID } from './host/adapter.ts'
import { OAuthService } from './host/oauth-service.ts'
import { ResponsesClient } from './host/responses-client.ts'
import { registerRoutes } from './host/routes.ts'
import { WindowsDpapiTokenStore } from './host/token-store-windows.ts'
import { UsageService } from './host/usage-service.ts'

export const inject = ['webServer', 'llm', 'attachments']

export function apply(ctx: Context): void {
  const store = new WindowsDpapiTokenStore()
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
    return () => {
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
export type { TokenStore, StoredOAuthCredentials } from './host/token-store.ts'

function localWebServerBaseUrl(host: '127.0.0.1' | '0.0.0.0', port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
}
