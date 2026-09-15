import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildModelOptions,
  clearCachedCatalog,
  clearCachedQuota,
  effectiveContextWindow,
  parseMeters,
  parseProviderModels,
  parseTimestamp,
  parseUsageWindows,
  parseWhoami,
  verifyApiKey,
} from '../src/host/command-code/client.ts'
import { resolveEnabledModelIds, getCommandCodeWebStatus, registerCommandCodeRoutes } from '../src/host/command-code/routes.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/command-code/token-store.ts'
import {
  FALLBACK_MODELS,
  inputModalitiesFor,
  maxOutputTokensFor,
  reasoningEffortsFor,
  resolveApiEnv,
  wireForModel,
} from '../src/host/command-code/types.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

const CATALOG = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', object: 'model', name: 'DeepSeek V4.1 Flash', context_length: 1_000_000 },
    { id: 'claude-sonnet-4-6', object: 'model', name: 'Claude Sonnet 4.6', context_length: 1_000_000 },
    { id: 'gpt-5.6-sol', object: 'model', name: 'GPT-5.6 Sol', context_length: 1_050_000 },
  ],
}

describe('Command Code wire routing', () => {
  it('sends Anthropic models to /messages and everything else to /chat/completions', () => {
    expect(wireForModel('claude-sonnet-4-6')).toBe('anthropic')
    expect(wireForModel('claude-haiku-4-5-20251001')).toBe('anthropic')
    expect(wireForModel('deepseek/deepseek-v4.1-flash')).toBe('openai')
    expect(wireForModel('gpt-5.6-sol')).toBe('openai')
    expect(wireForModel('moonshotai/Kimi-K3')).toBe('openai')
  })

  it('declares the modalities the registry declares, per model', () => {
    expect(inputModalitiesFor('claude-opus-5')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('gpt-5.6-sol')).toEqual(['text', 'image'])
    // DeepSeek V4.1 Flash is a vision model; the plain V4 Flash is not. This is
    // exactly the pair a family-name heuristic gets wrong.
    expect(inputModalitiesFor('deepseek/deepseek-v4.1-flash')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('deepseek/deepseek-v4-flash-vision-exp')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('deepseek/deepseek-v4-flash')).toEqual(['text'])
    expect(inputModalitiesFor('deepseek/deepseek-v4-pro')).toEqual(['text'])
    // The GLM split runs the other way inside one vendor.
    expect(inputModalitiesFor('z-ai/glm-5.3-flash')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('zai-org/GLM-5.3')).toEqual(['text'])
    // Open-weight models a prefix heuristic missed entirely.
    expect(inputModalitiesFor('moonshotai/Kimi-K3')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('xai/grok-4.6')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('MiniMaxAI/MiniMax-M3')).toEqual(['text', 'image'])
    expect(inputModalitiesFor('Qwen/Qwen3.8-Flash')).toEqual(['text', 'image'])
  })

  it('falls back to text-only for a model the registry does not describe', () => {
    // DSH turns a false "no images" into a visible placeholder, while a false
    // "images accepted" would send bytes to an endpoint that rejects the request.
    expect(inputModalitiesFor('some/future-model')).toEqual(['text'])
  })

  it('advertises exactly the reasoning levels the registry declares', () => {
    expect(reasoningEffortsFor('deepseek/deepseek-v4.1-flash')).toEqual(['low', 'high', 'max'])
    expect(reasoningEffortsFor('deepseek/deepseek-v4-flash')).toEqual(['high', 'max'])
    expect(reasoningEffortsFor('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningEffortsFor('gpt-5.6-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningEffortsFor('gpt-5.4-mini')).toEqual(['low', 'medium', 'high'])
    // A described model with no levels is a non-reasoning model, not a default one.
    expect(reasoningEffortsFor('moonshotai/Kimi-K3')).toEqual(['low', 'high', 'max'])
    expect(reasoningEffortsFor('claude-haiku-4-5-20251001')).toEqual([])
    expect(reasoningEffortsFor('some/future-model')).toEqual([])
  })

  it('resolves the API deployment from the environment seam', () => {
    expect(resolveApiEnv('staging')).toBe('staging')
    expect(resolveApiEnv('LOCAL')).toBe('local')
    expect(resolveApiEnv('nonsense')).toBe('prod')
    expect(resolveApiEnv(undefined)).toBe('prod')
  })

  it('prefers a registry-declared output cap, then the observed cap, then the default', () => {
    // Registry-declared (Qwen 3.8 27B and the three Ling/Laguna entries carry one).
    expect(maxOutputTokensFor('Qwen/Qwen3.8-27B')).toBe(32_768)
    expect(maxOutputTokensFor('z-ai/glm-5.3-flash')).toBe(131_072)
    // Not declared by the registry; the observed cross-provider cap applies.
    expect(maxOutputTokensFor('gpt-5.6-sol')).toBe(128_000)
    expect(maxOutputTokensFor('deepseek/deepseek-v4.1-flash')).toBe(384_000)
    expect(maxOutputTokensFor('claude-sonnet-4-6')).toBe(64_000)
    // Nothing known about it.
    expect(maxOutputTokensFor('unknown-model')).toBe(32_768)
  })
})

describe('Command Code account payload parsing', () => {
  it('maps a nested whoami payload onto the public account DTO', () => {
    const account = parseWhoami({
      user: { id: 'u1', userName: 'Eddy', email: 'e@example.com' },
      organization: { name: 'Acme' },
      key: { name: 'laptop' },
      subscription: { name: 'Max', id: 'max' },
    })
    expect(account).toMatchObject({
      userId: 'u1', userName: 'Eddy', email: 'e@example.com',
      organizationName: 'Acme', keyName: 'laptop', planLabel: 'Max', planId: 'max',
    })
  })

  it('falls back to stored facts when the service omits fields', () => {
    const account = parseWhoami({ success: true }, { userId: 'stored', keyName: 'k1', authenticatedAt: 42 })
    expect(account.userId).toBe('stored')
    expect(account.keyName).toBe('k1')
    expect(account.authenticatedAt).toBe(42)
    expect(account.email).toBeNull()
  })

  it('parses every supported timestamp encoding', () => {
    expect(parseTimestamp('2026-09-15T10:00:00Z')).toBe(Date.parse('2026-09-15T10:00:00Z'))
    expect(parseTimestamp(1_760_000_000)).toBe(1_760_000_000_000)
    expect(parseTimestamp(1_760_000_000_000)).toBe(1_760_000_000_000)
    expect(parseTimestamp('not a date')).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
  })

  it('turns bounded allowance objects into meters', () => {
    const meters = parseMeters({
      data: {
        credits: { limit: 100, used: 25, resetTime: '2026-10-01T00:00:00Z' },
        windows: [{ id: 'five-hour', usedPercent: 40, windowDurationMins: 300 }],
      },
    })
    const limitMeter = meters.find((meter) => meter.limit === '100')
    expect(limitMeter).toBeDefined()
    expect(limitMeter!.used).toBe('25')
    expect(limitMeter!.remainingFraction).toBeCloseTo(0.75)
    expect(limitMeter!.resetsAt).toBe(Date.parse('2026-10-01T00:00:00Z'))
    const windowMeter = meters.find((meter) => meter.id === 'five-hour' || meter.label === 'five-hour')
    expect(windowMeter?.remainingFraction).toBeCloseTo(0.6)
  })

  it('accepts both 0..1 and 0..100 percentage encodings', () => {
    const [fraction] = parseMeters({ a: { usedPercent: 0.25, id: 'a' } })
    const [percent] = parseMeters({ a: { usedPercent: 25, id: 'a' } })
    expect(fraction!.usedFraction).toBeCloseTo(0.25)
    expect(percent!.usedFraction).toBeCloseTo(0.25)
  })

  it('still reports a bare credit balance', () => {
    const meters = parseMeters({ creditBalance: 12.5 })
    expect(meters).toHaveLength(1)
    expect(meters[0]).toMatchObject({ id: 'credits', limit: '12.50' })
  })

  it('reports no meters for a payload with no bounded allowance', () => {
    expect(parseMeters({ message: 'ok' })).toEqual([])
    expect(parseMeters(undefined)).toEqual([])
  })

  it('parses usage windows and ignores entries without a percentage', () => {
    const windows = parseUsageWindows({ usage: [
      { name: 'five-hour', usedPercent: 12, windowDurationMins: 300, resetTime: '2026-09-15T12:00:00Z' },
      { name: 'weekly' },
    ] })
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ label: 'five-hour', usedPercent: 12, windowDurationMins: 300 })
    expect(windows[0]!.resetsAt).toBe(Date.parse('2026-09-15T12:00:00Z'))
  })

  it('parses the public model catalog', () => {
    const models = parseProviderModels(CATALOG)
    expect(models).toEqual([
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 1_050_000 },
    ])
    expect(parseProviderModels({ data: 'nonsense' })).toEqual([])
  })
})

