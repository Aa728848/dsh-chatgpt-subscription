import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  clearCachedCatalog,
  clearCachedQuota,
  getCachedQuota,
  verifyApiKey,
} from '../src/host/zhipu/client.ts'
import {
  buildModelOptions,
  getZhipuWebStatus,
  registerZhipuRoutes,
  resolveEnabledModelIds,
} from '../src/host/zhipu/routes.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  parseZhipuCredentials,
  zhipuAccountKey,
  type ZhipuCredentials,
} from '../src/host/zhipu/token-store.ts'
import { parseZhipuPoolData } from '../src/host/zhipu/account-pool.ts'
import { ZHIPU_MODELS } from '../src/host/zhipu/model-catalog.ts'
import { PROVIDER_ID } from '../src/host/zhipu/types.ts'
import {
  createZhipuCredentialStore,
  createZhipuPool,
  makeZhipuFetch,
  sampleCredentials,
  zhipuSettingsFile,
} from './support/zhipu-fixtures.ts'

interface FakeResponse {
  status: number
  body: unknown
}

function fakeExchange(): { response: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { status: 0, body: undefined }
  const response = {
    writeHead(status: number) { captured.status = status },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
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

/** The model listing the live surface answers with. */
const CATALOG = {
  data: [
    { id: 'glm-5.3', context_window: 1_000_000 },
    { id: 'glm-5.3-flash', context_window: 1_000_000 },
  ],
}

const QUOTA = {
  code: 0,
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 40.5, currentValue: 12_500_000, usage: 40_000_000, nextResetTime: 1_800_000_000_000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52, currentValue: 31_000_000, usage: 60_000_000 },
      { type: 'TIME_LIMIT', percentage: 12.3, currentValue: 123, usage: 1_000 },
    ],
  },
}

const PLAN = { code: 0, success: true, data: { planName: 'GLM Coding Pro', planLevel: 'pro' } }

function upstream(url: string): Response {
  if (url.includes('/models')) return Response.json(CATALOG)
  if (url.includes('/quota/limit')) return Response.json(QUOTA)
  if (url.includes('/subscription/list')) return Response.json(PLAN)
  throw new Error(`Unexpected request: ${url}`)
}

/**
 * A `fetch` double the routes read *at call time*.
 *
 * `registerZhipuRoutes` captures `globalThis.fetch` once, when it is called —
 * so a test that swaps the global afterwards would not be observed. This
 * indirection keeps one registered handler and lets each test change the
 * responder behind it.
 */
let responder: (url: string) => Response = upstream

function installResponder(next: (url: string) => Response): void {
  responder = next
}

