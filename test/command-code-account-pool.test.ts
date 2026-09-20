import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  CommandCodeAccountPool,
  commandCodeAccountKey,
  parseCommandCodePoolData,
} from '../src/host/command-code/account-pool.ts'
import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type CommandCodeCredentials,
} from '../src/host/command-code/token-store.ts'
import { clearCachedCatalog, clearCachedQuota, fetchAccountQuota, getCachedQuotaFor } from '../src/host/command-code/client.ts'
import { registerCommandCodeRoutes } from '../src/host/command-code/routes.ts'

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
  private data: CommandCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: CommandCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function key(n: number, overrides: Partial<CommandCodeCredentials> = {}): CommandCodeCredentials {
  return {
    apiKey: `cmd-key-${n}`,
    userId: `user-${n}`,
    userName: `User ${n}`,
    email: `user${n}@example.com`,
    keyName: `laptop-${n}`,
    planLabel: 'GOAT',
    authenticatedAt: Date.now(),
    ...overrides,
  }
}

function harness(options: { mirror?: CommandCodeCredentials | null } = {}) {
  const mirrorBackend = new CredentialBackend()
  if (options.mirror) void mirrorBackend.save(options.mirror)
  const mirror = new FileCredentialStore(tmp('cc-mirror'), mirrorBackend as never)
  const poolBackend = new PoolBackend(parseCommandCodePoolData)
  const pool = new CommandCodeAccountPool({ store: mirror, backend: poolBackend as never })
  return { pool, mirror, mirrorBackend, poolBackend }
}

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

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

afterEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
  vi.restoreAllMocks()
})

describe('CommandCodeAccountPool', () => {
  it('projects the pre-pool key as the primary account without writing', async () => {
    const { pool, poolBackend } = harness({ mirror: key(1) })
    const save = vi.spyOn(poolBackend, 'save')

    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.id).toBe('acc_primary')
    expect(data.accounts[0]!.isPrimary).toBe(true)
    expect(save).not.toHaveBeenCalled()

    expect((await pool.listAccounts())[0]).toMatchObject({
      email: 'user1@example.com',
      keyName: 'laptop-1',
      planLabel: 'GOAT',
      isPrimary: true,
    })
  })

  it('treats two keys of one account as distinct and re-signing in the same key as an update', async () => {
    const { pool, mirror } = harness()
    const laptop = await pool.addAccount(key(1, { keyName: 'laptop' }))
    const desktop = await pool.addAccount(key(1, { keyName: 'desktop', apiKey: 'cmd-key-desktop' }))
    expect(laptop.isPrimary).toBe(true)
    expect(desktop.isPrimary).toBe(false)
    expect(await pool.listAccounts()).toHaveLength(2)
    // The mirror follows the primary account, so the pre-pool file keeps working.
    expect((await mirror.read() as CommandCodeCredentials | null)?.apiKey).toBe('cmd-key-1')

    const again = await pool.addAccount(key(1, { keyName: 'laptop', apiKey: 'cmd-key-rotated' }))
    expect(again.id).toBe(laptop.id)
    expect(again.credentials.apiKey).toBe('cmd-key-rotated')
    expect(await pool.listAccounts()).toHaveLength(2)

    expect(commandCodeAccountKey(key(1, { keyName: 'laptop' }))).toBe('user-1:laptop')
    expect(commandCodeAccountKey({ apiKey: 'only-key' })).toMatch(/^[a-f0-9]{64}$/)
  })

  it('cools a rate-limited key down and rotates to the next one', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(key(1))
    const second = await pool.addAccount(key(2))
    await pool.setPrimary(first.id)

    expect((await pool.getEffectiveCredential()).credentials.apiKey).toBe('cmd-key-1')
    await pool.markCooldown(first.id, 600_000, 'Command Code 429')
    const rotated = await pool.getEffectiveCredential()
    expect(rotated.account.id).toBe(second.id)
    expect(rotated.apiEnv).toBe('prod')
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)?.cooldownUntil).toBeGreaterThan(Date.now())

    await pool.markCooldown(second.id, 600_000, 'Command Code 429')
    await expect(pool.getEffectiveCredential()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    // A key with no environment of its own is served by the configured default.
    const staging = await pool.addAccount(key(3, { apiEnv: 'staging' }))
    expect((await pool.getEffectiveCredential()).account.id).toBe(staging.id)
    expect((await pool.getEffectiveCredential()).apiEnv).toBe('staging')
  })

  it('keeps a rejected key in the pool but out of rotation until it is signed in again', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(key(1))
    const second = await pool.addAccount(key(2))
    await pool.setPrimary(first.id)

    await pool.markAuthFailed(first.id, 'rejected', 'invalid')
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)).toMatchObject({
      authStatus: 'invalid',
      authFailedReason: 'rejected',
    })
    expect((await pool.getEffectiveCredential()).account.id).toBe(second.id)

    await pool.addAccount(key(1, { apiKey: 'cmd-key-1-refreshed' }))
    expect((await pool.listAccounts()).find((entry) => entry.id === first.id)?.authStatus).toBeUndefined()
    expect((await pool.listAccounts())).toHaveLength(2)
  })

  it('reports the pool in the settings status and drives the accounts route', async () => {
    const { pool, mirror } = harness()
    await pool.addAccount(key(1))
    const second = await pool.addAccount(key(2))
    const store = new FileCredentialStore(tmp('cc-route-cred'), new CredentialBackend() as never)
    const modelSettings = new FileModelSettingsStore(tmp('cc-route-models'))
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = { webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } } } as unknown as Context
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json({ object: 'list', data: [] })) as typeof fetch
    try {
      registerCommandCodeRoutes(ctx, store, modelSettings, undefined, {}, pool)
      const handler = routes[0]!.handler

      const status = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/status' }), status.response)
      const value = (status.captured.body as { value: { accounts: unknown[]; rotationStrategy: string; activeAccountId?: string } }).value
      expect(value.accounts).toHaveLength(2)
      expect(value.rotationStrategy).toBe('sequential')
      expect(value.activeAccountId).toBeDefined()

      const promote = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/accounts', method: 'POST', body: { action: 'set-primary', accountId: second.id } }), promote.response)
      expect((promote.captured.body as { value: { activeAccountId?: string } }).value.activeAccountId).toBe(second.id)

      const strategy = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/accounts', method: 'POST', body: { action: 'strategy', strategy: 'sticky' } }), strategy.response)
      expect((strategy.captured.body as { value: { rotationStrategy: string } }).value.rotationStrategy).toBe('sticky')

      const alias = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/accounts', method: 'POST', body: { action: 'set-alias', accountId: second.id, alias: '备用密钥' } }), alias.response)
      expect((alias.captured.body as { value: { accounts: Array<{ alias: string }> } }).value.accounts.find((entry) => entry.alias === '备用密钥')).toBeDefined()

      const crossOrigin = fakeExchange()
      await handler(
        fakeRequest({ url: '/command-code/api/accounts', method: 'POST', headers: { origin: 'https://evil.example' }, body: { action: 'strategy', strategy: 'sticky' } }),
        crossOrigin.response,
      )
      expect(crossOrigin.captured.status).toBe(403)

      const signOutOne = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/logout', method: 'POST', body: { accountId: second.id } }), signOutOne.response)
      expect((signOutOne.captured.body as { value: { accounts: unknown[] } }).value.accounts).toHaveLength(1)

      const signOutRest = fakeExchange()
      await handler(fakeRequest({ url: '/command-code/api/logout', method: 'POST', body: {} }), signOutRest.response)
      expect((signOutRest.captured.body as { value: { accounts: unknown[]; authenticated: boolean } }).value.accounts).toHaveLength(0)
      expect((signOutRest.captured.body as { value: { authenticated: boolean } }).value.authenticated).toBe(false)
      expect(await mirror.read()).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never serves one account the quota snapshot of another', async () => {
    const source = { read: async () => key(1) }
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }))
    await fetchAccountQuota(source, fetchMock as unknown as typeof fetch, false, 'acc_a')
    expect(getCachedQuotaFor('acc_a')).toBeDefined()
    expect(getCachedQuotaFor('acc_b')).toBeUndefined()
    // A second account refetches rather than reusing the first one's snapshot.
    const callsBefore = fetchMock.mock.calls.length
    await fetchAccountQuota(source, fetchMock as unknown as typeof fetch, false, 'acc_b')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(getCachedQuotaFor('acc_b')).toBeDefined()
    expect(getCachedQuotaFor('acc_a')).toBeUndefined()
    clearCachedQuota()
    expect(getCachedQuotaFor('acc_b')).toBeUndefined()
  })
})

