import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerKimiCodeRoutes } from '../src/host/kimi-code/routes.ts'
import { FileCredentialStore, FileModelSettingsStore, registerKimiCodePreferenceStore, type KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/kimi-code/client.ts'
import { KimiCodeAccountPool, parseKimiCodePoolData } from '../src/host/kimi-code/account-pool.ts'
import { resetRefreshRejections, resetWebLogin } from '../src/host/kimi-code/oauth.ts'
import {
  createStreamState,
  recordCacheStats,
  recordDriftCause,
  recordSessionImageBudget,
  resetCacheStats,
} from '../src/host/kimi-code/mapper.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/**
 * In-memory encrypted backend for the stored credential.
 *
 * The platform backends are not interchangeable under CI: Windows DPAPI and the
 * macOS Keychain both work headlessly, but the Linux Secret Service needs
 * `secret-tool` and an unlocked keyring that `ubuntu-latest` does not have, so
 * its `load()` rejects. Without this, the routes that read the store for real —
 * the model toggle below is the one — failed on the host keyring being absent
 * rather than on route behaviour.
 */
class MemoryCredentialBackend {
  private data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as KimiCodeCredentials }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) as KimiCodeCredentials }
  async clear() { this.data = null }
}

/** In-memory pool document, parsed exactly as a real backend would. */
class MemoryPoolBackend {
  private data: unknown = null
  async load() {
    return this.data === null ? null : parseKimiCodePoolData(JSON.parse(JSON.stringify(this.data)))
  }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
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
    store = new FileCredentialStore(tmp('kc-cred'), new MemoryCredentialBackend())
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

  it('clears a stored context window override when the card posts null', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    await modelSettings.updateSettings({ contextWindowOverrides: { k3: 100_000 } })

    const { response, captured } = fakeExchange()
    await handler(
      fakeRequest({ url: '/kimi-code/api/models', method: 'POST', body: { contextWindowOverrides: { k3: null } } }),
      response,
    )

    expect(captured.status).toBe(200)
    expect((await modelSettings.read()).contextWindowOverrides).toEqual({})
    const value = (captured.body as { value: { contextWindowOverrides: Record<string, number>; models: Array<{ id: string; contextWindow: number }> } }).value
    expect(value.contextWindowOverrides).toEqual({})
    // Back to the catalog window rather than the deleted override.
    expect(value.models.find((model) => model.id === 'k3')!.contextWindow).toBe(262_144)
  })

  it('writes one override and deletes another in the same patch', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    await modelSettings.updateSettings({ contextWindowOverrides: { k3: 100_000, 'kimi-for-coding': 900_000 } })

    const { response, captured } = fakeExchange()
    await handler(
      fakeRequest({
        url: '/kimi-code/api/settings',
        method: 'POST',
        body: { contextWindowOverrides: { k3: null, 'kimi-for-coding': 500_000 } },
      }),
      response,
    )

    expect(captured.status).toBe(200)
    expect((await modelSettings.read()).contextWindowOverrides).toEqual({ 'kimi-for-coding': 500_000 })
    const value = (captured.body as { value: { contextWindowOverrides: Record<string, number>; models: Array<{ id: string; contextWindow: number }> } }).value
    expect(value.contextWindowOverrides).toEqual({ 'kimi-for-coding': 500_000 })
    expect(value.models.find((model) => model.id === 'k3')!.contextWindow).toBe(262_144)
    expect(value.models.find((model) => model.id === 'kimi-for-coding')!.contextWindow).toBe(500_000)
  })

  it('deletes through the settings namespace without persisting a null', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)
    // A harness with the register seam stores into the schema-validated
    // namespace, which only accepts numbers.
    let value: Record<string, unknown> = { contextWindowOverrides: { k3: 100_000 } }
    const preferences = registerKimiCodePreferenceStore({
      register(_namespace: unknown, schema: (input: unknown) => Record<string, unknown>) {
        value = schema(value)
        return {
          get: () => value,
          update: async (patch: object) => { value = schema({ ...value, ...patch }) },
        }
      },
    }, modelSettings)
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    registerKimiCodeRoutes(
      { webServer: { register(route: typeof routes[number]) { routes.push(route); return () => undefined } } } as unknown as Context,
      store,
      modelSettings,
      preferences,
      { fetchFn: fetchMock as unknown as typeof fetch },
    )

    const { response, captured } = fakeExchange()
    await routes[0]!.handler(
      fakeRequest({
        url: '/kimi-code/api/models',
        method: 'POST',
        body: { contextWindowOverrides: { k3: null, 'kimi-for-coding': 500_000 } },
      }),
      response,
    )

    expect(captured.status).toBe(200)
    expect(preferences.status().contextWindowOverrides).toEqual({ 'kimi-for-coding': 500_000 })
    // The fallback document is written in the background; it must merge the
    // same way, so the deleted key cannot survive on disk as a null.
    await vi.waitFor(async () => {
      const written = JSON.parse(await fs.readFile(modelSettings.path(), 'utf8')) as { contextWindowOverrides: unknown }
      expect(written.contextWindowOverrides).toEqual({ 'kimi-for-coding': 500_000 })
    })
  })

  /**
   * What the status card says about the image budget.
   *
   * The budget is the number of bytes one request may carry in images, and a
   * conversation that crosses it loses the OLDEST pictures — which rewrites the
   * cached prefix and shows up as a cache miss the service did not cause. The
   * card therefore has to name the ceiling AND the cause, or a user reading a
   * miss has nothing to connect it to.
   */
  it('names the ceiling, what the last turn spent of it, and the offload that broke the prefix', async () => {
    const session = 'session-image-budget-fixture'
    vi.spyOn(store, 'read').mockResolvedValue(credential() as never)
    vi.spyOn(store, 'write').mockResolvedValue(undefined)

    try {
      // One request that reported usage, so the card shows cache numbers at all.
      const state = createStreamState('openai', session)
      state.sawUsage = true
      state.inputTokens = 100
      state.cacheReadTokens = 900
      recordCacheStats(state, session)
      // And the image budget's own verdict on that request.
      recordSessionImageBudget(session, {
        allDroppedKeys: ['attachment:shot-0'],
        newlyDroppedCount: 1,
        requestImageBytes: 4096,
        droppedImages: 1,
      })
      recordDriftCause('image-offload', session)

      const { response, captured } = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/status?sessionId=' + session }), response)

      expect(captured.status).toBe(200)
      const value = (captured.body as {
        value: { cache: { imageBudget: Record<string, number>; lastDrift?: string } }
      }).value
      // The ceilings are the ones this deployment enforces: Kimi's own 20 MiB
      // high mark and its 10 MiB low mark.
      expect(value.cache.imageBudget).toEqual({
        budgetBytes: 20 * 1024 * 1024,
        lowBudgetBytes: 10 * 1024 * 1024,
        requestImageBytes: 4096,
        droppedImages: 1,
      })
      // And the miss is attributed to the offload rather than to the service.
      expect(value.cache.lastDrift).toBe('image-offload')
    } finally {
      // The mapper keeps its numbers for the life of the process, so a fixture
      // that stayed would answer the NEXT test's status call.
      resetCacheStats(session)
    }
  })
})

