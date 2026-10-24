/**
 * The Cline Pass settings API: envelope shape, account handling, pins,
 * visibility and the no-secret boundary.
 *
 * Nothing here reaches Cline: the engine is a double, the pool and credential
 * store are in-memory, and the model settings file lives in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerClinePassRoutes, type ClinePassRouteOptions } from '../src/host/cline-pass/routes.ts'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import { ClinePassModelSettingsStore, FileCredentialStore, type ClinePassCredentials } from '../src/host/cline-pass/token-store.ts'
import { ClinePassLoginManager } from '../src/host/cline-pass/oauth.ts'
import { createClinePassEngine } from './cline-pass-test-helpers.ts'
import { DEFAULT_MODELS } from '../src/host/cline-pass/types.ts'
import type { ClinePassCatalogAddResultDto, ClinePassWebStatus } from '../src/shared/cline-pass-contracts.ts'

interface Captured {
  status: number
  body: { ok: boolean; value?: unknown; error?: unknown }
  raw: string
}

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: { ok: false }, raw: '' }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? ''
      if (raw !== undefined && raw !== '') captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin
  const chunks = input.method === 'POST' && input.body !== undefined ? [Buffer.from(JSON.stringify(input.body))] : []
  return {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  } as unknown as IncomingMessage
}

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

let dir = ''
let pool: ClinePassAccountPool
let settings: ClinePassModelSettingsStore
let store: ReturnType<typeof createClinePassStore>
let engine: ReturnType<typeof createClinePassEngine>
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
let emit: ReturnType<typeof vi.fn>
let dispose: () => void
let login: ClinePassLoginManager
let loginFetch: typeof fetch

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-pass-routes-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  pool = new ClinePassAccountPool({
    store: credential,
    backend: new MemoryBackend() as never,
  })
  settings = new ClinePassModelSettingsStore(path.join(dir, 'models.json'))
  store = createClinePassStore()
  engine = createClinePassEngine({ pool, store, settings })
  const registrations: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  emit = vi.fn()
  const ctx = {
    webServer: {
      register(options: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        registrations.push(options)
        return () => undefined
      },
    },
    emit,
  } as unknown as Context
  loginFetch = (async () => { throw new Error('login fetch not stubbed') }) as typeof fetch
  login = new ClinePassLoginManager({
    fetchFn: (...args) => loginFetch(...args),
    baseURL: () => 'https://api.cline.bot/api/v1',
    onLogin: async (credentials) => {
      await pool.addAccount(credentials, credentials.email ?? credentials.name)
    },
  })
  const options: ClinePassRouteOptions = {
    settings,
    accountPool: pool,
    store,
    engine,
    fetchFn: (async () => new Response('{}')) as typeof fetch,
    login,
    serving: () => true,
    conflict: () => null,
  }
  dispose = registerClinePassRoutes(ctx, options)
  handler = registrations[0]!.handler
})

afterEach(async () => {
  login.dispose()
  dispose()
  vi.useRealTimers()
  await fs.rm(dir, { recursive: true, force: true })
})

async function call(input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> {
  const { response, captured } = fakeExchange()
  await handler(fakeRequest(input), response)
  return captured
}

describe('Cline Pass settings API', () => {
  it('serves the whole status the card renders', async () => {
    await pool.addAccount({ apiKey: 'sk-secret', alias: 'main' })
    const captured = await call({ url: '/cline-pass/api/status' })
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
    const status = captured.body.value as ClinePassWebStatus
    expect(status.providerId).toBe('cline-pass')
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.authenticated).toBe(true)
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
    // No credential ever crosses this boundary.
    expect(captured.raw).not.toContain('sk-secret')
  })

  it('adds an account through the shared pool and never returns its key', async () => {
    const captured = await call({
      url: '/cline-pass/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'sk-new', alias: 'backup' },
    })
    expect(captured.status).toBe(200)
    const status = captured.body.value as ClinePassWebStatus
    expect(status.pool.accounts.map((account) => account.alias)).toContain('backup')
    expect(captured.raw).not.toContain('sk-new')
  })

  it('persists a pin and reports it on the next status read', async () => {
    const model = DEFAULT_MODELS[0]!
    const captured = await call({
      url: '/cline-pass/api/models/pin',
      method: 'POST',
      body: { model, upstreams: ['baseten'], exclude: ['deepseek'], pinMode: 'preferred', sort: 'cost', has: ['vision', 'implicit-caching'] },
    })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { pin: { upstreams: string[]; pinMode: string }; status: ClinePassWebStatus }
    expect(value.pin).toMatchObject({ upstreams: ['baseten'], pinMode: 'preferred' })
    const status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.find((entry) => entry.id === model)?.pinned).toEqual(['baseten'])
    expect(status.models.find((entry) => entry.id === model)?.has).toEqual(['vision', 'implicit-caching'])
  })

  it('sizes a searched marketplace model from the gateway, without a refresh first', async () => {
    // The path a user actually takes: type a name, add the hit. Nothing has run
    // `catalog/refresh`, so the only source for this id is the gateway itself.
    vi.spyOn(engine, 'gatewayCatalog').mockResolvedValue({
      ids: ['deepseek/deepseek-v4.1-flash-1017'],
      models: { 'deepseek/deepseek-v4.1-flash-1017': { name: 'DeepSeek V4.1 Flash 1017', contextWindow: 1_048_576 } },
    })
    expect((await call({ url: '/cline-pass/api/catalog/search?q=1017' })).status).toBe(200)
    const added = await call({
      url: '/cline-pass/api/catalog/add',
      method: 'POST',
      body: { model: 'deepseek/deepseek-v4.1-flash-1017', acknowledgeBilling: true },
    })
    expect(added.status).toBe(200)
    const stored = await settings.read()
    // Without the gateway's metadata the row would fall back to 128k, an 8x
    // under-estimate that makes the harness compact far too early.
    expect(stored.catalogModels).toContainEqual(expect.objectContaining({
      id: 'deepseek/deepseek-v4.1-flash-1017',
      contextWindow: 1_048_576,
    }))
  })

  it('keeps the full gateway catalog out of the model list and searches it on demand', async () => {
    await settings.update({
      catalogModels: [{ id: 'cline-pass/official-old' }, { id: 'deepseek/legacy-extra' }],
      exposeCatalog: true,
      enabledModelIds: [],
    })
    vi.spyOn(engine, 'officialModels').mockResolvedValue({
      models: ['cline-pass/official-new'],
      catalog: { 'cline-pass/official-new': { name: 'Official New' } },
      sources: ['cline.api'],
    })
    vi.spyOn(engine, 'gatewayCatalog').mockResolvedValue({
      ids: ['deepseek/legacy-extra', 'deepseek/deepseek-v4-pro', 'cline-pass/sub-extra', 'openai/gpt-new'],
      // The gateway publishes real capacity for a marketplace id that the official
      // scan never lists. An added row has to keep it: the 128k default would
      // under-size a 1M model by 8x and make the harness compact far too early.
      models: { 'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxTokens: 384_000 } },
    })
    const refreshed = await call({ url: '/cline-pass/api/catalog/refresh', method: 'POST', body: {} })
    expect(refreshed.status).toBe(200)
    const stored = await settings.read()
    expect(stored.catalogModels.map((entry) => entry.id)).not.toContain('openai/gpt-new')
    expect(stored.catalogModels).toContainEqual(expect.objectContaining({ id: 'cline-pass/official-new', origin: 'official' }))
    // The complete list survives only as a search index.
    expect(store.catalog().ids).toContain('openai/gpt-new')
    const status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.map((entry) => entry.id)).not.toContain('deepseek/legacy-extra')
    expect(status.models.map((entry) => entry.id)).not.toContain('openai/gpt-new')
    expect(status.models.map((entry) => entry.id)).toContain('cline-pass/official-new')

    const found = await call({ url: '/cline-pass/api/catalog/search?q=v4-pro' })
    expect(found.status).toBe(200)
    expect(found.body.value).toEqual({ results: [{ id: 'deepseek/deepseek-v4-pro', added: false, billing: 'credits' }] })
    // A marketplace id draws on the Cline Credits balance, so it is refused
    // until the caller acknowledges that.
    const refused = await call({ url: '/cline-pass/api/catalog/add', method: 'POST', body: { model: 'deepseek/deepseek-v4-pro' } })
    expect(refused.status).toBe(409)
    expect((refused.body as { code?: string }).code).toBe('credits_billing')
    const added = await call({ url: '/cline-pass/api/catalog/add', method: 'POST', body: { model: 'deepseek/deepseek-v4-pro', acknowledgeBilling: true } })
    expect(added.status).toBe(200)
    expect((added.body.value as ClinePassCatalogAddResultDto).billing).toBe('credits')
    const after = await settings.read()
    expect(after.catalogModels).toContainEqual(expect.objectContaining({
      id: 'deepseek/deepseek-v4-pro',
      origin: 'custom',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1_048_576,
    }))
    expect(after.enabledModelIds).toEqual(['deepseek/deepseek-v4-pro'])
    const visible = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(visible.models.find((entry) => entry.id === 'deepseek/deepseek-v4-pro')?.enabled).toBe(true)

    // A subscription id stays one-click: it is the plan quota, not credits.
    const subFound = await call({ url: '/cline-pass/api/catalog/search?q=sub-extra' })
    expect(subFound.body.value).toEqual({ results: [{ id: 'cline-pass/sub-extra', added: false, billing: 'subscription' }] })
    const subAdded = await call({ url: '/cline-pass/api/catalog/add', method: 'POST', body: { model: 'cline-pass/sub-extra' } })
    expect(subAdded.status).toBe(200)
    expect((subAdded.body.value as ClinePassCatalogAddResultDto).billing).toBe('subscription')
  })

  it('warns when a pin targets the anonymous contributor route', async () => {
    const model = DEFAULT_MODELS[0]!
    const captured = await call({
      url: '/cline-pass/api/models/pin',
      method: 'POST',
      body: { model, upstreams: ['openai-compatible-private'] },
    })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { warnings: string[] }
    expect(value.warnings.some((warning) => warning.startsWith('anonymousUpstream:'))).toBe(true)
  })

  it('shows and hides models without forgetting them', async () => {
    const model = DEFAULT_MODELS[0]!
    await call({ url: '/cline-pass/api/models/visibility', method: 'POST', body: { model, visible: false } })
    let status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.find((entry) => entry.id === model)?.enabled).toBe(false)
    // The id is still listed, so un-hiding is one click rather than a resync.
    expect(status.models.some((entry) => entry.id === model)).toBe(true)
    await call({ url: '/cline-pass/api/models/visibility-all', method: 'POST', body: { mode: 'all' } })
    status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.every((entry) => entry.enabled)).toBe(true)
  })

  it('refuses an invalid settings value and stores a valid one', async () => {
    const invalid = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { defaultContextWindow: -1 },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.ok).toBe(false)
    const valid = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { baseURL: 'https://example.test/api/v1', defaultContextWindow: 200_000 },
    })
    expect(valid.status).toBe(200)
    expect((await settings.read()).baseURL).toBe('https://example.test/api/v1')
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
  })

  it('rejects a cross-origin mutation', async () => {
    const captured = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { enabled: false },
      origin: 'https://evil.test',
    })
    expect(captured.status).toBe(403)
    expect(captured.body.ok).toBe(false)
  })

  it('answers method and path refusals in the same envelope', async () => {
    expect((await call({ url: '/cline-pass/api/settings' })).status).toBe(405)
    expect((await call({ url: '/cline-pass/api/nope' })).status).toBe(404)
  })

  it('starts a device sign-in, polls it, and adds the account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date('2026-10-20T06:00:00Z').getTime()
    vi.setSystemTime(now)
    let authenticate = 0
    loginFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/user_management/authorize/device')) {
        return Response.json({
          device_code: 'device-1',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://app.cline.bot/device',
          verification_uri_complete: 'https://app.cline.bot/device?code=WXYZ-1234',
          expires_in: 300,
          interval: 5,
        })
      }
      if (url.endsWith('/user_management/authenticate')) {
        authenticate += 1
        return authenticate === 1
          ? Response.json({ error: 'authorization_pending' }, { status: 400 })
          : Response.json({ access_token: 'workos-a', refresh_token: 'workos-r' })
      }
      if (url.endsWith('/api/v1/auth/register')) {
        return Response.json({
          success: true,
          data: {
            accessToken: 'cline-a',
            refreshToken: 'cline-r',
            expiresAt: new Date(now + 3_600_000).toISOString(),
            userInfo: { email: 'signed@example.com', clineUserId: 'user-9' },
          },
        })
      }
      throw new Error('Unexpected login request ' + url)
    }) as typeof fetch

    const started = await call({ url: '/cline-pass/api/login/start', method: 'POST', body: {} })
    expect(started.status).toBe(200)
    const flow = started.body.value as { id: string; userCode: string; status: string }
    expect(flow).toMatchObject({ userCode: 'WXYZ-1234', status: 'pending' })

    // Too early: the host must not spend a WorkOS poll.
    const early = await call({ url: '/cline-pass/api/login/status?id=' + encodeURIComponent(flow.id) })
    expect((early.body.value as { status: string }).status).toBe('pending')
    expect(authenticate).toBe(0)

    vi.setSystemTime(now + 5_000)
    await call({ url: '/cline-pass/api/login/status?id=' + encodeURIComponent(flow.id) })
    vi.setSystemTime(now + 10_000)
    const complete = await call({ url: '/cline-pass/api/login/status?id=' + encodeURIComponent(flow.id) })
    expect((complete.body.value as { status: string }).status).toBe('complete')
    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ alias: 'signed@example.com', authKind: 'oauth' })
    const status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.login?.status).toBe('complete')
    expect(status.pool.accounts[0]?.authKind).toBe('oauth')
  })

  it('serves the in-process history newest first', async () => {
    store.record({ model: 'cline-pass/glm-5.3', provider: 'baseten', account: 'main', ms: 120, ttft: 20, stream: true })
    const captured = await call({ url: '/cline-pass/api/history?limit=10' })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { total: number; entries: Array<{ model: string; provider: string }> }
    expect(value.total).toBe(1)
    expect(value.entries[0]).toMatchObject({ model: 'cline-pass/glm-5.3', provider: 'baseten' })
  })
})
