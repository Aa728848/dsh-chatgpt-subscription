import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTE_PREFIX } from '../src/compat.ts'
import { registerMultiProviderRoutes } from '../src/host/multi-provider-routes.ts'

const servers: http.Server[] = []
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

describe('multi-provider route errors', () => {
  it('returns provider OAuth authorization URLs while redacting credential fields', async () => {
    const runtime = {
      init: async () => undefined,
      snapshot: () => ({ generatedAt: new Date().toISOString(), providers: [] }),
      startAuthorization: async () => ({
        status: 'pending', providerId: 'claude', sessionId: 'claude:browser:test',
        authorizationUrl: 'https://claude.com/cai/oauth/authorize?state=opaque',
        authorization: 'Bearer must-not-leak', token: 'must-not-leak',
      }),
    }
    const routes: Array<{ handler: http.RequestListener }> = []
    registerMultiProviderRoutes({ webServer: { register(route: { handler: http.RequestListener }) { routes.push(route); return () => undefined } } } as never, runtime as never, { kind: 'memory', encrypted: false })
    const { server, origin } = await serve(routes[0].handler)
    servers.push(server)
    const status = await fetch(`${origin}${ROUTE_PREFIX}/providers`).then((response) => response.json()) as { value: { csrfToken: string } }
    const response = await fetch(`${origin}${ROUTE_PREFIX}/providers/login/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-dsh-csrf-token': status.value.csrfToken }, body: JSON.stringify({ providerId: 'claude' }),
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain('https://claude.com/cai/oauth/authorize?state=opaque')
    expect(text).not.toContain('must-not-leak')
  })

  it('redacts URLs, credentials, and host paths from outward diagnostics', async () => {
    const runtime = {
      init: async () => undefined,
      snapshot: () => ({ generatedAt: new Date().toISOString(), providers: [] }),
      scan: async () => { throw new Error('token=secret-value failed at https://evil.example/callback?code=secret on C:\\Users\\owner\\credential.json') },
    }
    const routes: Array<{ handler: http.RequestListener }> = []
    registerMultiProviderRoutes({ webServer: { register(route: { handler: http.RequestListener }) { routes.push(route); return () => undefined } } } as never, runtime as never, { kind: 'memory', encrypted: false })
    const { server, origin } = await serve(routes[0].handler)
    servers.push(server)
    const status = await fetch(`${origin}${ROUTE_PREFIX}/providers`).then((response) => response.json()) as { value: { csrfToken: string } }
    const rejected = await fetch(`${origin}${ROUTE_PREFIX}/providers/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ providerId: 'claude' }),
    })
    expect(rejected.status).toBe(403)
    const response = await fetch(`${origin}${ROUTE_PREFIX}/providers/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-dsh-csrf-token': status.value.csrfToken }, body: JSON.stringify({ providerId: 'claude' }),
    })
    const text = await response.text()
    expect(response.status).toBe(502)
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain('Users')
    expect(text).toContain('[redacted')
  })
})

async function serve(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
