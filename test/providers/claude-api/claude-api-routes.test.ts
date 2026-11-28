import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLAUDE_API_DEFAULT_BASE_URL, CLAUDE_API_ROUTE_PREFIX } from '../../../src/shared/claude-api-contracts.ts'
import { flushCatalogSnapshots } from '../../../src/host/common/catalog-snapshot.ts'
import { ClaudeApiCatalogManager } from '../../../src/host/providers/claude-api/catalog-manager.ts'
import { ClaudeApiAccountPool, type ClaudeApiPoolAccount } from '../../../src/host/providers/claude-api/account-pool.ts'
import type { PoolData } from '../../../src/host/common/account-pool.ts'
import { ClaudeApiClientVersionResolver } from '../../../src/host/providers/claude-api/client-version.ts'
import { CLAUDE_API_MODELS } from '../../../src/host/providers/claude-api/model-catalog.ts'
import { registerClaudeApiRoutes } from '../../../src/host/providers/claude-api/routes.ts'
import {
  ClaudeApiCredentialStore,
  ClaudeApiSettingsStore,
  type ClaudeApiCredentials,
} from '../../../src/host/providers/claude-api/token-store.ts'

const LISTING = { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'gateway-only', display_name: 'Gateway Only' }] }
const FALLBACK_IDS = CLAUDE_API_MODELS.map(entry => entry.id)
const KEY = 'sk-route-secret'

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-routes-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>
async function fixture() {
  let credentials: ClaudeApiCredentials | null = null
  const backend = {
    load: async () => credentials,
    save: async (value: ClaudeApiCredentials) => { credentials = value },
    clear: async () => { credentials = null },
  }
  const store = new ClaudeApiCredentialStore(path.join(home, 'storages', 'credentials.json'), backend)
  const settingsStore = new ClaudeApiSettingsStore(path.join(home, 'storages', 'settings.json'))
  let poolData: PoolData<ClaudeApiPoolAccount> | null = null
  const pool = new ClaudeApiAccountPool({
    store, settingsStore,
    backend: {
      load: async () => poolData,
      save: async value => { poolData = structuredClone(value) },
      clear: async () => { poolData = null },
    },
  })
  const version = new ClaudeApiClientVersionResolver({
    fetchFn: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch,
    filePath: path.join(home, 'storages', 'client-version.json'),
    env: {},
  })
  const urls: string[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return Response.json(LISTING)
  }) as unknown as typeof fetch
  const catalog = new ClaudeApiCatalogManager(pool, settingsStore, { version, fetchFn })
  let handler: Handler | undefined
  const emit = vi.fn()
  const ctx = {
    webServer: { register: (config: { handler: Handler }) => { handler = config.handler; return () => undefined } },
    emit,
  } as unknown as Context
  const dispose = registerClaudeApiRoutes(ctx, pool, settingsStore, catalog, {
    version, fetchFn, serving: () => true, conflict: () => null,
  })
  async function invoke(method: string, suffix: string, body?: unknown, origin = 'http://localhost') {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
    request.method = method
    request.url = CLAUDE_API_ROUTE_PREFIX + suffix
    request.headers = { host: 'localhost', origin }
    let status = 0
    let responseBody = ''
    const response = {
      writeHead: vi.fn((value: number) => { status = value; return response }),
      end: vi.fn((value?: string) => { responseBody = value ?? '' }),
    } as unknown as ServerResponse
    await handler!(request, response)
    return { status, body: responseBody, json: (responseBody ? JSON.parse(responseBody) : {}) as { ok: boolean; value?: any; error?: string } }
  }
  return { store, pool, settingsStore, catalog, version, fetchFn, urls, emit, dispose, invoke, getCredentials: () => credentials }
}

const MUTATIONS: Array<[string, string, unknown]> = [
  ['POST', '/settings', { enabled: false }],
  ['POST', '/key', { apiKey: KEY }],
  ['POST', '/accounts', { action: 'save', baseUrl: 'https://backup.example', apiKey: KEY }],
  ['DELETE', '/key', undefined],
  ['POST', '/test', undefined],
  ['POST', '/catalog/refresh', undefined],
]