describe('Command Code model options', () => {
  it('prefers a saved override over the catalog value', () => {
    const catalog = parseProviderModels(CATALOG)
    expect(effectiveContextWindow('deepseek/deepseek-v4.1-flash', catalog, {})).toBe(1_000_000)
    expect(effectiveContextWindow('deepseek/deepseek-v4.1-flash', catalog, { 'deepseek/deepseek-v4.1-flash': 512_000 })).toBe(512_000)
    expect(effectiveContextWindow('never-seen', catalog, {})).toBe(128_000)
  })

  it('renders an option per catalog entry with its wire and efforts', () => {
    const options = buildModelOptions(parseProviderModels(CATALOG), ['claude-sonnet-4-6'], {})
    const claude = options.find((option) => option.id === 'claude-sonnet-4-6')!
    expect(claude).toMatchObject({ enabled: true, wire: 'anthropic', defaultContextWindow: 1_000_000 })
    expect(claude.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(options.find((option) => option.id === 'gpt-5.6-sol')!.enabled).toBe(false)
  })

  it('treats an untouched shipped default as "everything the catalog offers"', () => {
    const catalog = parseProviderModels(CATALOG)
    const shipped = FALLBACK_MODELS.map((model) => model.id)
    expect(resolveEnabledModelIds(shipped, catalog)).toEqual(catalog.map((model) => model.id))
    expect(resolveEnabledModelIds([], catalog)).toEqual(catalog.map((model) => model.id))
  })

  it('honours an explicit selection and drops entries the catalog no longer serves', () => {
    const catalog = parseProviderModels(CATALOG)
    expect(resolveEnabledModelIds(['claude-sonnet-4-6'], catalog)).toEqual(['claude-sonnet-4-6'])
    expect(resolveEnabledModelIds(['claude-sonnet-4-6', 'gone'], catalog)).toEqual(['claude-sonnet-4-6'])
    // A selection whose every entry disappeared would empty the picker.
    expect(resolveEnabledModelIds(['gone'], catalog)).toEqual(catalog.map((model) => model.id))
  })
})

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

describe('Command Code settings routes', () => {
  let store: FileCredentialStore
  let modelSettings: FileModelSettingsStore
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let originalFetch: typeof fetch

  beforeEach(() => {
    clearCachedCatalog()
    clearCachedQuota()
    store = new FileCredentialStore(tmp('cc-cred'))
    modelSettings = new FileModelSettingsStore(tmp('cc-models'))
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
    globalThis.fetch = (async () => Response.json(CATALOG)) as typeof fetch
    registerCommandCodeRoutes(ctx, store, modelSettings)
    handler = routes[0]!.handler
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCachedCatalog()
    clearCachedQuota()
    vi.restoreAllMocks()
  })

  it('reports a signed-out status with the live catalog and no credential', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/status' }), response)
    expect(captured.status).toBe(200)
    const value = (captured.body as { value: Record<string, unknown> }).value
    expect(value.authenticated).toBe(false)
    expect(value.hasCredentials).toBe(false)
    expect(value.serving).toBe(true)
    expect((value.models as unknown[]).length).toBe(3)
    expect(value.storagePath).toContain('cc-cred')
  })

  it('reports the stored account when credentials exist', async () => {
    vi.spyOn(store, 'read').mockResolvedValue({
      apiKey: 'k', userId: 'u1', userName: 'Eddy', email: 'e@example.com', keyName: 'laptop', authenticatedAt: 1234,
    })
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/status' }), response)
    const value = (captured.body as { value: { account: Record<string, unknown>; authenticated: boolean } }).value
    expect(value.authenticated).toBe(true)
    expect(value.account).toMatchObject({ userId: 'u1', userName: 'Eddy', email: 'e@example.com', keyName: 'laptop' })
  })

  it('persists a model selection posted from the card', async () => {
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k' })
    const update = vi.fn(async (patch: unknown) => patch)
    const preferences = { status: () => ({ enabledModelIds: [], catalogModels: [], contextWindowOverrides: {}, defaultReasoningEffort: null }), update }
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = { webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } } } as unknown as Context
    registerCommandCodeRoutes(ctx, store, modelSettings, preferences as never)
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(
      fakeRequest({ url: '/command-code/api/models', method: 'POST', body: { enabledModelIds: ['claude-sonnet-4-6', 5], contextWindowOverrides: { 'claude-sonnet-4-6': 400_000, bad: -1 } } }),
      response,
    )
    expect(captured.status).toBe(200)
    expect(update).toHaveBeenCalledWith({ enabledModelIds: ['claude-sonnet-4-6'], contextWindowOverrides: { 'claude-sonnet-4-6': 400_000 } })
  })

  it('rejects a cross-origin mutation and an unsupported method', async () => {
    const crossOrigin = fakeExchange()
    await handler(
      fakeRequest({ url: '/command-code/api/models', method: 'POST', headers: { origin: 'https://evil.example' }, body: {} }),
      crossOrigin.response,
    )
    expect(crossOrigin.captured.status).toBe(403)

    const wrongMethod = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/status', method: 'POST' }), wrongMethod.response)
    expect(wrongMethod.captured.status).toBe(405)

    const notFound = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/nope' }), notFound.response)
    expect(notFound.captured.status).toBe(404)
  })

  it('deletes the credential and clears the caches on logout', async () => {
    const remove = vi.spyOn(store, 'delete').mockResolvedValue(undefined)
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/logout', method: 'POST', body: {} }), response)
    expect(remove).toHaveBeenCalled()
    expect(captured.status).toBe(200)
  })

  it('serves the model catalog on GET /models', async () => {
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k', apiEnv: 'staging' })
    const { response, captured } = fakeExchange()
    await handler(fakeRequest({ url: '/command-code/api/models' }), response)
    const value = (captured.body as { value: { apiEnv: string; models: Array<{ enabled: boolean }> } }).value
    expect(value.apiEnv).toBe('staging')
    expect(value.models.every((model) => model.enabled)).toBe(true)
  })

  it('surfaces a route conflict without failing the status request', async () => {
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const routes: Array<{ handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
    const ctx = { webServer: { register(route: { handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) { routes.push(route); return () => undefined } } } as unknown as Context
    registerCommandCodeRoutes(ctx, store, modelSettings, undefined, {
      serving: () => false,
      conflict: () => 'already owned',
    })
    const { response, captured } = fakeExchange()
    await routes[0]!.handler(fakeRequest({ url: '/command-code/api/status' }), response)
    const value = (captured.body as { value: { serving: boolean; conflict: string } }).value
    expect(value.serving).toBe(false)
    expect(value.conflict).toBe('already owned')
  })

  it('validates a manual API key against whoami before reporting the account', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/alpha/whoami')) {
        return Response.json({ user: { id: 'u9', userName: 'Manual', email: 'm@example.com' }, key: { name: 'pasted' } })
      }
      return Response.json(CATALOG)
    }) as typeof fetch
    const write = vi.spyOn(store, 'write').mockResolvedValue(undefined)
    const account = await verifyApiKey('cmd_key')
    expect(account).toMatchObject({ userId: 'u9', userName: 'Manual', email: 'm@example.com', keyName: 'pasted' })
    expect(write).not.toHaveBeenCalled()
  })

  it('builds the status the card renders through the exported helper', async () => {
    vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'k', userId: 'u1' })
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabledModelIds: ['claude-sonnet-4-6'],
      catalogModels: [],
      contextWindowOverrides: { 'claude-sonnet-4-6': 300_000 },
      defaultReasoningEffort: 'high',
    })
    const status = await getCommandCodeWebStatus(store, modelSettings)
    expect(status.authenticated).toBe(true)
    expect(status.defaultReasoningEffort).toBe('high')
    const claude = status.models.find((model) => model.id === 'claude-sonnet-4-6')!
    expect(claude).toMatchObject({ enabled: true, contextWindow: 300_000, defaultContextWindow: 1_000_000 })
    expect(status.models.every((model) => model.id === 'claude-sonnet-4-6' || !model.enabled)).toBe(true)
  })
})
