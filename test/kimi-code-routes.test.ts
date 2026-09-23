import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerKimiCodeRoutes } from '../src/host/kimi-code/routes.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/kimi-code/client.ts'
import { resetRefreshRejections } from '../src/host/kimi-code/oauth.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

const CATALOG = {
  data: [
    { id: 'k3', display_name: 'K3', context_length: 262_144, supports_image_in: true, think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' } },
    { id: 'kimi-for-coding', display_name: 'Kimi for Coding', context_length: 1_048_576 },
  ],
}

const USAGES = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-09-11T18:00:00Z' },
    limit_7d: { used_ratio: 0.5, reset_time: '2026-09-17T00:00:00Z' },
  },
  user_level_name: 'Moderato',
}

function fakeExchange(): {
  response: ServerResponse
  captured: { status?: number; body?: unknown }
} {
  const captured: { status?: number; body?: unknown } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  if (input.method === 'POST') {
    queueMicrotask(() => {
      if (input.body !== undefined) listeners.get('data')?.forEach((listener) => listener(Buffer.from(JSON.stringify(input.body))))
      listeners.get('end')?.forEach((listener) => listener())
    })
  }
  return request
}

/** A stored credential whose tokens carry the account identity. */
function credential(): Record<string, unknown> {
  return {
    accessToken: jwt({ user_id: 'u_123', email: 'dev@example.com' }),
    refreshToken: jwt({}),
    expiresAt: Date.now() + 3_600_000,
    expiresIn: 3_600,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    authenticatedAt: Date.now(),
  }
}

describe('Kimi Code settings routes', () => {
  let store: FileCredentialStore
  let modelSettings: FileModelSettingsStore
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let originalFetch: typeof fetch
  let fetchMock: ReturnType<typeof vi.fn>
  // The route closes over the fetch seam it was registered with (the plugin
  // passes its proxy fetch), so tests control behaviour through this delegate
  // rather than by swapping globalThis.fetch after registration.
  let fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>

  beforeEach(() => {
    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
    store = new FileCredentialStore(tmp('kc-cred'))
    modelSettings = new FileModelSettingsStore(tmp('kc-models'))
    const routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    originalFetch = globalThis.fetch
    fetchImpl = async (url: string | URL) => {
      if (String(url).includes('/usages')) return Response.json(USAGES)
      return Response.json(CATALOG)
    }
    fetchMock = vi.fn((url: string | URL, init?: RequestInit) => fetchImpl(url, init))
    registerKimiCodeRoutes(ctx, store, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
    })
    handler = routes[0]!.handler
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
    vi.restoreAllMocks()
  })

  it('reports the signed-in account even before any quota is available', async () => {
    // This is the "-" the card showed: the identity must come from the token.
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/status' }), response)

    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect(value.authenticated).toBe(true)
    expect(value.account).toMatchObject({ userId: 'u_123', email: 'dev@example.com' })
    // The tier comes from the usage payload, which the status call refreshed.
    expect(value.account).toMatchObject({ planName: 'Moderato' })
    expect((value.quota as { windows: unknown[] }).windows).toHaveLength(2)
  })

  it('surfaces why a quota refresh failed instead of reporting an empty success', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    fetchImpl = async (url: string | URL) => {
      if (String(url).includes('/usages')) return new Response('nope', { status: 500 })
      return Response.json(CATALOG)
    }

    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/status' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    // The account is still shown, and the reason the quota is missing is stated.
    expect(value.account).toMatchObject({ userId: 'u_123' })
    expect(String(value.quotaError)).toMatch(/usage request failed/i)
  })

  it('fails an explicit quota refresh loudly rather than returning a silent 200', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    fetchImpl = async (url: string | URL) => {
      if (String(url).includes('/usages')) return new Response('go away', { status: 403 })
      return Response.json(CATALOG)
    }

    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/quota', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(502)
    expect((captured.body as { ok: boolean }).ok).toBe(false)
    expect(String((captured.body as { error: string }).error)).toMatch(/403/)
  })

  it('answers a quota refresh with data when the service is healthy', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/quota', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect((value.quota as { windows: unknown[] }).windows).toHaveLength(2)
    expect(value.quotaError).toBeNull()
  })

  it('reports a successful connection test with a verdict and latency', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/connection/test', method: 'POST', body: {} }), response)

    expect(captured.status).toBe(200)
    const value = (captured.body as { value: { connected: boolean; latencyMs: number; account: unknown } }).value
    // The handler used to have no return statement at all, so the route hung.
    expect(value.connected).toBe(true)
    expect(value.latencyMs).toBeGreaterThanOrEqual(0)
    expect(value.account).toMatchObject({ userId: 'u_123' })
  })

  it('reports a rejected credential from the connection test', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    fetchImpl = async (url: string | URL) => {
      if (String(url).includes('/usages')) return new Response('nope', { status: 401 })
      return Response.json(CATALOG)
    }

    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/connection/test', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(500)
    expect(String((captured.body as { error: string }).error)).toMatch(/401|sign in/i)
  })

  it('rejects a quota refresh when nothing is signed in', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/quota', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(400)
  })

  it('invalidates the model catalog after a successful model toggle', async () => {
    const emit = vi.fn()
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    registerKimiCodeRoutes({ emit, webServer: { register(route: typeof routes[number]) { routes.push(route); return () => undefined } } } as unknown as Context, store, modelSettings, undefined, { fetchFn: fetchMock as unknown as typeof fetch })
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/kimi-code/api/models', method: 'POST', body: { enabledModelIds: ['k3'] } }), response)
    expect(captured.status).toBe(200)
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
  })

  it('reports the catalog and honours the enabled selection', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/kimi-code/api/models' }), response)
    const value = (captured.body as { value: { models: Array<{ id: string; enabled: boolean; contextWindow: number }> } }).value
    expect(value.models.map((model) => model.id)).toEqual(['k3', 'kimi-for-coding'])
    expect(value.models.every((model) => model.enabled)).toBe(true)
  })
})
