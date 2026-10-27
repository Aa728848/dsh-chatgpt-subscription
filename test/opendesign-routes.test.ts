/**
 * The OpenDesign settings API: envelope shape, account handling, catalog sync,
 * visibility and the no-secret boundary.
 *
 * Nothing here reaches OpenDesign: the pool and credential store are in-memory,
 * the model settings file lives in a temp directory, and fetch is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerOpenDesignRoutes, type OpenDesignRouteOptions } from '../src/host/opendesign/routes.ts'
import { fetchCodingPlanUsage, fetchWorkspaceId } from '../src/host/opendesign/client.ts'
import { OpenDesignAccountPool } from '../src/host/opendesign/account-pool.ts'
import { FileCredentialStore, OpenDesignModelSettingsStore, type OpenDesignCredentials } from '../src/host/opendesign/token-store.ts'
import { DEFAULT_MODELS } from '../src/host/opendesign/types.ts'
import { OpenDesignLoginManager } from '../src/host/opendesign/oauth.ts'
import { OpenDesignAdapter } from '../src/host/opendesign/adapter.ts'
import type { OpenDesignWebStatus } from '../src/shared/opendesign-contracts.ts'

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
let pool: OpenDesignAccountPool
let settings: OpenDesignModelSettingsStore
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
let emit: ReturnType<typeof vi.fn>
let dispose: () => void
let upstreamFetch: typeof fetch
let loginFetch: typeof fetch
let login: OpenDesignLoginManager

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-routes-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<OpenDesignCredentials>() as never)
  pool = new OpenDesignAccountPool({
    store: credential,
    backend: new MemoryBackend() as never,
  })
  settings = new OpenDesignModelSettingsStore(path.join(dir, 'models.json'))
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
  upstreamFetch = (async () => new Response('{"data":[]}')) as typeof fetch
  loginFetch = (async () => { throw new Error('login fetch not stubbed') }) as typeof fetch
  login = new OpenDesignLoginManager({
    fetchFn: (...args) => loginFetch(...args),
    host: () => 'test-host',
    onLogin: async (credentials) => {
      await pool.addAccount(credentials, credentials.user?.name ?? credentials.user?.email)
    },
  })
  const options: OpenDesignRouteOptions = {
    settings,
    accountPool: pool,
    fetchFn: (...args) => upstreamFetch(...args),
    login,
    serving: () => true,
    conflict: () => null,
  }
  dispose = registerOpenDesignRoutes(ctx, options)
  handler = registrations[0]!.handler
})

afterEach(async () => {
  login.dispose()
  dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

async function call(input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> {
  const { response, captured } = fakeExchange()
  await handler(fakeRequest(input), response)
  return captured
}

describe('OpenDesign settings API', () => {
  it('serves the whole status the card renders', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_secret', alias: 'main' })
    const captured = await call({ url: '/opendesign/api/status' })
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.providerId).toBe('opendesign')
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.authenticated).toBe(true)
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
    // No credential ever crosses this boundary.
    expect(captured.raw).not.toContain('od_secret')
  })

  it('reports an unsigned line honestly: no accounts, still configurable', async () => {
    const captured = await call({ url: '/opendesign/api/status' })
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.pool.accounts).toEqual([])
    expect(status.authenticated).toBe(false)
    expect(status.serving).toBe(true)
    expect(status.catalogSynced).toBe(false)
  })

  it('adds an account without ever answering with the key', async () => {
    const captured = await call({
      url: '/opendesign/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'od_live_key', alias: '主号' },
    })
    expect(captured.status).toBe(200)
    expect(captured.raw).not.toContain('od_live_key')
    const status = captured.body.value as OpenDesignWebStatus
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.pool.accounts[0]!.alias).toBe('主号')
    expect(status.pool.accounts[0]!.authKind).toBe('api-key')
  })

  it('tests a typed key with the free catalog read, not a paid chat', async () => {
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      expect(url).toBe('https://amr-link.open-design.ai/v1/models')
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key === 'Bearer od_bad') {
        return Response.json({ error: { code: 'invalid_api_key', message: 'api key not found' } }, { status: 401 })
      }
      return Response.json({ data: [{ id: 'gpt-6-luna' }, { id: 'kimi-k3' }] })
    }) as typeof fetch
    const good = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', apiKey: 'od_ok' } })
    expect((good.body.value as { authorized: boolean; modelCount: number }).authorized).toBe(true)
    expect((good.body.value as { modelCount: number }).modelCount).toBe(2)
    const bad = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', apiKey: 'od_bad' } })
    const verdict = bad.body.value as { authorized: boolean; error: string }
    expect(verdict.authorized).toBe(false)
    expect(verdict.error).toContain('api key not found')
  })

  it('tests a stored account without the caller knowing the key', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_stored', alias: 'main' })
    const accountId = (await pool.listAccounts())[0]!.id
    let seenKey = ''
    upstreamFetch = (async (_input: unknown, init?: RequestInit) => {
      seenKey = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({ data: [{ id: 'gpt-6-luna' }] })
    }) as typeof fetch
    const captured = await call({ url: '/opendesign/api/accounts', method: 'POST', body: { action: 'test', accountId } })
    expect(captured.status).toBe(200)
    expect(seenKey).toBe('Bearer od_stored')
    expect(captured.raw).not.toContain('od_stored')
  })

  it('rejects a cross-origin mutation', async () => {
    const captured = await call({
      url: '/opendesign/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'od_x' },
      origin: 'https://evil.example',
    })
    expect(captured.status).toBe(403)
  })

  it('validates settings patches and resets a blank baseURL to the default', async () => {
    const bad = await call({ url: '/opendesign/api/settings', method: 'POST', body: { defaultContextWindow: -1 } })
    expect(bad.status).toBe(400)
    const noUrl = await call({ url: '/opendesign/api/settings', method: 'POST', body: { baseURL: 'not-a-url' } })
    expect(noUrl.status).toBe(400)
    const good = await call({ url: '/opendesign/api/settings', method: 'POST', body: { baseURL: '', maxConcurrentRequests: 0 } })
    expect(good.status).toBe(200)
    const settingsDoc = await settings.read()
    expect(settingsDoc.baseURL).toBe('https://amr-link.open-design.ai/v1')
    expect(settingsDoc.maxConcurrentRequests).toBe(0)
  })

  it('keeps the model selection tri-state: unset, empty, explicit', async () => {
    const explicit = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: ['gpt-6-luna'] } })
    expect((explicit.body.value as OpenDesignWebStatus).models.filter((model) => model.enabled).map((model) => model.id)).toEqual(['gpt-6-luna'])
    const none = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: [] } })
    expect((none.body.value as OpenDesignWebStatus).models.every((model) => !model.enabled)).toBe(true)
    const unset = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: null } })
    expect((unset.body.value as OpenDesignWebStatus).models.every((model) => model.enabled)).toBe(true)
  })

  it('drops a forced reveal when the model leaves the selection', async () => {
    // The card's un-tick posts only `enabledModelIds`; "not selected" must therefore
    // also mean "no longer force-shown", or the record would outlive the tick.
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const kept = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: ['gpt-6-luna', 'claude-sonnet-5.5'] } })
    expect((kept.body.value as OpenDesignWebStatus).models.find((model) => model.id === 'claude-sonnet-5.5')!.forcedVisible).toBe(true)

    const dropped = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: ['gpt-6-luna'] } })
    expect((await settings.read()).forceVisibleModels).toEqual([])
    const row = (dropped.body.value as OpenDesignWebStatus).models.find((model) => model.id === 'claude-sonnet-5.5')!
    expect(row.forcedVisible).toBe(false)
    expect(row.enabled).toBe(false)
  })

  it('leaves no forced reveal behind when nothing is selected', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const none = await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: [] } })
    expect((await settings.read()).forceVisibleModels).toEqual([])
    expect((none.body.value as OpenDesignWebStatus).models.every((model) => !model.forcedVisible)).toBe(true)
  })

  it('keeps the forced reveals when the selection is cleared to "all"', async () => {
    // `null` says "no filter", not "keep only these": pruning it would delete a
    // reveal nobody withdrew.
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    await call({ url: '/opendesign/api/models', method: 'POST', body: { enabledModelIds: null } })
    expect((await settings.read()).forceVisibleModels).toEqual(['claude-sonnet-5.5'])
  })

  it('hides and restores a model through the visibility routes', async () => {
    const hidden = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'gpt-6-luna', visible: false } })
    const status = hidden.body.value as OpenDesignWebStatus
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.enabled).toBe(false)
    expect((await settings.read()).hiddenModels).toEqual(['gpt-6-luna'])
    const unknown = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'not-a-model', visible: false } })
    expect(unknown.status).toBe(400)
    const restored = await call({ url: '/opendesign/api/models/visibility-all', method: 'POST', body: { mode: 'all' } })
    expect((restored.body.value as OpenDesignWebStatus).models.every((model) => model.enabled)).toBe(true)
  })

  it('turns a plan-omitted row from unchecked into a forced reveal, and back', async () => {
    // The card marks a `served === false` row "not in this plan, tick to force it",
    // so its tick state IS the force list — hence an omitted row must project as
    // unchecked, and ticking it must actually reach the picker.
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_sync' }, 'main')
    upstreamFetch = (async () => Response.json({ data: [{ id: 'gpt-6-luna' }] })) as unknown as typeof fetch
    const synced = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    let status = (synced.body.value as { status: OpenDesignWebStatus }).status
    let row = status.models.find((model) => model.id === 'claude-sonnet-5.5')!
    expect(row.served).toBe(false)
    expect(row.forcedVisible).toBe(false)
    expect(row.enabled).toBe(false)

    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    expect((await adapter.listModels('opendesign')).map((model) => model.id)).not.toContain('claude-sonnet-5.5')

    const ticked = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'claude-sonnet-5.5', visible: true } })
    status = ticked.body.value as OpenDesignWebStatus
    row = status.models.find((model) => model.id === 'claude-sonnet-5.5')!
    expect(row.forcedVisible).toBe(true)
    expect(row.enabled).toBe(true)
    expect((await adapter.listModels('opendesign')).map((model) => model.id)).toContain('claude-sonnet-5.5')

    const unticked = await call({ url: '/opendesign/api/models/visibility', method: 'POST', body: { model: 'claude-sonnet-5.5', visible: false } })
    status = unticked.body.value as OpenDesignWebStatus
    row = status.models.find((model) => model.id === 'claude-sonnet-5.5')!
    expect(row.forcedVisible).toBe(false)
    expect(row.enabled).toBe(false)
    const after = await settings.read()
    expect(after.forceVisibleModels).toEqual([])
    // Un-forcing is not hiding: the hidden list is the user's veto over a model the
    // plan DOES serve, and this one is not in that business.
    expect(after.hiddenModels).not.toContain('claude-sonnet-5.5')
  })

  it('clears the force list when everything is turned on, and leaves a served row to the old rule', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const status = (await call({ url: '/opendesign/api/status' })).body.value as OpenDesignWebStatus
    // A served model keeps the tick-list rule, untouched by this feature.
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.enabled).toBe(true)
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.enabled).toBe(true)
    const all = await call({ url: '/opendesign/api/models/visibility-all', method: 'POST', body: { mode: 'all' } })
    expect((all.body.value as OpenDesignWebStatus).models.every((model) => !model.forcedVisible)).toBe(true)
    expect((await settings.read()).forceVisibleModels).toEqual([])
  })

  it('clears the force list when everything is turned off, so nothing stays offered', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    const adapter = new OpenDesignAdapter(settings, { fetchFn: (async () => new Response('{}')) as typeof fetch, accountPool: pool })
    expect((await adapter.listModels('opendesign')).map((model) => model.id)).toEqual(['claude-sonnet-5.5', 'gpt-6-luna'])
    const none = await call({ url: '/opendesign/api/models/visibility-all', method: 'POST', body: { mode: 'none' } })
    const status = none.body.value as OpenDesignWebStatus
    expect((await settings.read()).forceVisibleModels).toEqual([])
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.forcedVisible).toBe(false)
    // "Show nothing" means nothing: the forced row must not survive it.
    expect(await adapter.listModels('opendesign')).toEqual([])
  })

  it('keeps the force list on an invert, which is a per-row flip rather than a reset', async () => {
    await settings.update({ servedModelIds: ['gpt-6-luna'], forceVisibleModels: ['claude-sonnet-5.5'] })
    await call({ url: '/opendesign/api/models/visibility-all', method: 'POST', body: { mode: 'invert' } })
    expect((await settings.read()).forceVisibleModels).toEqual(['claude-sonnet-5.5'])
  })

  it('stores and clears a context-window override', async () => {
    const captured = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: 256_000 } })
    const status = captured.body.value as OpenDesignWebStatus
    const model = status.models.find((entry) => entry.id === 'gpt-6-luna')!
    expect(model.contextWindow).toBe(256_000)
    expect(model.contextWindowOverride).toBe(256_000)
    // The published (vendor) window, before this model's override.
    expect(model.defaultContextWindow).toBe(1_050_000)
    const invalid = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: 0 } })
    expect(invalid.status).toBe(400)
    const cleared = await call({ url: '/opendesign/api/models/context-window', method: 'POST', body: { model: 'gpt-6-luna', contextWindow: null } })
    expect((cleared.body.value as OpenDesignWebStatus).models.find((entry) => entry.id === 'gpt-6-luna')!.contextWindowOverride).toBeUndefined()
  })

  it('syncs the live catalog with a pooled key and announces a change once', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_sync' }, 'main')
    upstreamFetch = (async () => Response.json({
      data: [
        { id: 'gpt-6-luna', context_window: 272_000 },
        { id: 'new-model-x', name: 'New Model X' },
      ],
    })) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { added: string[]; status: OpenDesignWebStatus }
    expect(value.added).toEqual(['gpt-6-luna', 'new-model-x'])
    const status = value.status
    expect(status.catalogSynced).toBe(true)
    expect(status.models.map((model) => model.id)).toContain('new-model-x')
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.contextWindow).toBe(272_000)
    // A model the listing omits keeps its shipped vendor facts, not a default.
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.contextWindow).toBe(1_000_000)
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.hint).toContain('reasoning(5)')
    const announces = emit.mock.calls.filter((args) => args[0] === 'llm/adapters-updated')
    expect(announces).toHaveLength(1)

    // A second sync over the same listing changes nothing and stays silent:
    // the picker rebuilds on that event, so a no-change sync must not emit.
    const again = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(again.status).toBe(200)
    expect((again.body.value as { added: string[] }).added).toEqual([])
    expect(emit.mock.calls.filter((args) => args[0] === 'llm/adapters-updated')).toHaveLength(1)
  })

  it('asks every pooled account and remembers the union of what they serve', async () => {
    // A plan belongs to the ACCOUNT: two pooled keys can serve two different model
    // sets, and the picker needs the union — asking only the first key would hide
    // every model the second one serves.
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_one' }, 'one')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_two' }, 'two')
    upstreamFetch = (async (_input: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key === 'Bearer od_one') return Response.json({ data: [{ id: 'gpt-6-luna' }] })
      if (key === 'Bearer od_two') return Response.json({ data: [{ id: 'kimi-k3' }] })
      throw new Error('unexpected key ' + key)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    expect(status.models.find((model) => model.id === 'gpt-6-luna')!.served).toBe(true)
    expect(status.models.find((model) => model.id === 'kimi-k3')!.served).toBe(true)
    // An id neither key listed is measured as NOT served, and says so.
    expect(status.models.find((model) => model.id === 'claude-sonnet-5.5')!.served).toBe(false)
    expect((await settings.read()).servedModelIds?.sort()).toEqual(['gpt-6-luna', 'kimi-k3'])
  })

  it('lets a refused account cost only its own half of the union', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_refused' }, 'refused')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'good')
    upstreamFetch = (async (_input: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('authorization') ?? ''
      if (key === 'Bearer od_refused') return Response.json({ error: { message: 'nope' } }, { status: 401 })
      return Response.json({ data: [{ id: 'kimi-k3' }] })
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    expect(status.models.find((model) => model.id === 'kimi-k3')!.served).toBe(true)
    expect((await settings.read()).servedModelIds).toEqual(['kimi-k3'])
  })

  it('never clears the measurement when every account fails', async () => {
    // A network failure is not a plan that serves nothing: the previous measurement
    // stands, rather than the filter switching itself off behind an error.
    await settings.update({ servedModelIds: ['gpt-6-luna'] })
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_down' }, 'down')
    upstreamFetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(502)
    expect((await settings.read()).servedModelIds).toEqual(['gpt-6-luna'])
  })

  it('refuses a sync honestly when no account can read the catalog', async () => {
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(502)
    expect(String(captured.body.error)).toContain('could not be read')
  })

  it('a failed sync leaves the shipped table standing', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_sync' }, 'main')
    upstreamFetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(502)
    const status = (await call({ url: '/opendesign/api/status' })).body.value as OpenDesignWebStatus
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
  })
})

describe('OpenDesign sign-in and wallet routes', () => {
  it('starts a device-authorization flow and answers the activation URL for the card', async () => {
    loginFetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      expect(body).toEqual({ host: 'test-host', profile: 'prod', cliVersion: 'dsh-chatgpt-subscription' })
      return Response.json({
        deviceId: 'dev-1',
        userCode: 'AB12CD',
        status: 'pending',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        deviceSecret: 'secret-1',
        activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1&userCode=AB12CD',
        pollIntervalSeconds: 2,
      }, { status: 201 })
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const flow = captured.body.value as { id: string; userCode: string; verificationUri: string; status: string }
    expect(flow.status).toBe('pending')
    expect(flow.userCode).toBe('AB12CD')
    expect(flow.verificationUri).toContain('deviceId=dev-1')
    // The host must not leak the device secret into the card's payload.
    expect(captured.raw).not.toContain('secret-1')
  })

  it('completes sign-in through status polls and the card never sees the keys', async () => {
    let polls = 0
    loginFetch = (async () => {
      polls += 1
      if (polls === 1) {
        return Response.json({
          deviceId: 'dev-1', userCode: 'AB12CD', status: 'pending',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          deviceSecret: 'secret-1',
          activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1',
          pollIntervalSeconds: 1,
        }, { status: 201 })
      }
      return Response.json({
        deviceId: 'dev-1', userCode: 'AB12CD', status: 'approved',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        controlKey: 'vela_ctrl_abc', runtimeKey: 'sk-amr-xyz',
        user: { id: 'u-1', email: 'dev@example.com', name: 'Dev', plan: 'pro' },
      })
    }) as unknown as typeof fetch
    const started = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {} })
    const flowId = (started.body.value as { id: string }).id
    vi.useFakeTimers()
    let completed: { status: string; accountAlias: string } | null = null
    try {
      vi.setSystemTime(Date.now() + 1_500)
      const polled = await call({ url: `/opendesign/api/login/status?id=${flowId}` })
      expect(polled.status).toBe(200)
      completed = polled.body.value as { status: string; accountAlias: string }
      expect(completed.status).toBe('complete')
      expect(completed.accountAlias).toBe('Dev')
      // Keys never cross to the card: not in the flow payload, not in status.
      expect(polled.raw).not.toContain('vela_ctrl_abc')
      expect(polled.raw).not.toContain('sk-amr-xyz')
    } finally {
      vi.useRealTimers()
    }
    const status = await call({ url: '/opendesign/api/status' })
    const body = status.body.value as OpenDesignWebStatus
    expect(body.pool.accounts).toHaveLength(1)
    expect(body.pool.accounts[0]!.authKind).toBe('oauth')
    expect(body.pool.accounts[0]!.plan).toBe('pro')
    expect(status.raw).not.toContain('vela_ctrl_abc')
    expect(status.raw).not.toContain('sk-amr-xyz')
  })

  it('rejects a cross-origin login start and a missing status id', async () => {
    const cross = await call({ url: '/opendesign/api/login/start', method: 'POST', body: {}, origin: 'https://evil.example' })
    expect(cross.status).toBe(403)
    const noId = await call({ url: '/opendesign/api/login/status' })
    expect(noId.status).toBe(400)
  })

  it('reads wallet balances for OAuth accounts only, and keeps failures as data', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_ok',
      runtimeKey: 'sk-amr-ok',
      user: { name: 'Dev', email: 'dev@example.com', plan: 'pro' },
    }, 'Dev')
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_pasted' }, 'pasted')
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      expect(auth).toBe('Bearer vela_ctrl_ok')
      if (url.endsWith('/wallet/balance')) {
        return Response.json({ balanceUsd: '12.34', updatedAt: '2026-10-21T05:00:00Z' })
      }
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balanceUsd: '12.3400',
          balances: { subscriptionCredits: '100000', rechargeCredits: '23400', totalAvailableCredits: '123400' },
          membershipTier: 'pro',
          billingInterval: 'monthly',
          subscriptionStatus: 'active',
          subscriptionEntitlementStatus: 'active',
          subscriptionCurrentPeriodStart: '2026-10-01T00:00:00.000Z',
          subscriptionCurrentPeriodEnd: '2026-11-01T00:00:00.000Z',
          subscriptionCreditsUsd: '10.0000',
          rechargeCreditsUsd: '2.3400',
          totalAvailableCreditsUsd: '12.3400',
          totalConsumedUsd: '0.4200',
          todayConsumedUsd: '0.0100',
          usageCount: 42,
          updatedAt: '2026-10-21T05:00:00.000Z',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { usage: { accounts: Array<{ alias: string; ok: boolean; balanceUsd: string | null; billing?: { plan: string; subscriptionCredits: string }; codingPlan?: { tier: string | null; windows: unknown[]; error: string } }> } }
    // The pasted key is skipped, not failed: it has no control key to read with.
    expect(value.usage.accounts).toHaveLength(1)
    expect(value.usage.accounts[0]).toMatchObject({ alias: 'Dev', ok: true, balanceUsd: '12.34' })
    expect(value.usage.accounts[0]!.billing).toMatchObject({ plan: 'pro', subscriptionCredits: '100000' })
    // This fake answers nothing for /workspaces, so the coding-plan half fails
    // on its own field — the wallet and billing readings above stay untouched.
    expect(value.usage.accounts[0]!.codingPlan?.error).not.toBe('')
    expect(value.usage.accounts[0]!.codingPlan?.windows).toEqual([])
    // The status now carries the reading, and still no secret.
    expect(captured.raw).not.toContain('vela_ctrl_ok')
    const status = await call({ url: '/opendesign/api/status' })
    const body = status.body.value as OpenDesignWebStatus
    expect(body.usage?.accounts[0]?.balanceUsd).toBe('12.34')
  })


  it('lets the billing summary name the tier, not the sign-in snapshot', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_plan',
      runtimeKey: 'sk-amr_plan',
      user: { name: 'Dev', plan: 'free' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ balanceUsd: '1.5000' })
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balances: { subscriptionCredits: '10000', rechargeCredits: '5000', totalAvailableCredits: '15000' },
          membershipTier: 'go',
          subscriptionStatus: 'active',
          subscriptionEntitlementStatus: 'active',
          subscriptionCurrentPeriodStart: '2026-10-21T03:33:15.000Z',
          subscriptionCurrentPeriodEnd: '2026-11-21T03:33:15.000Z',
          totalAvailableCreditsUsd: '1.5000',
          totalConsumedUsd: '0.0000',
          todayConsumedUsd: '0.0000',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ billing?: { plan: string; status: string; periodEnd: string | null } }> }
      status: OpenDesignWebStatus
    }
    expect(value.usage.accounts[0]!.billing).toMatchObject({
      plan: 'go',
      status: 'active',
      periodEnd: '2026-11-21T03:33:15.000Z',
    })
    // The stale sign-in snapshot said "free"; one summary read corrects the
    // account everywhere the pool is projected.
    expect(value.status.pool.accounts[0]!.plan).toBe('go')
  })

  it('keeps the credits available when the wallet read is refused', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_fallback',
      runtimeKey: 'sk-amr_fallback',
      user: { name: 'Dev' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ error: 'billing unavailable' }, { status: 403 })
      if (url.endsWith('/billing/summary')) {
        return Response.json({
          balances: { totalAvailableCredits: '15000' },
          membershipTier: 'go',
          subscriptionStatus: 'active',
          totalAvailableCreditsUsd: '1.5000',
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ ok: boolean; balanceUsd: string | null; error: string; billing?: { plan: string } }> }
    }
    // One surface refusing is not the reading failing: the summary's total is
    // the balance, and the wallet's refusal stays attached as diagnostics.
    expect(value.usage.accounts[0]).toMatchObject({ ok: true, balanceUsd: '1.5000' })
    expect(value.usage.accounts[0]!.billing).toMatchObject({ plan: 'go' })
    expect(value.usage.accounts[0]!.error).toContain('HTTP 403')
  })

  it('reads the Design Plan windows, resolving the workspace id once per request', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_plan_a',
      runtimeKey: 'sk-amr_plan_a',
      user: { name: 'A', email: 'a@example.com' },
    }, 'A')
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_plan_b',
      runtimeKey: 'sk-amr_plan_b',
      user: { name: 'B', email: 'b@example.com' },
    }, 'B')
    let currentCalls = 0
    let listCalls = 0
    let planCalls = 0
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ balanceUsd: '1.5000' })
      if (url.endsWith('/billing/summary')) {
        return Response.json({ membershipTier: 'go', balances: { totalAvailableCredits: '15000' }, totalAvailableCreditsUsd: '1.5000' })
      }
      // The console's own current-workspace read: this is the id source.
      if (url.endsWith('/api/v1/workspaces/current')) {
        currentCalls += 1
        return Response.json({ activeWorkspaceId: 'ws_dev', workspaceType: 'personal', role: 'owner' })
      }
      if (url.endsWith('/api/v1/workspaces')) {
        listCalls += 1
        return Response.json({ workspaces: [{ id: 'ws_dev' }] })
      }
      if (url.endsWith('/workspaces/ws_dev/billing/coding-plan-usage')) {
        planCalls += 1
        return Response.json({
          tier: 'go',
          eligible: true,
          windows: [
            { policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '900', limitCredits: '1000', resetsAt: '2026-10-21T08:00:00.000Z' },
            { policyId: 'seven_day', durationSeconds: 604800, remainingCredits: '8100', limitCredits: '10000', resetsAt: '2026-10-27T00:00:00.000Z' },
          ],
        })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch

    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ alias: string; codingPlan?: { tier: string | null; windows: Array<{ policyId: string }>; error: string } }> }
    }
    expect(value.usage.accounts).toHaveLength(2)
    for (const account of value.usage.accounts) {
      expect(account.codingPlan?.error).toBe('')
      expect(account.codingPlan?.tier).toBe('go')
      expect(account.codingPlan?.windows.map((window) => window.policyId)).toEqual(['five_hour', 'seven_day'])
    }
    // One lookup for the whole request, one plan read per account: the id is an
    // address every account shares, and asking for it once is the point.
    expect(currentCalls).toBe(1)
    expect(listCalls).toBe(0)
    expect(planCalls).toBe(2)
    expect(captured.raw).not.toContain('vela_ctrl_plan_a')

    // The card reads the same object through /status.
    const answered = await call({ url: '/opendesign/api/status' })
    const statusBody = answered.body.value as OpenDesignWebStatus
    expect(statusBody.usage?.accounts[0]?.codingPlan?.windows).toHaveLength(2)
  })

  it('keeps the wallet when the coding-plan read is refused', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_noplan',
      runtimeKey: 'sk-amr_noplan',
      user: { name: 'Dev' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ balanceUsd: '1.5000' })
      if (url.endsWith('/billing/summary')) return Response.json({ membershipTier: 'go', totalAvailableCreditsUsd: '1.5000' })
      if (url.endsWith('/api/v1/workspaces/current')) return Response.json({ activeWorkspaceId: 'ws_dev', role: 'owner' })
      if (url.endsWith('/billing/coding-plan-usage')) {
        return Response.json({ code: 'coding_plan_configuration_unavailable' }, { status: 404 })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch

    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const value = captured.body.value as {
      usage: { accounts: Array<{ ok: boolean; balanceUsd: string | null; codingPlan?: { tier: string | null; windows: unknown[]; error: string } }> }
    }
    // The plan's refusal is a sentence on its own field; the reading stands.
    expect(value.usage.accounts[0]).toMatchObject({ ok: true, balanceUsd: '1.5000' })
    expect(value.usage.accounts[0]!.codingPlan?.tier).toBe(null)
    expect(value.usage.accounts[0]!.codingPlan?.windows).toEqual([])
    expect(value.usage.accounts[0]!.codingPlan?.error).toContain('coding_plan_configuration_unavailable')
  })

  it('keeps the wallet when no workspace id can be resolved', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_nows',
      runtimeKey: 'sk-amr_nows',
      user: { name: 'Dev' },
    }, 'Dev')
    upstreamFetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/wallet/balance')) return Response.json({ balanceUsd: '2.0000' })
      if (url.endsWith('/billing/summary')) return Response.json({ membershipTier: 'go', totalAvailableCreditsUsd: '2.0000' })
      // The current read answers 200 but states no id; the listing is refused.
      if (url.endsWith('/api/v1/workspaces/current')) return Response.json({ workspaceType: 'personal', role: 'owner' })
      if (url.endsWith('/api/v1/workspaces')) return Response.json({ error: 'unauthenticated' }, { status: 401 })
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch

    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    const value = captured.body.value as {
      usage: { accounts: Array<{ ok: boolean; balanceUsd: string | null; codingPlan?: { windows: unknown[]; error: string } }> }
    }
    // The degradation path this whole change is built around: no address, no
    // windows, and the reason carried as data.
    expect(value.usage.accounts[0]).toMatchObject({ ok: true, balanceUsd: '2.0000' })
    expect(value.usage.accounts[0]!.codingPlan?.windows).toEqual([])
    expect(value.usage.accounts[0]!.codingPlan?.error).toContain('HTTP 401')
    // The diagnosis names BOTH reads, so the next live attempt is not blind.
    expect(value.usage.accounts[0]!.codingPlan?.error).toContain('GET /workspaces/current HTTP 200')
  })

  it('refuses the usage read plainly when no OAuth account exists', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_x' }, 'pasted')
    const captured = await call({ url: '/opendesign/api/usage', method: 'POST', body: {} })
    expect(captured.status).toBe(400)
    expect(String(captured.body.error)).toContain('control key')
  })
})

describe('OpenDesign catalog metadata', () => {
  it('reads the AMR control-plane catalog with the control key and normalizes public ids', async () => {
    await pool.addAccount({
      kind: 'oauth',
      controlKey: 'vela_ctrl_meta',
      runtimeKey: 'sk-amr_chat',
      user: { name: 'Dev' },
    }, 'Dev')
    const seen: string[] = []
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      seen.push(url)
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      if (url.endsWith('/api/v1/models')) {
        // The control-plane spelling: public_model_* ids + metadata.contextWindowTokens.
        expect(auth).toBe('Bearer vela_ctrl_meta')
        return Response.json({
          source: 'remote',
          data: [
            { id: 'public_model_deepseek_v4_1_flash', metadata: { contextWindowTokens: 1_000_000 } },
            { id: 'public_model_claude_haiku_5_5', metadata: { contextWindowTokens: 1_500_000 } },
          ],
        })
      }
      if (url.endsWith('/v1/models')) {
        // The link gateway answers the runtime key with the plan's ids only.
        expect(auth).toBe('Bearer sk-amr_chat')
        return Response.json({ data: [{ id: 'deepseek-v4.1-flash' }] })
      }
      throw new Error('unexpected upstream: ' + url)
    }) as unknown as typeof fetch

    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    const deepseek = status.models.find((model) => model.id === 'deepseek-v4.1-flash')!
    // The control-plane window (1M) and the shipped ladder both apply.
    expect(deepseek.contextWindow).toBe(1_000_000)
    expect(deepseek.hint).toContain('reasoning(4)')
    // An id the table does not know is still adopted, normalized onto itself.
    const haiku = status.models.find((model) => model.id === 'claude-haiku-5.5')!
    expect(haiku.contextWindow).toBe(1_500_000)
    expect(seen.some((url) => url.endsWith('/v1/models'))).toBe(true)
  })

  it('a refused control-plane read still lets the gateway listing sync', async () => {
    await pool.addAccount({ kind: 'oauth', controlKey: 'vela_ctrl_refused', runtimeKey: 'sk-amr_r', user: { name: 'D' } }, 'D')
    upstreamFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/models')) return Response.json({ error: 'unauthenticated' }, { status: 401 })
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'kimi-k3', context_window: 2_000_000 }] })
      throw new Error('unexpected ' + url)
    }) as unknown as typeof fetch
    const captured = await call({ url: '/opendesign/api/catalog/refresh', method: 'POST', body: {} })
    expect(captured.status).toBe(200)
    const status = (captured.body.value as { status: OpenDesignWebStatus }).status
    expect(status.models.find((model) => model.id === 'kimi-k3')!.contextWindow).toBe(2_000_000)
  })
})

/**
 * The workspace id, on its own.
 *
 * It is an ADDRESS, not a credential: the coding-plan endpoint takes it in the
 * path and repeats it in a header, so the lookup's only jobs are "find the id a
 * control key can see" and "say why not, without throwing".
 */
