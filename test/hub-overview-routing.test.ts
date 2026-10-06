import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { registerHubOverviewRoutes } from '../src/host/hub-overview.ts'
import { HUB_OVERVIEW_PATH } from '../src/shared/hub-contracts.ts'
import type { HubOverviewDto } from '../src/shared/hub-contracts.ts'
import type { SubscriptionPreferenceStore } from '../src/host/preferences.ts'

/**
 * The overview route is an `exact` GET sitting directly beside the provider's
 * `prefix` route, whose handler answers 405 to every non-POST request under the
 * same path. Whether the new GET is reachable at all therefore depends on the
 * harness matching exact routes before prefix routes — it does, and this file
 * pins that dependency against the real route registrations rather than a stub.
 */
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })))
})

interface Route { kind: string; path: string; handler: http.RequestListener }

/** The harness's documented order: exact table first, then the longest prefix. */
function dispatch(routes: readonly Route[], fallback: http.RequestListener): http.RequestListener {
  return (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname)
    if (exact !== undefined) return void exact.handler(request, response)
    const prefix = routes
      .filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (prefix !== undefined) return void prefix.handler(request, response)
    fallback(request, response)
  }
}

async function mount(): Promise<string> {
  const routes: Route[] = []
  const ctx = {
    webServer: {
      register(route: Route) {
        routes.push(route)
        return () => undefined
      },
    },
  } as never
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
  const usage = new UsageService(oauth, { fetchFn: async () => Response.json({ plan_type: 'plus' }) })
  const preferences = {
    status: () => ({
      quickQuotaVisible: false,
      fastMode: false,
      outputVerbosity: null,
      reasoningSummary: null,
      visibleModelIds: ['gpt-5.6-sol'],
      searchProvider: 'dsh',
      contextWindowOverrides: {},
      proxyMode: 'auto',
      customProxyUrl: null,
      writable: true,
    }),
    update: async () => preferences.status(),
    watch: () => () => undefined,
  } as unknown as SubscriptionPreferenceStore

  // Both real registrations, in the order src/index.ts applies them.
  registerRoutes(ctx, oauth, usage, preferences)
  registerHubOverviewRoutes(ctx, Array.from({ length: 8 }, (_, index) => ({
    id: `line-${index}`,
    providerId: `line-${index}-provider`,
    canToggle: true,
    read: async () => ({
      enabled: true,
      accountCount: index,
      authenticated: index > 0,
      enabledModelCount: null,
      totalModelCount: null,
    }),
  })))

  expect(routes.filter((route) => route.kind === 'exact' && route.path === HUB_OVERVIEW_PATH)).toHaveLength(1)
  const server = http.createServer(dispatch(routes, (_request, response) => {
    // The production fallback is the SPA dist server; its 404 shape is all this
    // test needs from it.
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not found')
  }))
  servers.push(server)
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('hub overview beside the provider route', () => {
  it('serves the overview GET that the shared prefix handler would 405', async () => {
    const origin = await mount()
    const response = await fetch(`${origin}${HUB_OVERVIEW_PATH}`)
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: true; value: HubOverviewDto }
    expect(body.value.providers).toHaveLength(8)
    expect(body.value.providers.map((provider) => provider.id)).toEqual([
      'line-0', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6', 'line-7',
    ])
  })

  it('leaves every existing provider route exactly as it was', async () => {
    const origin = await mount()
    // The sibling GET still answers from its own handler…
    expect((await fetch(`${origin}${ROUTE_PREFIX}/status`)).status).toBe(200)
    // …and the prefix handler still owns everything it used to, including its
    // 405 for a GET on a POST-only path.
    expect((await fetch(`${origin}${ROUTE_PREFIX}/preferences/update`)).status).toBe(405)
    expect((await fetch(`${origin}${ROUTE_PREFIX}/hub/nothing-here`)).status).toBe(405)
    // A path outside both routes falls through to the SPA fallback.
    expect((await fetch(`${origin}/somewhere-else`)).status).toBe(404)
  })
})