describe('CommandCodeAdapter account rotation', () => {
  it('retries a 429 on the next pooled key and cools the first one down', async () => {
    const { pool, mirror, mirrorBackend } = harness({ mirror: key(1) })
    await mirrorBackend.save(key(1))
    const second = await pool.addAccount(key(2))
    const modelSettings = new FileModelSettingsStore(tmp('cc-rotate-models'))
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabled: true,
      enabledModelIds: ['deepseek/deepseek-v4.1-flash'],
      catalogModels: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    })

    const authorizations: string[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      authorizations.push(headers.authorization)
      if (headers.authorization === 'Bearer cmd-key-1') {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } })
      }
      return sseResponse([
        { choices: [{ delta: { content: 'served by the second key' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    })
    const adapter = new CommandCodeAdapter(mirror, modelSettings, undefined, {
      fetchFn: fetchMock as unknown as typeof fetch,
      loadCatalog: async () => [],
    }, pool)

    const assembled = new BlockAssembler()
    for await (const chunk of adapter.stream({
      provider: 'command-code',
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as unknown as GenerateOptions)) assembled.push(chunk)

    expect(authorizations).toEqual(['Bearer cmd-key-1', 'Bearer cmd-key-2'])
    expect(assembled.blocks()).toEqual([{ type: 'text', text: 'served by the second key' }])
    const first = (await pool.listAccounts()).find((entry) => entry.keyName === 'laptop-1')
    expect(first?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(second.isPrimary).toBe(false)
  })

  it('keeps the single-key behavior when no pool is installed', async () => {
    const store = new FileCredentialStore(tmp('cc-single-cred'), new CredentialBackend() as never)
    await store.write(key(1))
    const modelSettings = new FileModelSettingsStore(tmp('cc-single-models'))
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabled: true,
      enabledModelIds: ['deepseek/deepseek-v4.1-flash'],
      catalogModels: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    })
    const adapter = new CommandCodeAdapter(store, modelSettings, undefined, {
      fetchFn: (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
      loadCatalog: async () => [],
    })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'command-code',
        model: 'deepseek/deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    // The single-key path never invents pool state of its own.
    expect((await store.read())?.apiKey).toBe('cmd-key-1')
  })
})
