import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type z from '@deepseek-ai/schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import {
  FileCredentialStore as CommandCodeCredentialStore,
  FileModelSettingsStore as CommandCodeModelSettingsStore,
} from '../src/host/command-code/token-store.ts'
import { clearCachedCatalog, clearCachedQuota } from '../src/host/command-code/client.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'
import { ANTIGRAVITY_PREFERENCES_NAMESPACE } from '../src/host/antigravity/token-store.ts'
import { COMMAND_CODE_PREFERENCES_NAMESPACE } from '../src/host/command-code/token-store.ts'

type SettingsValue = Record<string, unknown>
type Route = { path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }

const CATALOG = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_length: 1_000_000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_length: 1_000_000 },
  ],
}

const disposers: Array<() => void> = []

beforeEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/provider/v1/models')) return Response.json(CATALOG)
    if (url.endsWith('/alpha/whoami')) return Response.json({ user: { id: 'u1', userName: 'Eddy' }, key: { name: 'laptop' } })
    throw new Error(`Unexpected request ${url}`)
  }) as unknown as typeof fetch)
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearCachedCatalog()
  clearCachedQuota()
})

interface MountResult {
  routes: Route[]
  adapters: Map<string, LlmAdapter>
  owners: Set<string>
  listeners: Array<() => void>
  release(code: string): void
}

function mountPlugin(options: { preOwned?: string[] } = {}): MountResult {
  const routes: Route[] = []
  const adapters = new Map<string, LlmAdapter>()
  const owners = new Set<string>(options.preOwned ?? [])
  const listeners: Array<() => void> = []
  const settings = new Map<string, { get: () => SettingsValue; update: (patch: SettingsValue) => Promise<void> }>()
  const services: Record<string, unknown> = {}
  const ctx = {
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    inject: (_deps: string[], setup: (scope: Context) => void): void => setup(ctx as unknown as Context),
    get: (name: string) => services[name],
    on: (_event: string, listener: () => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    settings: {
      register(namespace: string, schema: z<SettingsValue>) {
        let value = schema(namespace === PREFERENCES_NAMESPACE
          ? { proxyMode: 'direct' }
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
        for (const provider of providers) {
          if (owners.has(provider)) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            ;(error as { code?: string }).code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const provider of providers) { owners.add(provider); adapters.set(provider, adapter) }
        return () => { for (const provider of providers) { owners.delete(provider); adapters.delete(provider) } }
      },
    },
    webServer: {
      host: '127.0.0.1',
      port: 3000,
      register(route: Route) { routes.push(route); return () => undefined },
    },
    tools: { register: () => () => undefined },
    web: { registerSearchProvider: () => () => undefined, registerFetchProvider: () => () => undefined },
    attachments: {},
    loader: { entries: () => [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  Object.assign(services, { llm: ctx.llm, webServer: ctx.webServer, tools: ctx.tools, attachments: ctx.attachments, loader: ctx.loader, settings: { installSection: () => undefined } })

  const codexStore = new MemoryTokenStore()
  void codexStore.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
  vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(codexStore)

  apply(ctx as unknown as Context)

  return {
    routes,
    adapters,
    owners,
    listeners,
    release(code: string) {
      owners.delete(code)
      for (const listener of [...listeners]) listener()
    },
  }
}

async function callRoute(plugin: MountResult, path: string, method = 'GET'): Promise<{ status: number; body: { ok: boolean; value?: Record<string, unknown>; error?: string } }> {
  let status = 0
  let body = ''
  const route = plugin.routes.find((candidate) => candidate.path === '/command-code/api')
  expect(route).toBeDefined()
  await route!.handler(
    { url: path, method, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } } as IncomingMessage,
    {
      writeHead: (value: number) => { status = value },
      end: (value: string) => { body = value },
    } as unknown as ServerResponse,
  )
  return { status, body: JSON.parse(body) as { ok: boolean; value?: Record<string, unknown>; error?: string } }
}

describe('Command Code plugin wiring', () => {
  it('claims the command-code route and serves its settings card status', async () => {
    vi.spyOn(CommandCodeCredentialStore.prototype, 'read').mockResolvedValue(null)
    vi.spyOn(CommandCodeModelSettingsStore.prototype, 'read').mockResolvedValue({
      enabledModelIds: [], catalogModels: [], contextWindowOverrides: {}, defaultReasoningEffort: null,
    })
    const plugin = mountPlugin()
    expect(plugin.adapters.has('command-code')).toBe(true)

    const response = await callRoute(plugin, '/command-code/api/status')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.value).toMatchObject({ authenticated: false, serving: true, conflict: null })
    expect((response.body.value!.models as unknown[]).length).toBe(2)
  })

  it('keeps loading when another adapter owns the route, then claims it on release', async () => {
    vi.spyOn(CommandCodeCredentialStore.prototype, 'read').mockResolvedValue(null)
    vi.spyOn(CommandCodeModelSettingsStore.prototype, 'read').mockResolvedValue({
      enabledModelIds: [], catalogModels: [], contextWindowOverrides: {}, defaultReasoningEffort: null,
    })
    const plugin = mountPlugin({ preOwned: ['command-code'] })
    // The route stays with its current owner; this plugin serves the card only.
    expect(plugin.adapters.has('command-code')).toBe(false)

    const conflicted = await callRoute(plugin, '/command-code/api/status')
    expect(conflicted.body.value).toMatchObject({ serving: false })
    expect(String(conflicted.body.value!.conflict)).toContain('already registered')

    plugin.release('command-code')
    expect(plugin.adapters.has('command-code')).toBe(true)
    const healed = await callRoute(plugin, '/command-code/api/status')
    expect(healed.body.value).toMatchObject({ serving: true, conflict: null })
  })

  it('registers the three settings namespaces the plugin owns', () => {
    vi.spyOn(CommandCodeCredentialStore.prototype, 'read').mockResolvedValue(null)
    mountPlugin()
    const namespaces = [
      PREFERENCES_NAMESPACE,
      ANTIGRAVITY_PREFERENCES_NAMESPACE,
      COMMAND_CODE_PREFERENCES_NAMESPACE,
    ]
    expect(new Set(namespaces).size).toBe(3)
    expect(namespaces).toContain('dsh-command-code')
  })
})