/**
 * The name shown on the account card.
 *
 * Sign-in can only title a row from its token, and a phone-signed-in account
 * carries no address, so the row read `账号 N` for good: the nickname exists
 * only on `/me`, which the quota read asks, and nothing carried the answer back.
 * This drives the real route so the whole chain is pinned — refresh → profile →
 * pool row → the list the card renders.
 */
describe('Kimi Code routes learn the account name', () => {
  it('titles a placeholder row with the nickname the status refresh read', async () => {
    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
    const store = new FileCredentialStore(tmp('kc-cred-learn'), new MemoryCredentialBackend())
    const modelSettings = new FileModelSettingsStore(tmp('kc-models-learn'))
    const pool = new KimiCodeAccountPool({ store, backend: new MemoryPoolBackend() as never })
    const added = await pool.addAccount({
      accessToken: jwt({ user_id: 'u_123' }),
      refreshToken: jwt({}),
      expiresAt: Date.now() + 24 * 3_600_000,
      expiresIn: 86_400,
      region: 'mainland-cn',
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding',
    })
    // What a phone sign-in leaves behind: an id, no address, no name.
    expect(added.alias).toBe('账号 1')

    const routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith('/me')) {
        // The envelope the gateway wraps the profile in.
        return Response.json({ data: { userInfo: { nickname: '月光' } } })
      }
      if (target.includes('/usages')) return Response.json(USAGES)
      return Response.json(CATALOG)
    })
    registerKimiCodeRoutes(ctx, store, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      accountPool: pool,
    })

    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/kimi-code/api/status' }), response)
    expect(captured.status).toBe(200)

    const value = (captured.body as { value: { accounts: Array<{ alias: string; nickname?: string }> } }).value
    expect(value.accounts[0]).toMatchObject({ alias: '月光', nickname: '月光' })

    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
  })
})