describe('OpenDesign workspace lookup', () => {
  it('reads the active workspace first, and does not list when it answered', async () => {
    const urls: string[] = []
    const fetchFn = (async (input: unknown) => {
      urls.push(String(input))
      // The console's own "current workspace" object.
      return Response.json({ activeWorkspaceId: 'ws_live', workspaceType: 'personal', role: 'owner' })
    }) as unknown as typeof fetch
    await expect(fetchWorkspaceId({ fetchFn, controlKey: 'vela_ctrl_w' })).resolves.toEqual({
      ok: true,
      id: 'ws_live',
      error: '',
    })
    // One read, at the endpoint the console uses; the listing is never touched.
    expect(urls).toEqual(['https://amr-api.open-design.ai/api/v1/workspaces/current'])
  })

  it('accepts the id nested under workspace, and under a data wrapper', async () => {
    const nested = (async () => Response.json({ workspace: { id: 'ws_nested' }, role: 'owner' })) as unknown as typeof fetch
    await expect(fetchWorkspaceId({ fetchFn: nested, controlKey: 'k' })).resolves.toEqual({
      ok: true,
      id: 'ws_nested',
      error: '',
    })
    const wrapped = (async () => Response.json({ data: { activeWorkspaceId: 'ws_data' } })) as unknown as typeof fetch
    await expect(fetchWorkspaceId({ fetchFn: wrapped, controlKey: 'k' })).resolves.toEqual({
      ok: true,
      id: 'ws_data',
      error: '',
    })
  })

  it('falls back to the listing when the current read states no id', async () => {
    const urls: string[] = []
    const fetchFn = (async (input: unknown) => {
      const url = String(input)
      urls.push(url.replace('https://amr-api.open-design.ai/api/v1', ''))
      if (url.endsWith('/workspaces/current')) return Response.json({ workspaceType: 'personal', role: 'owner' })
      // An `items` wrapper: the listing is not consistent about its envelope, so
      // every shape it has been seen in has to be accepted.
      return Response.json({ items: [{ name: 'A' }, { id: 'ws_listed' }] })
    }) as unknown as typeof fetch
    await expect(fetchWorkspaceId({ fetchFn, controlKey: 'k' })).resolves.toEqual({
      ok: true,
      id: 'ws_listed',
      error: '',
    })
    expect(urls).toEqual(['/workspaces/current', '/workspaces'])
  })

  it('names both endpoints and their shapes when neither states an id', async () => {
    const fetchFn = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/workspaces/current')) {
        return Response.json({ role: 'owner', workspaceType: 'personal', activeWorkspace: 'x' })
      }
      return Response.json({ items: [] })
    }) as unknown as typeof fetch
    const failed = await fetchWorkspaceId({ fetchFn, controlKey: 'k' })
    expect(failed.ok).toBe(false)
    expect(failed.id).toBe(null)
    // Which endpoint, which status, and what the body actually looked like: the
    // only thing that makes the next live attempt debuggable.
    expect(failed.error).toContain('GET /workspaces/current HTTP 200')
    expect(failed.error).toContain('keys: activeWorkspace, role, workspaceType')
    expect(failed.error).toContain('GET /workspaces HTTP 200')
    expect(failed.error).toContain('the workspaces endpoint listed no workspace id')
    // Keys only: no value from the body ever reaches the message.
    expect(failed.error).not.toContain('owner')
  })

  it('reports a refusal as data instead of throwing', async () => {
    const fetchFn = (async () => Response.json({ code: 'unauthenticated' }, { status: 401 })) as unknown as typeof fetch
    const failed = await fetchWorkspaceId({ fetchFn, controlKey: 'k' })
    expect(failed.ok).toBe(false)
    expect(failed.id).toBe(null)
    // Both reads were refused, and both refusals are in the one sentence.
    expect(failed.error).toContain('GET /workspaces/current HTTP 401: unauthenticated')
    expect(failed.error).toContain('GET /workspaces HTTP 401: unauthenticated')
    // A transport failure is the same kind of answer, and does not stop the
    // fallback from being attempted.
    const broken = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    const error = await fetchWorkspaceId({ fetchFn: broken, controlKey: 'k' })
    expect(error.ok).toBe(false)
    expect(error.error).toContain('GET /workspaces/current failed: connect ECONNREFUSED')
  })
})

