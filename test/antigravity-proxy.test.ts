import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type z from '@deepseek-ai/schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { apply } from '../src/index.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { getWebLoginStatus } from '../src/host/antigravity/oauth.ts'
import { FileCredentialStore, FileModelSettingsStore, type AntigravityCredentials } from '../src/host/antigravity/token-store.ts'
import { DAILY_ENDPOINT, DEFAULT_ENDPOINT, TOKEN_URL } from '../src/host/antigravity/types.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'

vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn(),
}))

type SettingsValue = Record<string, unknown>
type Route = { path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }
const disposers: Array<() => void> = []
const directFetch = vi.fn<typeof fetch>()
const proxyFetch = vi.mocked(undiciFetch)

beforeEach(() => {
  vi.stubGlobal('fetch', directFetch.mockReset().mockRejectedValue(new Error('Unexpected direct request')))
  proxyFetch.mockReset().mockRejectedValue(new Error('Unexpected proxied request'))
  vi.stubEnv('DSH_ANTIGRAVITY_ENDPOINT', '')
  vi.stubEnv('DSH_ANTIGRAVITY_CLIENT_ID', 'test-client')
  vi.stubEnv('DSH_ANTIGRAVITY_CLIENT_SECRET', 'test-client-secret')
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function mountPlugin() {
  let credentials: AntigravityCredentials = { access: 'expired-access', refresh: 'test-refresh', expires: 1 }
  vi.spyOn(FileCredentialStore.prototype, 'read').mockImplementation(async () => credentials)
  vi.spyOn(FileCredentialStore.prototype, 'write').mockImplementation(async (value) => { credentials = value })
  vi.spyOn(FileModelSettingsStore.prototype, 'read').mockResolvedValue({
    enabledModelIds: ['gemini-3.7-flash'], catalogModels: [],
  })
  vi.spyOn(FileModelSettingsStore.prototype, 'setCatalogModels').mockResolvedValue({
    enabledModelIds: ['gemini-3.7-flash'], catalogModels: [],
  })
  const codexStore = new MemoryTokenStore()
  await codexStore.save({ accessToken: 'test-codex-access', refreshToken: 'test-codex-refresh', expiresAt: Date.now() + 3_600_000 })
  vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(codexStore)

  const adapters = new Map<string, LlmAdapter>()
  const routes: Route[] = []
  const settings = new Map<string, { get: () => SettingsValue; update: (patch: SettingsValue) => Promise<void> }>()
  const ctx = {
    effect: (setup: () => () => void) => disposers.push(setup()),
    settings: {
      register(namespace: string, schema: z<SettingsValue>) {
        let value = schema(namespace === PREFERENCES_NAMESPACE
          ? { proxyMode: 'custom', customProxyUrl: 'http://127.0.0.1:7890' }
          : {})
        const scope = {
          get: () => value,
          update: async (patch: SettingsValue) => { value = schema({ ...value, ...patch }) },
          watch: () => () => undefined,
        }
        settings.set(namespace, scope)
        return scope
      },
    },
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => { for (const provider of providers) adapters.delete(provider) }
      },
    },
    webServer: {
      host: '127.0.0.1', port: 3000,
      register(route: Route) { routes.push(route); return () => undefined },
    },
    tools: { register: () => () => undefined },
    web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
    attachments: {},
    loader: { entries: () => [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  apply(ctx as unknown as Context)
  return {
    adapters,
    preferences: settings.get(PREFERENCES_NAMESPACE)!,
    credentials: () => credentials,
    async route(path: string, method = 'GET') {
      let status = 0
      let body = ''
      await routes.find((route) => route.path === '/antigravity/api')!.handler(
        { url: `/antigravity/api/${path}`, method } as IncomingMessage,
        { writeHead: (value: number) => { status = value }, end: (value: string) => { body = value } } as unknown as ServerResponse,
      )
      expect(status).toBe(200)
      return JSON.parse(body)
    },
  }
}

function mockProxy(respond: (url: string, init?: RequestInit) => Response) {
  proxyFetch.mockImplementation(async (input, init) => respond(String(input), init as RequestInit) as unknown as Awaited<ReturnType<typeof undiciFetch>>)
}

function geminiResponse() {
  return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"connected"}]},"finishReason":"STOP"}]}}\n\n')
}

async function generate(adapter: LlmAdapter, provider = 'antigravity', model = 'gemini-3.7-flash') {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider, model, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Test connection' }] })],
  })) chunks.push(chunk)
  return chunks
}

function expectSharedDispatcher() {
  const dispatchers = proxyFetch.mock.calls.map(([, init]) => init?.dispatcher)
  expect(dispatchers[0]).toBeInstanceOf(ProxyAgent)
  expect(new Set(dispatchers).size).toBe(1)
}

