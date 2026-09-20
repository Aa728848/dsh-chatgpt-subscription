import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  KimiCodeAccountPool,
  parseKimiCodePoolData,
} from '../src/host/kimi-code/account-pool.ts'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type KimiCodeCredentials,
} from '../src/host/kimi-code/token-store.ts'
import {
  ensureAccessToken,
  isRefreshTokenRejected,
  resetRefreshRejections,
  refreshAccessToken,
} from '../src/host/kimi-code/oauth.ts'
import {
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuotaFor,
} from '../src/host/kimi-code/client.ts'
import { registerKimiCodeRoutes } from '../src/host/kimi-code/routes.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** Mirrors the platform backends: JSON on disk, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

class CredentialBackend {
  private data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

const CATALOG = [{ id: 'k3', name: 'K3', contextWindow: 262_144 }]

function credential(n: number, overrides: Partial<KimiCodeCredentials> = {}): KimiCodeCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    userId: `user-${n}`,
    email: `user${n}@example.com`,
    nickname: `Kimi ${n}`,
    planName: 'GOAT',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
    ...overrides,
  }
}

function harness(options: { mirror?: KimiCodeCredentials | null } = {}) {
  const mirrorBackend = new CredentialBackend()
  if (options.mirror) void mirrorBackend.save(options.mirror)
  const mirror = new FileCredentialStore(tmp('kc-mirror'), mirrorBackend as never)
  const poolBackend = new PoolBackend(parseKimiCodePoolData)
  const pool = new KimiCodeAccountPool({ store: mirror, backend: poolBackend as never })
  return { pool, mirror, mirrorBackend, poolBackend }
}

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function modelSettingsStore() {
  const store = new FileModelSettingsStore(tmp('kc-models'))
  vi.spyOn(store, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: ['k3'],
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  return store
}

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
  resetRefreshRejections()
  vi.restoreAllMocks()
})