describe('zhipu settings routes', () => {
  let store: FileCredentialStore
  let modelSettings: FileModelSettingsStore
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let originalFetch: typeof fetch

  beforeEach(async () => {
    clearCachedCatalog()
    clearCachedQuota()
    responder = upstream
    store = await createZhipuCredentialStore()
    modelSettings = new FileModelSettingsStore(await zhipuSettingsFile())
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
    globalThis.fetch = makeZhipuFetch((url) => responder(url))
    registerZhipuRoutes(ctx, store, modelSettings)
    handler = routes[0]!.handler
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCachedCatalog()
    clearCachedQuota()
    vi.restoreAllMocks()
  })

  it('reports a signed-out status with the shipped models and no credential', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/status' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect(value.authenticated).toBe(false)
    expect(value.hasCredentials).toBe(false)
    expect(value.serving).toBe(true)
    expect((value.models as unknown[]).length).toBe(ZHIPU_MODELS.length)
    expect(value.storagePath).toBe(store.path())
  })

  it('answers an aged quota snapshot without waiting for the refresh', async () => {
    // A registration whose store already holds a key, so the status route takes
    // the quota path at all.
    const credentialed = await createZhipuCredentialStore({ credentials: sampleCredentials() })
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    registerZhipuRoutes({
      webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } },
    } as unknown as Context, credentialed, modelSettings)
    const status = routes[0]!.handler

    // First read has no snapshot, so it fetches and owes no follow-up.
    const first = fakeExchange()
    await status(fakeRequest({ url: '/zhipu/api/status' }), first.response)
    const firstValue = (first.captured.body as { value: Record<string, unknown> }).value
    expect(firstValue.quotaRefreshing).toBe(false)
    expect(typeof firstValue.lastFetchedAt).toBe('number')

    // Age the snapshot past its TTL and make the upstream request hang. An answer
    // that arrives at all therefore came from the snapshot: a route that waited
    // for the refresh would never respond. The response must also say a refresh
    // is running, which is what makes the client ask again.
    const cached = getCachedQuota()
    expect(cached).toBeDefined()
    cached!.fetchedAt = Date.now() - 10 * 60 * 1000
    installResponder((() => new Promise<Response>(() => {})) as unknown as (url: string) => Response)

    const second = fakeExchange()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const answered = await Promise.race([
      status(fakeRequest({ url: '/zhipu/api/status' }), second.response).then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000) }),
    ])
    clearTimeout(timeout)
    expect(answered).toBe(true)
    const secondValue = (second.captured.body as { value: Record<string, unknown> }).value
    expect(secondValue.quotaRefreshing).toBe(true)
    // The answer carried the aged snapshot, not a refreshed one.
    expect(secondValue.lastFetchedAt).toBe(cached!.fetchedAt)
  })

  it('verifies a pasted key before persisting it, and rejects a key the host refuses', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({
      url: '/zhipu/api/accounts/add',
      method: 'POST',
      body: { apiKey: 'key-abc-1234', region: 'intl' },
    }), response)
    expect(captured.status).toBe(200)
    const body = captured.body as { ok: boolean; value: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.value.authenticated).toBe(true)
    expect((await store.read())?.apiKey).toBe('key-abc-1234')
    // The key reaches no part of the response.
    expect(JSON.stringify(body.value)).not.toContain('key-abc-1234')
    expect(JSON.stringify(body.value)).toContain('••••1234')

    // A refused key must not be written.
    const refused = await createZhipuCredentialStore()
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    registerZhipuRoutes({
      webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } },
    } as unknown as Context, refused, modelSettings)
    installResponder(() => Response.json({ code: 401, msg: 'token expired or incorrect', success: false }))
    const exchange = fakeExchange()
    await routes[0]!.handler(fakeRequest({
      url: '/zhipu/api/accounts/add',
      method: 'POST',
      body: { apiKey: 'wrong-console-key', region: 'cn' },
    }), exchange.response)
    const rejected = exchange.captured.body as { ok: boolean; error: string }
    expect(exchange.captured.status).toBe(200)
    expect(rejected.ok).toBe(false)
    // The message names the console the key most likely came from.
    expect(rejected.error).toContain('open.bigmodel.cn')
    expect(await refused.read()).toBeNull()
  })

  it('refuses a cross-origin mutation', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({
      url: '/zhipu/api/accounts/add',
      method: 'POST',
      headers: { origin: 'http://evil.test' },
      body: { apiKey: 'k' },
    }), response)
    expect(captured.status).toBe(403)
  })

  it('reads the plan windows and meters for a signed-in account', async () => {
    await store.write(parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }))
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/quota', method: 'POST' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect(value.quotaError).toBeNull()
    const quota = value.quota as { planName: string; planLevel: string; windows: Array<{ label: string; remainingFraction: number }>; meters: unknown[] }
    expect(quota.planName).toBe('GLM Coding Pro')
    expect(quota.planLevel).toBe('pro')
    expect(quota.windows.map((window) => window.label)).toEqual(['5 小时额度', '每周额度'])
    expect(quota.windows[0]!.remainingFraction).toBeCloseTo(0.595, 5)
    // Two credit windows plus the tool allowance.
    expect(quota.meters).toHaveLength(3)
    expect(getCachedQuota()?.windows).toHaveLength(2)
  })

  it('reports a quota failure alongside the status instead of failing the read', async () => {
    await store.write(parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }))
    installResponder(() => new Response('', { status: 503 }))
    const { response, captured } = fakeExchange()
    // A status read refreshes a stale cache and must still answer.
    await handler(fakeRequest({ url: '/zhipu/api/status' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect(value.authenticated).toBe(true)
    expect(String(value.quotaError)).toContain('quota lookup failed')
  })

  it('persists a model selection, a context override, and a restore', async () => {
    await store.write(parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }))

    let exchange = fakeExchange()
    await handler(fakeRequest({
      url: '/zhipu/api/settings',
      method: 'POST',
      body: { enabledModelIds: ['glm-5.3'], defaultReasoningEffort: 'max', contextWindowOverrides: { 'glm-5.3': 500_000 } },
    }), exchange.response)
    expect(exchange.captured.status).toBe(200)
    let settings = await modelSettings.read()
    expect(settings.enabledModelIds).toEqual(['glm-5.3'])
    expect(settings.defaultReasoningEffort).toBe('max')
    expect(settings.contextWindowOverrides).toEqual({ 'glm-5.3': 500_000 })
    let option = (exchange.captured.body as { value: { models: Array<{ id: string; contextWindow: number; defaultContextWindow: number; enabled: boolean }> } })
      .value.models.find((model) => model.id === 'glm-5.3')!
    expect(option.contextWindow).toBe(500_000)
    expect(option.enabled).toBe(true)

    // `null` restores the declared window.
    exchange = fakeExchange()
    await handler(fakeRequest({
      url: '/zhipu/api/settings',
      method: 'POST',
      body: { contextWindowOverrides: { 'glm-5.3': null } },
    }), exchange.response)
    settings = await modelSettings.read()
    expect(settings.contextWindowOverrides).toEqual({})
    option = (exchange.captured.body as { value: { models: Array<{ id: string; contextWindow: number; defaultContextWindow: number; enabled: boolean }> } })
      .value.models.find((model) => model.id === 'glm-5.3')!
    expect(option.contextWindow).toBe(option.defaultContextWindow)

    // An effort outside the provider's three levels is not persisted.
    await handler(fakeRequest({
      url: '/zhipu/api/settings',
      method: 'POST',
      body: { defaultReasoningEffort: 'medium' },
    }), fakeExchange().response)
    expect((await modelSettings.read()).defaultReasoningEffort).toBe('max')
  })

  it('answers a connection probe against the chat surface, not the listing', async () => {
    await store.write(parseZhipuCredentials({ apiKey: 'key-abc-1234', region: 'intl' }))
    const calls: string[] = []
    installResponder((url) => {
      calls.push(url)
      if (url.includes('/models')) return Response.json(CATALOG)
      if (url.includes('/chat/completions')) return new Response('data: [DONE]\n\n')
      return Response.json(QUOTA)
    })
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/connection/test', method: 'POST' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: { connected: boolean; model: string } }).value
    expect(value.connected).toBe(true)
    // A key can list models and still be unable to chat, so the probe must
    // exercise the chat route.
    expect(calls.some((url) => url.endsWith('/api/coding/paas/v4/chat/completions'))).toBe(true)
  })

  it('opens the route it owns and reports an unknown path', async () => {
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/zhipu/api/nope' }), response)
    expect(captured.status).toBe(404)
  })
})

