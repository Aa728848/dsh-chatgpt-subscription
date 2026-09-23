import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'
import type { SubscriptionPreferenceStore } from '../src/host/preferences.ts'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })))
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
    const emit = vi.fn()
    const ctx = {
      emit,
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
          context: { contextWindow: provider === 'codex-chatgpt' ? 384_000 : 128_000 },
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
    // One mutable override map, so a patch that clears a key is observable.
    const overrides: Record<string, number> = {
      'gpt-6-astra': 384_000,
      'gpt-6-sol': 384_000,
      'gpt-6-luna': 384_000,
      'gpt-5.6-sol': 272_000,
      'gpt-5.6-terra': 272_000,
      'gpt-5.6-luna': 272_000,
    }
    const preferences: SubscriptionPreferenceStore = {
      status: () => ({
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
        searchProvider: 'dsh',
        contextWindowOverrides: { ...overrides },
        proxyMode: 'auto',
        customProxyUrl: null,
        writable: true,
      }),
      update: async (patch) => {
        if (patch.contextWindowOverrides !== undefined) {
          for (const [model, value] of Object.entries(patch.contextWindowOverrides)) {
            if (value === null) delete overrides[model]
            else overrides[model] = value
          }
        }
        return {
          quickQuotaVisible: patch.quickQuotaVisible ?? false,
          fastMode: patch.fastMode ?? false,
          outputVerbosity: patch.outputVerbosity ?? null,
          reasoningSummary: patch.reasoningSummary !== undefined ? patch.reasoningSummary : null,
          visibleModelIds: patch.visibleModelIds ?? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
          searchProvider: patch.searchProvider ?? 'dsh',
          contextWindowOverrides: { ...overrides },
          proxyMode: patch.proxyMode !== undefined ? patch.proxyMode : 'auto',
          customProxyUrl: patch.customProxyUrl !== undefined ? patch.customProxyUrl : null,
          writable: true,
        }
      },
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
    expect((await mermaidResponse.text()).length).toBeGreaterThan(0)

    const updatedPreferences = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        fastMode: true,
        outputVerbosity: 'high',
        reasoningSummary: 'concise',
        visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 1_000_000 },
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
        visibleModelIds: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'],
        contextWindowOverrides: { 'gpt-6-astra': 872_000, 'gpt-5.6-sol': 1_000_000 },
        proxyMode: 'custom',
        customProxyUrl: 'http://127.0.0.1:8888',
      },
    })

    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
    emit.mockClear()
    const unrelatedPreferences = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ fastMode: false }),
    })
    expect(unrelatedPreferences.status).toBe(200)
    expect(emit).not.toHaveBeenCalled()

    const rejectedReasoningSummary = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ reasoningSummary: 'super-long' }),
    })
    expect(rejectedReasoningSummary.status).toBe(400)

    // Every catalog model is configurable now, not only the default-visible six.
    emit.mockClear()
    const updatedLegacyModel = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-5.4': 128_000 } }),
    })
    expect(updatedLegacyModel.status).toBe(200)
    expect((await updatedLegacyModel.json()).value.contextWindowOverrides['gpt-5.4']).toBe(128_000)
    // The resolved context window is part of the cached model directory.
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    const rejectedContextModel = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-9-unknown': 128_000 } }),
    })
    expect(rejectedContextModel.status).toBe(400)

    // null clears one override back to the catalog default and leaves the rest.
    emit.mockClear()
    const clearedContext = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ contextWindowOverrides: { 'gpt-5.4': null } }),
    })
    expect(clearedContext.status).toBe(200)
    const clearedOverrides = (await clearedContext.json()).value.contextWindowOverrides
    expect(clearedOverrides['gpt-5.4']).toBeUndefined()
    expect(clearedOverrides['gpt-6-sol']).toBe(384_000)
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')

    for (const contextWindow of [0, 1.5, 872_001, 1_000_000]) {
      const rejectedAstraContext = await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ contextWindowOverrides: { 'gpt-6-astra': contextWindow } }),
      })
      expect(rejectedAstraContext.status).toBe(400)
    }

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