describe('Antigravity shared proxy settings', () => {
  it('shares the GPT proxy for token refresh and fallback generation, and applies mode changes to the existing adapter', async () => {
    const plugin = await mountPlugin()
    mockProxy((url) => {
      if (url === TOKEN_URL) return Response.json({ access_token: 'refreshed-access', expires_in: 3600 })
      if (url.includes('/responses')) return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
      if (url.startsWith(DAILY_ENDPOINT)) return new Response('', { status: 503 })
      return geminiResponse()
    })
    const gemini = plugin.adapters.get('antigravity')!
    expect(await generate(gemini)).toContainEqual({ type: 'text-delta', index: 0, text: 'connected' })
    await generate(plugin.adapters.get('codex-chatgpt')!, 'codex-chatgpt', 'gpt-5.6-sol')
    expect(proxyFetch.mock.calls.map(([url]) => String(url))).toEqual([
      TOKEN_URL,
      `${DAILY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
      `${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
      expect.stringContaining('/responses'),
    ])
    expectSharedDispatcher()
    expect(plugin.credentials().access).toBe('refreshed-access')
    expect(directFetch).not.toHaveBeenCalled()

    const customDispatcher = proxyFetch.mock.calls[0][1]?.dispatcher
    vi.spyOn(ProxyManager.prototype, 'getSystemProxy').mockReturnValue('http://127.0.0.1:8888')
    await plugin.preferences.update({ proxyMode: 'auto' })
    mockProxy(() => geminiResponse())
    await generate(gemini)
    expect(proxyFetch.mock.calls.at(-1)?.[1]?.dispatcher).toBeInstanceOf(ProxyAgent)
    expect(proxyFetch.mock.calls.at(-1)?.[1]?.dispatcher).not.toBe(customDispatcher)

    const proxiedCount = proxyFetch.mock.calls.length
    await plugin.preferences.update({ proxyMode: 'direct' })
    directFetch.mockImplementation(async () => geminiResponse())
    await generate(gemini)
    expect(directFetch).toHaveBeenCalledTimes(1)
    expect(proxyFetch).toHaveBeenCalledTimes(proxiedCount)
  })

  it('uses the selected proxy for quota requests, catalog discovery, and credential refresh from the settings route', async () => {
    const plugin = await mountPlugin()
    mockProxy((url) => {
      if (url === TOKEN_URL) return Response.json({ access_token: 'quota-access', expires_in: 3600 })
      if (url.endsWith(':loadCodeAssist')) return Response.json({ projectId: 'test-project' })
      if (url.endsWith(':retrieveUserQuotaSummary')) return Response.json({ groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'hourly', remainingFraction: 0.75 }] }] })
      if (url.endsWith(':fetchAvailableModels')) return Response.json({ models: { 'gemini-3.7-flash': { displayName: 'Gemini' } } })
      throw new Error(`Unexpected request: ${url}`)
    })
    const result = await plugin.route('quota')
    expect(result.value.quota.projectId).toBe('test-project')
    expect(result.value.quota.groups[0].buckets[0].remainingFraction).toBe(0.75)
    expect(result.value.quota.catalogModels).toEqual([{ id: 'gemini-3.7-flash', name: 'Gemini' }])
    expect(proxyFetch).toHaveBeenCalledTimes(4)
    expectSharedDispatcher()
    for (const [, init] of proxyFetch.mock.calls.slice(1)) {
      expect(new Headers(init?.headers as HeadersInit).get('Authorization')).toBe('Bearer quota-access')
    }
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('uses the selected proxy throughout web login, including email and fallback project discovery', async () => {
    const plugin = await mountPlugin()
    const reservation = http.createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    vi.stubEnv('DSH_ANTIGRAVITY_CALLBACK_HOST', '127.0.0.1')
    vi.stubEnv('DSH_ANTIGRAVITY_CALLBACK_PORT', String(port))
    mockProxy((url) => {
      if (url === TOKEN_URL) return Response.json({ access_token: 'login-access', refresh_token: 'login-refresh', expires_in: 3600 })
      if (url.includes('/userinfo')) return Response.json({ email: 'test@example.test' })
      if (url.startsWith(DAILY_ENDPOINT)) return new Response('', { status: 503 })
      if (url.endsWith(':loadCodeAssist')) return Response.json({})
      if (url.endsWith(':listCloudAICompanionProjects')) return Response.json({ projects: [{ projectId: 'login-project' }] })
      throw new Error(`Unexpected request: ${url}`)
    })
    const result = await plugin.route('login', 'POST')
    const authorization = new URL(result.value.authUrl)
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('code', 'test-authorization-code')
    await new Promise<void>((resolve, reject) => {
      http.get(callback, (response) => { response.resume(); response.on('end', resolve) }).on('error', reject)
    })
    await vi.waitFor(() => expect(getWebLoginStatus().status).toBe('complete'))
    expect(plugin.credentials()).toMatchObject({ access: 'login-access', refresh: 'login-refresh', email: 'test@example.test', projectId: 'login-project' })
    expect(proxyFetch).toHaveBeenCalledTimes(6)
    expectSharedDispatcher()
    expect(directFetch).not.toHaveBeenCalled()
  })
})