describe('Claude API HTTP routes', () => {
  it('rejects every cross-origin mutation before storage or network', async () => {
    const f = await fixture()
    for (const [method, suffix, body] of MUTATIONS) {
      const response = await f.invoke(method, suffix, body, 'https://evil.example')
      expect(response.status, method + ' ' + suffix).toBe(403)
      expect(response.json).toEqual({ ok: false, error: 'Cross-origin request rejected.' })
    }
    expect(f.getCredentials()).toBeNull()
    expect(f.fetchFn).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
    expect((await f.settingsStore.read()).enabled).toBe(true)
    f.dispose()
  })
  it('never returns the API key or the device id in any response', async () => {
    const f = await fixture()
    const deviceId = await f.settingsStore.ensureDeviceId()
    expect(deviceId).toMatch(/^[0-9a-f]{64}$/)
    const answers = [
      await f.invoke('GET', '/status'),
      await f.invoke('POST', '/key', { apiKey: KEY }),
      await f.invoke('POST', '/settings', { fastMode: true }),
      await f.invoke('POST', '/test'),
      await f.invoke('POST', '/catalog/refresh'),
      await f.invoke('DELETE', '/key'),
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(200)
      expect(answer.body).not.toContain(KEY)
      expect(answer.body).not.toContain(deviceId)
      expect(answer.body).not.toContain('deviceId')
      expect(answer.body).not.toContain('apiKey')
    }
    expect(answers[1]!.json.value.authenticated).toBe(true)
    expect(answers[1]!.json.value.clientVersion).toEqual({ value: '2.1.330', source: 'default', fetchedAt: null, pending: null })
    expect(answers[1]!.json.value.serving).toBe(true)
    expect(answers[1]!.json.value.conflict).toBeNull()
    expect(answers[5]!.json.value.authenticated).toBe(false)
    f.dispose()
  })
  it('names the reason when an endpoint is invalid and leaves settings untouched', async () => {
    const f = await fixture()
    for (const [baseUrl, reason] of [['', 'empty'], ['nonsense', 'invalid'], ['ftp://gw.example', 'scheme'], ['https://u:p@gw.example', 'credentials'], ['https://gw.example/?a=1', 'query']] as Array<[string, string]>) {
      const response = await f.invoke('POST', '/settings', { baseUrl })
      expect(response.status, baseUrl).toBe(400)
      expect(response.json?.error).toContain(reason)
      expect((await f.settingsStore.read()).baseUrl).toBe(CLAUDE_API_DEFAULT_BASE_URL)
    }
    f.dispose()
  })
  it('normalizes a patch endpoint and restores the default on null', async () => {
    const f = await fixture()
    const patched = await f.invoke('POST', '/settings', { baseUrl: 'https://gw.example/api/v1/' })
    expect(patched.status).toBe(200)
    expect(patched.json.value.baseUrl).toBe('https://gw.example/api')
    expect(patched.json.value.defaultBaseUrl).toBe(CLAUDE_API_DEFAULT_BASE_URL)
    const restored = await f.invoke('POST', '/settings', { baseUrl: null })
    expect(restored.json.value.baseUrl).toBe(CLAUDE_API_DEFAULT_BASE_URL)
    f.dispose()
  })
  it('resets the catalog and refreshes in the background when the endpoint changes', async () => {
    const f = await fixture()
    await f.invoke('POST', '/key', { apiKey: KEY })
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().live).toBe(true)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = new Promise<Response>(resolve => { setTimeout(() => { resolve(Response.json(LISTING)); release() }, 20) })
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      f.urls.push(String(input))
      return String(input).startsWith('https://gw.example') ? slow : Response.json(LISTING)
    })
    const response = await f.invoke('POST', '/settings', { baseUrl: 'https://gw.example' })
    expect(response.status).toBe(200)
    expect(response.json.value.baseUrl).toBe('https://gw.example')
    expect(response.json.value.catalog.state).toBe('idle')
    expect(response.json.value.models.map((model: { id: string }) => model.id)).toEqual(FALLBACK_IDS)
    expect(f.emit).toHaveBeenCalledWith('llm/adapters-updated')
    release()
    await gate
    await vi.waitFor(() => expect(f.urls.some(url => url.startsWith('https://gw.example/v1/models'))).toBe(true))
    f.dispose()
  })
  it('answers status without awaiting a slow network refresh', async () => {
    const f = await fixture()
    await f.store.write({ apiKey: KEY, authenticatedAt: 1 })
    let listingDone = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow = new Promise<Response>(resolve => {
      setTimeout(() => { listingDone = true; resolve(Response.json(LISTING)); release() }, 150)
    })
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => slow)
    const response = await f.invoke('GET', '/status')
    expect(response.status).toBe(200)
    expect(listingDone).toBe(false)
    expect(response.json.value.authenticated).toBe(true)
    expect(response.json.value.catalog.state).toBe('idle')
    expect(response.json.value.models.map((model: { id: string }) => model.id)).toEqual(FALLBACK_IDS)
    await gate
    f.dispose()
  })
  it('stores a key, removes it with DELETE /key and resets the catalog', async () => {
    const f = await fixture()
    const stored = await f.invoke('POST', '/key', { apiKey: '  ' + KEY + '  ' })
    expect(stored.status).toBe(200)
    expect(f.getCredentials()?.apiKey).toBe(KEY)
    await f.catalog.refresh(true)
    expect(f.catalog.snapshot().live).toBe(true)
    const removed = await f.invoke('DELETE', '/key')
    expect(removed.status).toBe(200)
    expect(removed.json.value.authenticated).toBe(false)
    expect(f.getCredentials()).toBeNull()
    expect(f.catalog.snapshot().live).toBe(false)
    expect(f.catalog.snapshot().entries.map(entry => entry.id)).toEqual(FALLBACK_IDS)
    const empty = await f.invoke('POST', '/key', { apiKey: '   ' })
    expect(empty.status).toBe(400)
    f.dispose()
  })
  it('accepts an explicit all-off selection and rejects unknown model ids', async () => {
    const f = await fixture()
    await f.invoke('POST', '/key', { apiKey: KEY })
    const off = await f.invoke('POST', '/settings', { enabledModelIds: [] })
    expect(off.status).toBe(200)
    expect(off.json.value.models.every((model: { enabled: boolean }) => model.enabled === false)).toBe(true)
    const unknown = await f.invoke('POST', '/settings', { enabledModelIds: ['not-in-catalog'] })
    expect(unknown.status).toBe(400)
    const known = await f.invoke('POST', '/settings', { enabledModelIds: ['claude-opus-5-5'] })
    expect(known.status).toBe(200)
    f.dispose()
  })
  it('tests the connection through the injected fetch and reports a missing key', async () => {
    const f = await fixture()
    const missing = await f.invoke('POST', '/test')
    expect(missing.status).toBe(200)
    expect(missing.json.value).toMatchObject({ connected: false, modelCount: 0 })
    await f.invoke('POST', '/key', { apiKey: KEY })
    const tested = await f.invoke('POST', '/test')
    expect(tested.json.value).toMatchObject({ connected: true, modelCount: 2 })
    expect(tested.body).not.toContain(KEY)
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'denied ' + KEY } }), { status: 401 }))
    const denied = await f.invoke('POST', '/test')
    expect(denied.json.value.connected).toBe(false)
    expect(denied.body).not.toContain(KEY)
    expect(denied.body).toContain('[REDACTED]')
    f.dispose()
  })

  it('adds accounts with independent endpoints, sets primary and tests only the selected account', async () => {
    const f = await fixture()
    const primary = await f.invoke('POST', '/accounts', { action: 'save', alias: 'Main', baseUrl: 'https://main.example/v1/', apiKey: 'sk-main' })
    expect(primary.status).toBe(200)
    expect(primary.json.value.accounts).toHaveLength(1)
    expect(primary.json.value.accounts[0]).toMatchObject({ alias: 'Main', baseUrl: 'https://main.example', isPrimary: true })
    const backup = await f.invoke('POST', '/accounts', { action: 'save', alias: 'Backup', baseUrl: 'https://backup.example', apiKey: 'sk-backup' })
    expect(backup.json.value.accounts).toHaveLength(2)
    expect(backup.body).not.toContain('sk-main')
    expect(backup.body).not.toContain('sk-backup')
    const backupId = backup.json.value.accounts.find((account: any) => account.alias === 'Backup').id
    const promoted = await f.invoke('POST', '/accounts', { action: 'set-primary', accountId: backupId })
    expect(promoted.json.value.baseUrl).toBe('https://backup.example')
    await f.invoke('POST', '/test', { accountId: backupId })
    expect(f.urls.at(-1)).toContain('https://backup.example/v1/models')
    const strategy = await f.invoke('POST', '/accounts', { action: 'strategy', strategy: 'sticky' })
    expect(strategy.json.value.rotationStrategy).toBe('sticky')
    f.dispose()
  })

  it('answers 404 for an unknown path and 405 for a wrong method', async () => {
    const f = await fixture()
    expect((await f.invoke('GET', '/nope')).status).toBe(404)
    expect((await f.invoke('POST', '/status')).status).toBe(405)
    expect((await f.invoke('GET', '/key')).status).toBe(405)
    expect((await f.invoke('DELETE', '/settings')).status).toBe(405)
    f.dispose()
  })
})
