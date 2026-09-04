import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'
import type { SubscriptionPreferenceStore } from '../src/host/preferences.ts'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('host routes', () => {
  it('returns masked status and rejects cross-origin mutations', async () => {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-secret-1234',
      email: 'owner@example.com',
      planType: 'plus',
    })
    const oauth = new OAuthService(store, { logger: { info: () => undefined, warn: () => undefined } })
    const routes: Array<{ kind: string; path: string; handler: http.RequestListener }> = []
    const ctx = {
      llm: {
        listProviders: () => [
          { id: 'codex-chatgpt', name: 'Codex' },
          { id: 'deepseek-official', name: 'DeepSeek Official' },
        ],
        listModels: async (provider: string) => provider === 'codex-chatgpt'
          ? [{ provider, id: 'gpt-5.6-sol', name: '5.6 Sol' }]
          : [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        resolveModelInfo: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          context: { contextWindow: provider === 'codex-chatgpt' ? 272_000 : 128_000 },
          reasoning: {
            efforts: provider === 'codex-chatgpt' ? [{ id: 'medium', name: 'medium' }] : [{ id: 'high', name: 'high' }],
            defaultEffort: provider === 'codex-chatgpt' ? 'medium' : 'high',
          },
        }),
      },
      webServer: {
        register(route: { kind: string; path: string; handler: http.RequestListener }) {
          routes.push(route)
          return () => undefined
        },
      },
    }
    const usage = new UsageService(oauth, {
      fetchFn: async () => Response.json({
        plan_type: 'plus',
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 2_000_000_000 } },
      }),
    })
    const preferences: SubscriptionPreferenceStore = {
      status: () => ({
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: 'dsh',
        contextWindowOverrides: { 'gpt-5.6-sol': 272_000, 'gpt-5.6-terra': 272_000, 'gpt-5.6-luna': 272_000 },
        subagentContextWindow: null,
        subagentMaxDepth: null,
        proxyMode: 'auto',
        customProxyUrl: null,
        writable: true,
      }),
      update: async (patch) => ({
        quickQuotaVisible: patch.quickQuotaVisible ?? false,
        fastMode: patch.fastMode ?? false,
        outputVerbosity: patch.outputVerbosity ?? null,
        reasoningSummary: patch.reasoningSummary !== undefined ? patch.reasoningSummary : null,
        visibleModelIds: patch.visibleModelIds ?? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: patch.searchProvider ?? 'dsh',
        contextWindowOverrides: {
          'gpt-5.6-sol': patch.contextWindowOverrides?.['gpt-5.6-sol'] ?? 272_000,
          'gpt-5.6-terra': patch.contextWindowOverrides?.['gpt-5.6-terra'] ?? 272_000,
          'gpt-5.6-luna': patch.contextWindowOverrides?.['gpt-5.6-luna'] ?? 272_000,
        },
        subagentContextWindow: patch.subagentContextWindow !== undefined ? patch.subagentContextWindow : null,
        subagentMaxDepth: patch.subagentMaxDepth !== undefined ? patch.subagentMaxDepth : null,
        proxyMode: patch.proxyMode !== undefined ? patch.proxyMode : 'auto',
        customProxyUrl: patch.customProxyUrl !== undefined ? patch.customProxyUrl : null,
        writable: true,
      }),
      watch: () => () => undefined,
    }
    registerRoutes(ctx as never, oauth, usage, preferences)
    const prefix = routes.find((route) => route.kind === 'prefix')!
    const { server, origin } = await serve(prefix.handler)
    servers.push(server)

    const statusResponse = await fetch(`${origin}${ROUTE_PREFIX}/status`)
    const statusText = await statusResponse.text()
    expect(statusResponse.status).toBe(200)
    expect(statusText).toContain('o***@example.com')
    expect(statusText).toContain('…1234')
    expect(statusText).not.toContain('access-secret')
    expect(statusText).not.toContain('refresh-secret')
    expect(statusText).not.toContain('account-secret-1234')
    expect(statusText).toContain('"usedPercent":25')
    expect(statusText).toContain('"quickQuotaVisible":false')
    expect(statusText).not.toContain('"allProviders"')

    const mermaidResponse = await fetch(`${origin}${ROUTE_PREFIX}/mermaid.min.js`)
    expect(mermaidResponse.status).toBe(200)
    expect(mermaidResponse.headers.get('content-type')).toContain('application/javascript')

    const updatedPreferences = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        fastMode: true,
        outputVerbosity: 'high',
        reasoningSummary: 'concise',
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-5.6-sol': 1_000_000 },
        subagentContextWindow: 128_000,
        subagentMaxDepth: 2,
        proxyMode: 'custom',
        customProxyUrl: 'http://127.0.0.1:8888',
      }),
    })
    expect(updatedPreferences.status).toBe(200)
    expect(await updatedPreferences.json()).toMatchObject({
      ok: true,
      value: {
        fastMode: true,
        outputVerbosity: 'high',
        reasoningSummary: 'concise',
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-5.6-sol': 1_000_000 },
        subagentContextWindow: 128_000,
        subagentMaxDepth: 2,
        proxyMode: 'custom',
        customProxyUrl: 'http://127.0.0.1:8888',
      },
    })

    const rejectedReasoningSummary = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ reasoningSummary: 'super-long' }),
    })
    expect(rejectedReasoningSummary.status).toBe(400)

    const rejectedMaxDepth = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ subagentMaxDepth: 4 }),
    })
    expect(rejectedMaxDepth.status).toBe(400)

    const rejectedSubagentContext = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ subagentContextWindow: -1 }),
    })
    expect(rejectedSubagentContext.status).toBe(400)

    const rejectedContextModel = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-5.4': 128_000 } }),
    })
    expect(rejectedContextModel.status).toBe(400)

    const rejected = await fetch(`${origin}${ROUTE_PREFIX}/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    })
    expect(rejected.status).toBe(403)
    expect(await store.load()).not.toBeNull()

    const accepted = await fetch(`${origin}${ROUTE_PREFIX}/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
    })
    expect(accepted.status).toBe(200)
    expect(await store.load()).toBeNull()
    oauth.dispose()
  })
})

async function serve(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
