import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  KimiCodeAccountPool,
  kimiCodeApiKeyIdentity,
  parseKimiCodePoolData,
} from '../src/host/kimi-code/account-pool.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  isKimiCodeApiKey,
  parseKimiCodeCredentials,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import {
  KimiCodeApiKeyError,
  kimiCodeApiKeyCredentials,
  normalizeKimiCodeApiKey,
  verifyKimiCodeApiKey,
} from '../src/host/kimi-code/api-key.ts'
import { KimiCodeUnauthorizedError, ensureAccessToken, resetRefreshRejections } from '../src/host/kimi-code/oauth.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/kimi-code/client.ts'
import { registerKimiCodeRoutes } from '../src/host/kimi-code/routes.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

class PoolBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : parseKimiCodePoolData(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

class CredentialBackend {
  data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : parseKimiCodeCredentials(JSON.parse(JSON.stringify(this.data))) }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function oauthCredential(n: number): KimiCodeCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 86_400_000,
    expiresIn: 86_400,
    userId: `user-${n}`,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

function harness() {
  const mirrorBackend = new CredentialBackend()
  const store = new FileCredentialStore(tmp('kc-key-mirror'), mirrorBackend as never)
  const pool = new KimiCodeAccountPool({ store, backend: new PoolBackend() as never })
  return { store, pool, mirrorBackend }
}

afterEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
  resetRefreshRejections()
  vi.restoreAllMocks()
})

describe('normalizeKimiCodeApiKey', () => {
  it('strips what a copy usually brings along', () => {
    expect(normalizeKimiCodeApiKey('  sk-kimi-abc123  ')).toBe('sk-kimi-abc123')
    expect(normalizeKimiCodeApiKey('Bearer sk-kimi-abc123')).toBe('sk-kimi-abc123')
    expect(normalizeKimiCodeApiKey('"sk-kimi-abc123"')).toBe('sk-kimi-abc123')
  })

  it('refuses an empty value or one that cannot be a header token', () => {
    for (const raw of ['', '   ', undefined, 42, 'sk-kimi abc', 'sk-kimi-密钥', 'x'.repeat(513)]) {
      expect(() => normalizeKimiCodeApiKey(raw)).toThrow(KimiCodeApiKeyError)
    }
  })
})

describe('Kimi Code API-key credential', () => {
  it('round-trips without a refresh token and keeps its kind', () => {
    const stored = kimiCodeApiKeyCredentials('sk-kimi-abc', 'mainland-cn', 1_000)
    const parsed = parseKimiCodeCredentials(JSON.parse(JSON.stringify(stored)))
    expect(parsed).toEqual(stored)
    expect(isKimiCodeApiKey(parsed)).toBe(true)
    expect(parsed.refreshToken).toBe('')
  })

  it('still requires a refresh token from an OAuth credential', () => {
    const { refreshToken: _dropped, ...oauth } = oauthCredential(1)
    expect(() => parseKimiCodeCredentials(oauth)).toThrow(/refresh token/)
    expect(() => parseKimiCodeCredentials({ ...oauthCredential(1), refreshToken: '' })).toThrow(/refresh token/)
  })

  it('is returned as-is by the single-credential path and never refreshed', async () => {
    const backend = new CredentialBackend()
    const store = new FileCredentialStore(tmp('kc-key-single'), backend as never)
    await store.write(kimiCodeApiKeyCredentials('sk-kimi-abc', 'mainland-cn'))
    const fetchFn = vi.fn()
    const credentials = await ensureAccessToken(store, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(credentials.accessToken).toBe('sk-kimi-abc')
    await expect(ensureAccessToken(store, { fetchFn: fetchFn as unknown as typeof fetch, force: true }))
      .rejects.toBeInstanceOf(KimiCodeUnauthorizedError)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('Kimi Code pool with API keys', () => {
  it('serves a key without refreshing it and labels the row', async () => {
    const { pool } = harness()
    const fetchFn = vi.fn()
    await pool.addAccount(kimiCodeApiKeyCredentials('sk-kimi-abc', 'mainland-cn'))
    const effective = await pool.getEffectiveCredential(undefined, fetchFn as unknown as typeof fetch)
    expect(effective.credentials.accessToken).toBe('sk-kimi-abc')
    expect(fetchFn).not.toHaveBeenCalled()
    const [summary] = await pool.listAccounts()
    expect(summary).toMatchObject({ authKind: 'api-key' })
    expect(summary!.expiresAt).toBeUndefined()
  })

  it('dedupes on the key, not on the identity /me reported', async () => {
    const { pool } = harness()
    const first = await pool.addAccount({ ...kimiCodeApiKeyCredentials('sk-kimi-a', 'mainland-cn'), userId: 'user-1' })
    const again = await pool.addAccount({ ...kimiCodeApiKeyCredentials('sk-kimi-a', 'mainland-cn'), userId: 'user-1' })
    const other = await pool.addAccount({ ...kimiCodeApiKeyCredentials('sk-kimi-b', 'mainland-cn'), userId: 'user-1' })
    // The same member's device-code sign-in stays a separate row as well.
    const oauth = await pool.addAccount(oauthCredential(1))
    expect(again.id).toBe(first.id)
    expect(new Set([first.id, other.id, oauth.id]).size).toBe(3)
    expect((await pool.read()).accounts).toHaveLength(3)
    expect(kimiCodeApiKeyIdentity('sk-kimi-a')).not.toContain('sk-kimi-a')
  })

  it('a forced renewal fails without taking the key out of rotation', async () => {
    const { pool } = harness()
    const added = await pool.addAccount(kimiCodeApiKeyCredentials('sk-kimi-abc', 'mainland-cn'))
    await expect(pool.renewCredential(added.id, vi.fn() as unknown as typeof fetch)).rejects.toThrow(/cannot be renewed/)
    const row = (await pool.read()).accounts.find((account) => account.id === added.id)
    expect(row?.authStatus).toBeUndefined()
  })
})

describe('verifyKimiCodeApiKey', () => {
  it('accepts the region whose model listing answers', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-kimi-abc')
      return String(url).startsWith('https://api.kimi.com/') ? new Response('{}', { status: 401 }) : Response.json({ data: [] })
    })
    await expect(verifyKimiCodeApiKey('sk-kimi-abc', { region: 'mainland-cn', fetchFn: fetchFn as unknown as typeof fetch }))
      .resolves.toBe('global')
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.kimi.com/coding/v1/models',
      'https://api.kimi.ai/coding/v1/models',
    ])
  })

  it('refuses a key both regions reject, and reports an outage as one', async () => {
    const rejected = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(verifyKimiCodeApiKey('sk-x', { region: 'mainland-cn', fetchFn: rejected as unknown as typeof fetch }))
      .rejects.toMatchObject({ status: 400 })
    const down = vi.fn(async () => new Response('{}', { status: 503 }))
    await expect(verifyKimiCodeApiKey('sk-x', { region: 'mainland-cn', fetchFn: down as unknown as typeof fetch }))
      .rejects.toMatchObject({ status: 502 })
  })
})