/**
 * A brand-new sign-in, end to end through the route.
 *
 * The pool mints a row's alias as it is created, from nothing but the token, so
 * waiting for the first quota read would show `账号 N` in between. The login
 * route reads `/me` before the row exists instead; this drives the real device
 * flow mock to prove the name is there from the start.
 */
describe('Kimi Code sign-in learns the account name', () => {
  it('titles a fresh account from /me before the row is created', async () => {
    resetWebLogin()
    const store = new FileCredentialStore(tmp('kc-cred-login'), new MemoryCredentialBackend())
    const modelSettings = new FileModelSettingsStore(tmp('kc-models-login'))
    const poolBackend = new (class {
      private data: unknown = null
      async load() {
        return this.data === null ? null : parseKimiCodePoolData(JSON.parse(JSON.stringify(this.data)))
      }
      async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
      async clear() { this.data = null }
    })()
    const pool = new KimiCodeAccountPool({ store, backend: poolBackend as never })

    const routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url)
      seen.push(target)
      if (target.includes('/device_authorization')) {
        return Response.json({
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://auth.kimi.com/device',
          verification_uri_complete: 'https://auth.kimi.com/device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        })
      }
      if (target.includes('/oauth/token')) {
        return Response.json({
          // A JWT, as the real service issues: the id is what the pool dedupes on.
          access_token: jwt({ user_id: 'u_fresh' }),
          refresh_token: 'rt-fresh',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: 'kimi-code',
        })
      }
      if (target.endsWith('/me')) {
        return Response.json({ data: { userInfo: { nickname: '月光' } } })
      }
      return Response.json(CATALOG)
    })
    registerKimiCodeRoutes(ctx, store, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      accountPool: pool,
      // Never launch a browser from a test run.
      openBrowser: () => undefined,
    })

    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/kimi-code/api/login', method: 'POST', body: {} }), response)
    expect(captured.status).toBe(200)

    // The flow completes in the background; the pool row appears when it does.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await pool.listAccounts()).length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const rows = await pool.listAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.alias).toBe('月光')
    expect(rows[0]!.nickname).toBe('月光')
    // The profile is what named it, and the stored credential keeps the name.
    expect(seen.some((url) => url.endsWith('/me'))).toBe(true)
    expect((await store.read())?.nickname).toBe('月光')

    resetWebLogin()
    resetRefreshRejections()
  })

  it('names a placeholder row even when the usage call is failing', async () => {
    // The quota read is where the profile is normally learned, but it does not
    // run while the snapshot is fresh — and never completes while `/usages`
    // errors. The name must not wait for either: the card asks for it directly.
    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
    const store = new FileCredentialStore(tmp('kc-cred-probe'), new MemoryCredentialBackend())
    const modelSettings = new FileModelSettingsStore(tmp('kc-models-probe'))
    const pool = new KimiCodeAccountPool({ store, backend: new MemoryPoolBackend() as never })
    const added = await pool.addAccount({
      accessToken: jwt({ user_id: 'u_probe' }),
      refreshToken: jwt({}),
      expiresAt: Date.now() + 24 * 3_600_000,
      expiresIn: 86_400,
      region: 'mainland-cn',
      oauthHost: 'https://auth.kimi.com',
      baseUrl: 'https://api.kimi.com/coding',
    })
    expect(added.alias).toBe('账号 1')

    const routes: Array<{ path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    let profileReads = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith('/me')) {
        profileReads += 1
        return Response.json({ nickname: '登月者0498' })
      }
      if (target.includes('/usages')) return new Response('boom', { status: 500 })
      return Response.json(CATALOG)
    })
    registerKimiCodeRoutes(ctx, store, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      accountPool: pool,
      openBrowser: () => undefined,
    })

    const first = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/kimi-code/api/status' }), first.response)
    expect(first.captured.status).toBe(200)
    const firstValue = (first.captured.body as { value: { accounts: Array<{ alias: string }>; quotaError: unknown } }).value
    expect(firstValue.accounts[0]!.alias).toBe('登月者0498')
    // The quota failure is still reported as such; learning a name must not hide it.
    expect(String(firstValue.quotaError)).toMatch(/usage request failed/i)

    // One profile read per account per process: the card polls every minute and
    // must not spend a request a minute on the same answer.
    const second = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/kimi-code/api/status' }), second.response)
    expect(profileReads).toBe(1)

    clearCachedCatalog()
    clearCachedQuota()
    resetRefreshRejections()
  })
})
