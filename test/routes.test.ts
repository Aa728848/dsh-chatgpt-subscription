import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'

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
    registerRoutes(ctx as never, oauth, usage)
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