function fakeExchange() {
  const captured: { status?: number; body?: any } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: input.origin ?? 'http://127.0.0.1:3000' },
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

function routeHarness(fetchImpl: (url: string) => Response) {
  const { store, pool, mirrorBackend } = harness()
  const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  const ctx = { webServer: { register(route: never) { routes.push(route); return () => undefined } } } as unknown as Context
  const fetchFn = vi.fn(async (url: string | URL) => fetchImpl(String(url)))
  registerKimiCodeRoutes(ctx, store, new FileModelSettingsStore(tmp('kc-key-models')), undefined, {
    fetchFn: fetchFn as unknown as typeof fetch,
    accountPool: pool,
  })
  const call = async (input: Parameters<typeof fakeRequest>[0]) => {
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest(input), response)
    return captured
  }
  return { pool, store, mirrorBackend, fetchFn, call }
}

describe('POST /kimi-code/api/login/api-key', () => {
  const accepting = (url: string) => {
    if (url.endsWith('/v1/me')) return Response.json({ data: { userInfo: { nickname: '月光' } } })
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'kimi-for-coding', context_length: 262_144 }] })
    return Response.json({})
  }

  it('verifies the key, adds it to the pool and never echoes it', async () => {
    const h = routeHarness(accepting)
    const answer = await h.call({ url: '/kimi-code/api/login/api-key', method: 'POST', body: { apiKey: ' sk-kimi-secret ' } })
    expect(answer.status).toBe(200)
    expect(JSON.stringify(answer.body)).not.toContain('sk-kimi-secret')
    expect(answer.body.value.accounts).toHaveLength(1)
    expect(answer.body.value.accounts[0]).toMatchObject({ authKind: 'api-key', alias: '月光' })
    const [row] = (await h.pool.read()).accounts
    expect(row!.credentials).toMatchObject({ authKind: 'api-key', accessToken: 'sk-kimi-secret', refreshToken: '' })
  })

  it('stores nothing when the service rejects the key', async () => {
    const h = routeHarness(() => new Response('{"error":"invalid"}', { status: 401 }))
    const answer = await h.call({ url: '/kimi-code/api/login/api-key', method: 'POST', body: { apiKey: 'sk-open-platform' } })
    expect(answer.status).toBe(400)
    expect(answer.body.error).toMatch(/rejected this API key/)
    expect((await h.pool.read()).accounts).toHaveLength(0)
    expect(h.mirrorBackend.data).toBeNull()
  })

  it('refuses a cross-origin post before touching the network', async () => {
    const h = routeHarness(accepting)
    const answer = await h.call({ url: '/kimi-code/api/login/api-key', method: 'POST', body: { apiKey: 'sk-kimi-x' }, origin: 'https://evil.example' })
    expect(answer.status).toBe(403)
    expect(h.fetchFn).not.toHaveBeenCalled()
  })

  it('replaces a revoked key on its own row and puts it back in rotation', async () => {
    const h = routeHarness(accepting)
    const added = await h.pool.addAccount(kimiCodeApiKeyCredentials('sk-kimi-old', 'mainland-cn'), '工作 Key')
    await h.pool.markAuthFailed(added.id, 'revoked')
    const answer = await h.call({ url: '/kimi-code/api/login/api-key', method: 'POST', body: { apiKey: 'sk-kimi-new', accountId: added.id } })
    expect(answer.status).toBe(200)
    const rows = (await h.pool.read()).accounts
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: added.id, alias: '工作 Key' })
    expect(rows[0]!.credentials.accessToken).toBe('sk-kimi-new')
    expect(rows[0]!.authStatus).toBeUndefined()
  })

  it('does not let a key replace a device-code account', async () => {
    const h = routeHarness(accepting)
    const oauth = await h.pool.addAccount(oauthCredential(1))
    const answer = await h.call({ url: '/kimi-code/api/login/api-key', method: 'POST', body: { apiKey: 'sk-kimi-new', accountId: oauth.id } })
    expect(answer.status).toBe(400)
    expect((await h.pool.read()).accounts[0]!.credentials.accessToken).toBe('at-1')
  })
})