/**
 * The Design Plan's real allowance, on its own.
 *
 * The endpoint is the one the console draws "剩余 90 % / 81 %" from, and whether a
 * control-key Bearer is accepted there is UNVERIFIED — so every assertion below is
 * about either a field that survived validation or the refusal that did not.
 */
describe('OpenDesign Design Plan usage', () => {
  it('reads both windows and sends the headers the console sends', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return Response.json({
        tier: 'go',
        eligible: true,
        windows: [
          { policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '900', limitCredits: '1000', resetsAt: '2026-10-21T08:00:00.000Z' },
          { policyId: 'seven_day', durationSeconds: 604800, remainingCredits: '8100', limitCredits: '10000', resetsAt: '2026-10-27T00:00:00.000Z' },
        ],
      })
    }) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({
      fetchFn,
      controlKey: 'vela_ctrl_plan',
      runtimeKey: 'sk-amr_plan',
      workspaceId: 'ws_1',
    })
    expect(plan.error).toBe('')
    // The first shape answered, so the runtime key was never tried.
    expect(seen).toHaveLength(1)
    expect(plan.tier).toBe('go')
    expect(plan.windows).toEqual([
      { policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '900', limitCredits: '1000', resetsAt: '2026-10-21T08:00:00.000Z' },
      { policyId: 'seven_day', durationSeconds: 604800, remainingCredits: '8100', limitCredits: '10000', resetsAt: '2026-10-27T00:00:00.000Z' },
    ])
    expect(seen[0]!.url).toBe('https://amr-api.open-design.ai/api/v1/workspaces/ws_1/billing/coding-plan-usage')
    const headers = new Headers(seen[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer vela_ctrl_plan')
    expect(headers.get('accept')).toBe('application/json')
    // The workspace is addressed twice on purpose: in the path AND in this
    // header, exactly as the console sends it.
    expect(headers.get('x-vela-workspace-id')).toBe('ws_1')
  })

  it('drops a window whose fields do not state a bounded amount', async () => {
    const fetchFn = (async () => Response.json({
      tier: 'platinum',
      windows: [
        { policyId: '', durationSeconds: 18000, remainingCredits: '1', limitCredits: '2' },
        { policyId: 'no-length', durationSeconds: 0, remainingCredits: '1', limitCredits: '2' },
        { policyId: 'float', durationSeconds: 18000, remainingCredits: '1.5', limitCredits: '2' },
        { policyId: 'zero-limit', durationSeconds: 18000, remainingCredits: '1', limitCredits: '0' },
        { policyId: 'bad-reset', durationSeconds: 18000, remainingCredits: '1', limitCredits: '2', resetsAt: 'soon' },
        'not a window',
        { policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '1', limitCredits: '2', resetsAt: null },
      ],
    })) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({ fetchFn, controlKey: 'k', runtimeKey: 'sk-amr_k', workspaceId: 'w' })
    // Every unreadable shape is DROPPED, never patched with a plausible number.
    expect(plan.windows).toEqual([
      { policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '1', limitCredits: '2', resetsAt: null },
    ])
    // "platinum" is not one of the four tiers this line names.
    expect(plan.tier).toBe(null)
    expect(plan.error).toBe('')
  })

  it('keeps the coding-plan refusal code as data', async () => {
    const fetchFn = (async () => Response.json(
      { code: 'coding_plan_configuration_unavailable', message: 'no plan configured' },
      { status: 404 },
    )) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({ fetchFn, controlKey: 'k', runtimeKey: 'sk-amr_k', workspaceId: 'w' })
    // The code goes out verbatim: it is the one thing a user can act on.
    expect(plan).toEqual({ tier: null, windows: [], error: 'HTTP 404: coding_plan_configuration_unavailable' })
    const broken = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const failed = await fetchCodingPlanUsage({ fetchFn: broken, controlKey: 'k', runtimeKey: 'sk-amr_k', workspaceId: 'w' })
    expect(failed).toEqual({ tier: null, windows: [], error: 'socket hang up' })
  })

  it('tries the runtime key when the control key is refused', async () => {
    const seen: Array<{ auth: string; apiKeyHeader: string }> = []
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ auth: headers.get('authorization') ?? '', apiKeyHeader: headers.get('x-api-key') ?? '' })
      // Exactly the live result this rework answers: the control key is refused.
      if (seen.length === 1) return Response.json({ code: 'unauthenticated' }, { status: 401 })
      return Response.json({
        tier: 'go',
        windows: [{ policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '900', limitCredits: '1000', resetsAt: null }],
      })
    }) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({
      fetchFn,
      controlKey: 'vela_ctrl_x',
      runtimeKey: 'sk-amr_x',
      workspaceId: 'ws_1',
    })
    // Success carries no trace of WHICH credential worked.
    expect(plan).toEqual({
      tier: 'go',
      windows: [{ policyId: 'five_hour', durationSeconds: 18000, remainingCredits: '900', limitCredits: '1000', resetsAt: null }],
      error: '',
    })
    // One extra request, with the runtime key as the Bearer.
    expect(seen).toHaveLength(2)
    expect(seen[1]!.auth).toBe('Bearer sk-amr_x')
    expect(seen[1]!.apiKeyHeader).toBe('')
  })

  it('records every shape it tried when all of them are refused', async () => {
    const seen: Array<{ auth: string; apiKeyHeader: string }> = []
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ auth: headers.get('authorization') ?? '', apiKeyHeader: headers.get('x-api-key') ?? '' })
      return Response.json({ code: 'unauthenticated' }, { status: 401 })
    }) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({
      fetchFn,
      controlKey: 'vela_ctrl_x',
      runtimeKey: 'sk-amr_x',
      workspaceId: 'ws_1',
    })
    // One sentence: the last refusal plus the shapes that produced it. Key
    // MATERIAL never appears — only the shape names.
    expect(plan.error).toBe('HTTP 401: unauthenticated (tried: bearer control key; bearer runtime key; x-api-key runtime key)')
    expect(plan.error).not.toContain('vela_ctrl_x')
    expect(plan.error).not.toContain('sk-amr_x')
    expect(plan.windows).toEqual([])
    expect(plan.tier).toBe(null)
    expect(seen).toHaveLength(3)
    // The third shape sends NO Authorization at all, only x-api-key.
    expect(seen[2]!.auth).toBe('')
    expect(seen[2]!.apiKeyHeader).toBe('sk-amr_x')
  })

  it('stops at a status a different credential cannot fix', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return Response.json({ code: 'coding_plan_configuration_unavailable' }, { status: 404 })
    }) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({
      fetchFn,
      controlKey: 'vela_ctrl_x',
      runtimeKey: 'sk-amr_x',
      workspaceId: 'ws_1',
    })
    // 404 means 'no such endpoint / no plan configured', not 'wrong key': one
    // request, no retry, and no tried-list attached.
    expect(calls).toBe(1)
    expect(plan.error).toBe('HTTP 404: coding_plan_configuration_unavailable')
  })

  it('tries only the control key when the account has no runtime key', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      return Response.json({ code: 'unauthenticated' }, { status: 401 })
    }) as unknown as typeof fetch
    const plan = await fetchCodingPlanUsage({ fetchFn, controlKey: 'vela_ctrl_only', runtimeKey: '', workspaceId: 'ws_1' })
    expect(calls).toBe(1)
    expect(plan.error).toBe('HTTP 401: unauthenticated (tried: bearer control key)')
  })
})