describe('zhipu route helpers', () => {
  it('treats an untouched shipped default as "everything the catalog offers"', () => {
    const all = ZHIPU_MODELS.map((model) => model.id)
    expect(resolveEnabledModelIds(all, all)).toEqual(all)
    expect(resolveEnabledModelIds([], all)).toEqual([])
    expect(resolveEnabledModelIds(['glm-5.3', 'gone'], all)).toEqual(['glm-5.3'])
    expect(resolveEnabledModelIds(['glm-5.3'], all, false)).toEqual([])
  })

  it('renders one option per catalog entry with its declared capabilities', () => {
    const options = buildModelOptions(ZHIPU_MODELS, ['glm-5.3', 'glm-5.3-flash'], ['glm-5.3'], { 'glm-5.3': 250_000 })
    const flagship = options.find((option) => option.id === 'glm-5.3')!
    expect(flagship).toMatchObject({
      enabled: true,
      defaultContextWindow: 1_000_000,
      contextWindow: 250_000,
      defaultMaxTokens: 131_072,
      supportsImage: false,
    })
    expect(flagship.reasoningEfforts).toEqual(['low', 'high', 'max'])
    // The flash model takes images; the flagship does not.
    expect(options.find((option) => option.id === 'glm-5.3-flash')!.supportsImage).toBe(true)
    expect(options.find((option) => option.id === 'glm-5.3-flash')!.enabled).toBe(false)
  })
})