describe('KimiCodeAccountPool', () => {
  it('projects the pre-pool credential as the primary account without writing', async () => {
    const { pool, poolBackend } = harness({ mirror: credential(1) })
    const save = vi.spyOn(poolBackend, 'save')

    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe('acc_primary')
    expect(data.activeAccountId).toBe('acc_primary')
    expect(save).not.toHaveBeenCalled()
    expect((await pool.listAccounts())[0]).toMatchObject({
      email: 'user1@example.com',
      nickname: 'Kimi 1',
      planName: 'GOAT',
      planLabel: 'GOAT',
      region: 'mainland-cn',
      isPrimary: true,
    })
  })

  it('dedupes by identity rather than by the rotating refresh token', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    expect(first.isPrimary).toBe(true)
    expect(second.isPrimary).toBe(false)

    // The same account signing in again has a new refresh token and keeps its slot.
    const again = await pool.addAccount(credential(1, { refreshToken: 'rt-1-rotated', accessToken: 'at-1-new' }))
    expect(again.id).toBe(first.id)
    expect(again.credentials.refreshToken).toBe('rt-1-rotated')
    expect(await pool.listAccounts()).toHaveLength(2)
  })

  it('refreshes an expiring token in place and keeps the account own region and hosts', async () => {
    const { pool, mirror } = harness()
    const global = await pool.addAccount(credential(1, {
      expiresAt: Date.now() + 1_000,
      region: 'global',
      oauthHost: 'https://auth.moonshot.ai',
      baseUrl: 'https://api.moonshot.ai/coding',
    }))

    const tokenFetch = vi.fn(async () => Response.json({
      access_token: 'at-refreshed',
      refresh_token: 'rt-refreshed',
      expires_in: 3600,
      token_type: 'Bearer',
    }))
    const { credentials } = await pool.getEffectiveCredential(undefined, tokenFetch as unknown as typeof fetch)

    expect(tokenFetch).toHaveBeenCalledTimes(1)
    expect(credentials.accessToken).toBe('at-refreshed')
    expect(credentials.refreshToken).toBe('rt-refreshed')
    expect(credentials.region).toBe('global')
    expect(credentials.oauthHost).toBe('https://auth.moonshot.ai')
    expect(credentials.baseUrl).toBe('https://api.moonshot.ai/coding')
    const stored = (await pool.read()).accounts.find((entry) => entry.id === global.id)!
    expect(stored.credentials.accessToken).toBe('at-refreshed')
    // The primary mirror follows the refreshed credential.
    expect((await mirror.read())?.refreshToken).toBe('rt-refreshed')
  })

  it('takes an account whose refresh token was rejected out of the rotation', async () => {
    const { pool } = harness()
    const rejected = await pool.addAccount(credential(1, { refreshToken: 'rt-dead' }))
    const healthy = await pool.addAccount(credential(2))
    await pool.setPrimary(rejected.id)

    // The token layer is what records the rejection, exactly as a refresh would.
    const deadStore = new FileCredentialStore(tmp('kc-dead'), new CredentialBackend() as never)
    await deadStore.write(credential(1, { refreshToken: 'rt-dead' }))
    await ensureAccessToken(deadStore, {
      fetchFn: (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch,
      force: true,
    }).catch(() => undefined)
    expect(isRefreshTokenRejected('rt-dead')).toBe(true)

    const effective = await pool.getEffectiveCredential()
    expect(effective.account.id).toBe(healthy.id)
    // The account is still listed: signing in again is what restores it.
    expect(await pool.listAccounts()).toHaveLength(2)
    expect((await pool.listAccounts()).find((entry) => entry.id === rejected.id)).toBeDefined()
  })

  it('rotates over accounts of different regions and honours the strategy', async () => {
    const { pool } = harness()
    const mainland = await pool.addAccount(credential(1, { region: 'mainland-cn' }))
    const global = await pool.addAccount(credential(2, { region: 'global' }))
    await pool.setPrimary(mainland.id)

    const first = await pool.getEffectiveCredential()
    expect(first.account.id).toBe(mainland.id)
    expect(first.credentials.region).toBe('mainland-cn')

    await pool.markCooldown(mainland.id, 600_000, 'Kimi Code 429')
    const second = await pool.getEffectiveCredential()
    expect(second.account.id).toBe(global.id)
    expect(second.credentials.region).toBe('global')

    await pool.clearCooldown(mainland.id)
    await pool.setStrategy('round-robin')
    expect((await pool.getEffectiveCredential()).account.id).toBe(mainland.id)

    await pool.markCooldown(mainland.id, 600_000, 'Kimi Code 429')
    await pool.markCooldown(global.id, 600_000, 'Kimi Code 429')
    await expect(pool.getEffectiveCredential()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('reports a signed-out pool with the wording the route used before the pool', async () => {
    const { pool } = harness()
    await expect(pool.getEffectiveCredential()).rejects.toThrow(/Not signed in to Kimi Code/)
  })

  it('never serves one account the quota snapshot of another', async () => {
    const source = new FileCredentialStore(tmp('kc-quota'), new CredentialBackend() as never)
    const fetchMock = vi.fn(async () => Response.json({}))
    await fetchAccountQuota(source, {
      fetchFn: fetchMock as unknown as typeof fetch,
      credentials: credential(1),
      accountId: 'acc_a',
      force: true,
    }).catch(() => undefined)
    expect(getCachedQuotaFor('acc_a')).not.toBeNull()
    expect(getCachedQuotaFor('acc_b')).toBeNull()
    clearCachedQuota()
    expect(getCachedQuotaFor('acc_a')).toBeNull()
  })
})

describe('Kimi Code pool routes', () => {
  it('reports the pool and drives the account actions', async () => {
    const { pool, mirror } = harness()
    const store = new FileCredentialStore(tmp('kc-route'), new CredentialBackend() as never)
    const modelSettings = modelSettingsStore()
    await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))

    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = { webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } } } as unknown as Context
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch
    try {
      registerKimiCodeRoutes(ctx, store, modelSettings, undefined, {}, pool)
      const handler = routes[0]!.handler

      const status = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/status' }), status.response)
      const value = (status.captured.body as { value: { accounts: unknown[]; rotationStrategy: string } }).value
      expect(value.accounts).toHaveLength(2)
      expect(value.rotationStrategy).toBe('sequential')

      const promote = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/accounts', method: 'POST', body: { action: 'set-primary', accountId: second.id } }), promote.response)
      expect(promote.captured.status).toBe(200)
      expect((promote.captured.body as { value: { activeAccountId?: string } }).value.activeAccountId).toBe(second.id)

      const strategy = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/accounts', method: 'POST', body: { action: 'strategy', strategy: 'round-robin' } }), strategy.response)
      expect((strategy.captured.body as { value: { rotationStrategy: string } }).value.rotationStrategy).toBe('round-robin')

      const relogin = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/accounts', method: 'POST', body: { action: 'relogin', accountId: second.id } }), relogin.response)
      expect(relogin.captured.status).toBe(200)

      const crossOrigin = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/accounts', method: 'POST', headers: { origin: 'https://evil.example' }, body: { action: 'delete', accountId: second.id } }), crossOrigin.response)
      expect(crossOrigin.captured.status).toBe(403)

      const signOutOne = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/logout', method: 'POST', body: { accountId: second.id } }), signOutOne.response)
      expect((signOutOne.captured.body as { value: { accounts: unknown[] } }).value.accounts).toHaveLength(1)

      const signOutAll = fakeExchange()
      await handler(fakeRequest({ url: '/kimi-code/api/logout', method: 'POST', body: {} }), signOutAll.response)
      expect((signOutAll.captured.body as { value: { accounts: unknown[] } }).value.accounts).toHaveLength(0)
      expect(await mirror.read()).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('KimiCodeAdapter account rotation', () => {
  it('cools a rate-limited account down and serves the request from the next one', async () => {
    const { pool, mirror, mirrorBackend } = harness()
    await mirrorBackend.save(credential(1))
    const second = await pool.addAccount(credential(2))
    const modelSettings = modelSettingsStore()

    const authorizations: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      authorizations.push(headers.authorization)
      if (headers.authorization === 'Bearer at-1') {
        return new Response(JSON.stringify({ error: { message: 'too many requests' } }), { status: 429, headers: { 'retry-after': '90' } })
      }
      return sseResponse([
        { choices: [{ delta: { content: 'served by the second account' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    })
    const adapter = new KimiCodeAdapter(mirror, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      loadCatalog: async () => CATALOG,
    }, pool)

    const assembled = new BlockAssembler()
    for await (const chunk of adapter.stream({
      provider: 'kimi-code',
      model: 'k3',
      messages: [{ role: 'user', content: 'hi' } as never],
    } as unknown as GenerateOptions)) assembled.push(chunk)

    expect(authorizations).toEqual(['Bearer at-1', 'Bearer at-2'])
    expect(assembled.blocks()).toEqual([{ type: 'text', text: 'served by the second account' }])
    const cooling = (await pool.listAccounts()).find((entry) => entry.id !== second.id)
    expect(cooling?.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it('treats a plan-scoped 429 as a request failure and cools nothing down', async () => {
    const { pool, mirror, mirrorBackend } = harness()
    await mirrorBackend.save(credential(1))
    await pool.addAccount(credential(2))
    const modelSettings = modelSettingsStore()

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Your current plan does not have access to this model.' } }),
      { status: 429 },
    ))
    const adapter = new KimiCodeAdapter(mirror, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      loadCatalog: async () => CATALOG,
    }, pool)

    await expect(collect(adapter.stream({
      provider: 'kimi-code',
      model: 'k3',
      messages: [{ role: 'user', content: 'hi' } as never],
    } as unknown as GenerateOptions))).rejects.toMatchObject({ code: 'RATE_LIMIT' })

    // One attempt only: rotating could not change a plan-scoped refusal, and
    // cooling accounts down after it would take the pool offline.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const account of await pool.listAccounts()) {
      expect(account.cooldownUntil).toBeUndefined()
    }
  })

  it('stops routing to an account whose refresh was rejected and uses the other one', async () => {
    const { pool, mirror } = harness()
    const dead = await pool.addAccount(credential(1, { expiresAt: Date.now() + 1_000, refreshToken: 'rt-dead' }))
    await pool.addAccount(credential(2))
    await pool.setPrimary(dead.id)
    const modelSettings = modelSettingsStore()

    const tokenFetch = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      if (headers.authorization === 'Bearer at-2') {
        return sseResponse([
          { choices: [{ delta: { content: 'from the healthy account' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          '[DONE]',
        ])
      }
      return new Response('unexpected', { status: 500 })
    })
    // A pool's refresh goes through the adapter's fetch, which routes the token
    // endpoint to the OAuth mock.
    const adapter = new KimiCodeAdapter(mirror, modelSettings, undefined, {
      fetchFn: (async (url: unknown, init?: RequestInit) => (
        String(url).includes('/oauth/') || String(url).includes('auth.kimi.com')
          ? tokenFetch()
          : fetchMock(url, init)
      )) as unknown as typeof fetch,
      loadCatalog: async () => CATALOG,
    }, pool)

    const assembled = new BlockAssembler()
    for await (const chunk of adapter.stream({
      provider: 'kimi-code',
      model: 'k3',
      messages: [{ role: 'user', content: 'hi' } as never],
    } as unknown as GenerateOptions)) assembled.push(chunk)

    expect(assembled.blocks()).toEqual([{ type: 'text', text: 'from the healthy account' }])
    // A rejected refresh marks the account rather than deleting it.
    const marked = (await pool.listAccounts()).find((entry) => entry.id === dead.id)
    expect(marked).toBeDefined()
  })
})

interface FakeResponse { status: number; body: unknown }

function fakeExchange(): { response: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { status: 0, body: undefined }
  const response = {
    writeHead(status: number) { captured.status = status },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...input.headers },
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
