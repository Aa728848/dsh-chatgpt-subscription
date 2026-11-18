import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'
import { RelayOneCatalogManager } from '../src/host/relayone/catalog-manager.ts'
import { registerRelayOneRoutes } from '../src/host/relayone/routes.ts'
import { RelayOneCredentialStore, RelayOneSettingsStore, type RelayOneCredentials } from '../src/host/relayone/token-store.ts'
import { RelayOneQuotaReader } from '../src/host/relayone/quota.ts'
import { RELAYONE_ROUTE_PREFIX } from '../src/shared/relayone-contracts.ts'

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-routes-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  const storages = path.join(home, 'storages')
  const names = await fs.readdir(storages).catch(() => [] as string[])
  for (const name of names) {
    const target = path.join(storages, name)
    const stat = await fs.lstat(target).catch(() => undefined)
    if (stat?.isFile() || stat?.isSymbolicLink()) await fs.unlink(target)
  }
  await fs.rmdir(storages).catch(() => undefined)
  await fs.rmdir(home).catch(() => undefined)
})

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>
async function fixture() {
  let credentials: RelayOneCredentials | null = null
  const backend = {
    load: async () => credentials,
    save: async (value: RelayOneCredentials) => { credentials = value },
    clear: async () => { credentials = null },
  }
  const store = new RelayOneCredentialStore(path.join(home, 'storages', 'credentials.json'), backend)
  const settings = new RelayOneSettingsStore(path.join(home, 'storages', 'settings.json'))
  const fetchFn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gpt-6-astra', supported_endpoint_types: ['openai'] }] })
    if (url.endsWith('/api/pricing')) return Response.json({ data: [{ model_name: 'gpt-6-astra', vendor_id: -1012, enable_groups: ['openai'], supported_endpoint_types: ['openai'] }], vendors: [{ id: -1012, name: 'OpenAI' }] })
    if (url.endsWith('/api/usage/token')) return Response.json({ code: true, data: { total_granted: 1000000, total_used: 250000, total_available: 750000, unlimited_quota: false, expires_at: 0 } })
    if (url.endsWith('/api/status')) return Response.json({ success: true, data: { quota_per_unit: 500000 } })
    throw new Error('unexpected ' + url)
  }) as unknown as typeof fetch
  const catalog = new RelayOneCatalogManager(store, { fetchFn })
  const quota = new RelayOneQuotaReader(store, { fetchFn })
  let handler: Handler | undefined
  const emit = vi.fn()
  const ctx = {
    webServer: { register: (config: { handler: Handler }) => { handler = config.handler; return () => undefined } },
    emit,
  } as unknown as Context
  const dispose = registerRelayOneRoutes(ctx, store, settings, catalog, { quota })
  async function invoke(method: string, suffix: string, body?: unknown, origin = 'http://localhost') {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
    request.method = method
    request.url = RELAYONE_ROUTE_PREFIX + suffix
    request.headers = { host: 'localhost', origin }
    let status = 0
    let responseBody = ''
    const response = {
      writeHead: vi.fn((value: number) => { status = value; return response }),
      end: vi.fn((value?: string) => { responseBody = value ?? '' }),
    } as unknown as ServerResponse
    await handler!(request, response)
    return { status, body: responseBody, json: responseBody ? JSON.parse(responseBody) as any : undefined }
  }
  return { store, settings, catalog, fetchFn, emit, dispose, invoke, getCredentials: () => credentials }
}

describe('RelayOne HTTP routes', () => {
  it('rejects a cross-origin credential mutation before storage or network', async () => {
    const f = await fixture()
    const response = await f.invoke('PUT', '/credentials', { apiKey: 'sk-cross-origin' }, 'https://evil.example')
    expect(response.status).toBe(403)
    expect(f.getCredentials()).toBeNull()
    expect(f.fetchFn).not.toHaveBeenCalled()
    f.dispose()
  })
  it('stores a valid key, discovers its models and never returns the key in DTOs', async () => {
    const f = await fixture()
    const response = await f.invoke('PUT', '/credentials', { apiKey: 'sk-route-test' })
    expect(response.status).toBe(200)
    expect(response.body).not.toContain('sk-route-test')
    expect(response.json.value).toMatchObject({ authenticated: true, models: [{ id: 'gpt-6-astra', protocol: 'openai-responses' }], quota: { state: 'ready', totalAvailable: 750000, remainingPercent: 75, quotaPerUnit: 500000 } })
    expect(f.getCredentials()?.apiKey).toBe('sk-route-test')
    expect(f.emit).toHaveBeenCalledWith('llm/adapters-updated')
    f.dispose()
  })
  it('accepts an explicit all-off selection and rejects unknown model ids', async () => {
    const f = await fixture()
    await f.invoke('PUT', '/credentials', { apiKey: 'sk-route-test' })
    const off = await f.invoke('PATCH', '/settings', { enabledModelIds: [] })
    expect(off.status).toBe(200)
    expect(off.json.value.models[0].enabled).toBe(false)
    const unknown = await f.invoke('PATCH', '/settings', { enabledModelIds: ['public-only'] })
    expect(unknown.status).toBe(400)
    f.dispose()
  })
  it('answers status without awaiting a slow network refresh', async () => {
    const f = await fixture()
    let release: ((value: Response) => void) | undefined
    const slow = new Promise<Response>(resolve => { release = resolve })
    const store = f.store
    await store.write({ apiKey: 'sk-slow', authenticatedAt: 1 })
    ;(f.fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/models')) return slow
      return Promise.resolve(Response.json({ data: [] }))
    })
    const response = await f.invoke('GET', '/status')
    expect(response.status).toBe(200)
    expect(response.json.value.authenticated).toBe(true)
    expect(response.json.value.catalog.state).toBe('idle')
    release?.(Response.json({ data: [] }))
    await f.catalog.refresh(true)
    f.dispose()
  })
})