describe('zhipu account pool', () => {
  it('validates a pool document and drops entries with no usable key', () => {
    const parsed = parseZhipuPoolData({
      version: 1,
      rotationStrategy: 'round-robin',
      activeAccountId: 'a',
      accounts: [
        { id: 'a', alias: '国际区', credentials: { apiKey: 'k-1', region: 'intl' }, isPrimary: true, addedAt: 1 },
        { id: 'b', credentials: { apiKey: '', region: 'cn' } },
        { credentials: { apiKey: 'k-3', region: 'cn' } },
      ],
    })
    expect(parsed.rotationStrategy).toBe('round-robin')
    expect(parsed.accounts.map((account) => account.id)).toEqual(['a'])
    expect(parsed.accounts[0]!.region).toBe('intl')
    // The hint is derived, never stored as the secret itself.
    expect(parsed.accounts[0]!.keyHint).toBe('••••')
  })

  it('keys accounts by the key digest and mirrors the primary into the credential store', async () => {
    const store = await createZhipuCredentialStore()
    const pool = createZhipuPool({ store })
    const credentials = parseZhipuCredentials({ apiKey: 'key-alpha-9999', region: 'intl' })
    const added = await pool.addAccount(credentials)
    expect(added.id).toBe(zhipuAccountKey(credentials))
    // The alias names the deployment and the key suffix without exposing the key.
    expect(added.alias).toContain('国际区')
    expect(added.alias).toContain('9999')
    expect(added.alias).not.toContain('key-alpha')

    const summaries = await pool.listAccounts()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.region).toBe('intl')
    expect(JSON.stringify(summaries)).not.toContain('key-alpha-9999')

    // The primary is mirrored, so the picker and the single-credential path
    // read the same account.
    expect((await store.read())?.apiKey).toBe('key-alpha-9999')
    await pool.deleteAccount(added.id)
    expect(await store.read()).toBeNull()
  })

  it('deduplicates the same key and keeps two keys of one console apart', async () => {
    const store = await createZhipuCredentialStore()
    const pool = createZhipuPool({ store })
    const first = parseZhipuCredentials({ apiKey: 'key-alpha-9999', region: 'intl' })
    await pool.addAccount(first)
    await pool.addAccount(first)
    expect(await pool.listAccounts()).toHaveLength(1)

    await pool.addAccount(parseZhipuCredentials({ apiKey: 'key-beta-8888', region: 'intl' }))
    expect(await pool.listAccounts()).toHaveLength(2)
    // The same key text on the other deployment is a different account: only one
    // console can have issued it.
    await pool.addAccount(parseZhipuCredentials({ apiKey: 'key-alpha-9999', region: 'cn' }))
    expect(await pool.listAccounts()).toHaveLength(3)
  })

  it('cools a rate-limited account down and reports it as unavailable', async () => {
    const store = await createZhipuCredentialStore()
    const pool = createZhipuPool({ store })
    const account = await pool.addAccount(parseZhipuCredentials({ apiKey: 'key-alpha-9999', region: 'intl' }))
    await pool.markCooldown(account.id, 60_000, 'test')
    const summaries = await pool.listAccounts()
    expect(summaries[0]!.cooldownUntil).toBeGreaterThan(Date.now())
    // With the only account cooling down, the pool refuses rather than serving.
    await expect(pool.getEffectiveAccount()).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    await pool.clearCooldown(account.id)
    await expect(pool.getEffectiveAccount()).resolves.toMatchObject({ account: { id: account.id } })
  })

  it('takes a rejected key out of rotation without deleting the account', async () => {
    const store = await createZhipuCredentialStore()
    const pool = createZhipuPool({ store })
    const account = await pool.addAccount(parseZhipuCredentials({ apiKey: 'key-alpha-9999', region: 'intl' }))
    await pool.markAuthFailed(account.id, 'rejected')
    // A credential the provider already refused must never be handed out again:
    // the pool reports an exhausted rotation instead of serving it, and no
    // other account is available to take over.
    await expect(pool.getEffectiveAccount()).rejects.toThrow()
    expect(await pool.hasAnotherAvailableAccount(new Set())).toBe(false)
    // The account keeps its place, so adding the key again restores it.
    expect(await pool.listAccounts()).toHaveLength(1)
    await pool.clearAuthFailed(account.id)
    await expect(pool.getEffectiveAccount()).resolves.toMatchObject({ account: { id: account.id } })
  })

  it('projects a pre-pool key as the primary account with no migration', async () => {
    const store = await createZhipuCredentialStore()
    await store.write(parseZhipuCredentials({ apiKey: 'legacy-key-7777', region: 'cn' }))
    const pool = createZhipuPool({ store })
    const summaries = await pool.listAccounts()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.region).toBe('cn')
    const effective = await pool.getEffectiveAccount()
    expect(effective.credentials).toMatchObject({ apiKey: 'legacy-key-7777', region: 'cn' })
  })
})

describe('zhipu key verification', () => {
  afterEach(() => {
    clearCachedCatalog()
    clearCachedQuota()
    vi.restoreAllMocks()
  })

  it('reads the deployment catalog and raises the console-specific diagnosis on refusal', async () => {
    const verified = await verifyApiKey('key-abc-1234', 'cn', {
      fetchFn: makeZhipuFetch(() => Response.json(CATALOG)),
    })
    expect(verified.map((model) => model.id)).toContain('glm-5.3')

    await expect(verifyApiKey('bad-key', 'cn', {
      fetchFn: makeZhipuFetch(() => Response.json({ code: 401, msg: '令牌已过期', success: false })),
    })).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    // A transport failure is transient, not a rejected key.
    await expect(verifyApiKey('key', 'intl', {
      fetchFn: makeZhipuFetch(() => { throw new Error('socket hang up') }),
    })).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('refuses a base URL that is not the deployment it was asked about', async () => {
    // The provider id is distinct from a user's own `zai` route by design, so a
    // custom OpenAI-compatible entry is never hidden by installing this plugin.
    expect(PROVIDER_ID).toBe('zhipu-coding-plan')
    const calls: string[] = []
    await verifyApiKey('key-abc-1234', 'intl', {
      fetchFn: makeZhipuFetch((url) => { calls.push(url); return Response.json(CATALOG) }),
    })
    expect(calls[0]).toBe('https://api.z.ai/api/coding/paas/v4/models')
  })
})
