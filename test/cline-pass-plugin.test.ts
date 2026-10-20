/**
 * The Cline Pass line mounts through its factory with no sibling involvement:
 * one adapter claim, one settings route prefix, one hub summary source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createClinePassLine } from '../src/host/cline-pass/line.ts'
import { PROVIDER_ID } from '../src/host/cline-pass/types.ts'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function mountLine() {
  const adapters = new Map<string, LlmAdapter>()
  const routes: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  const tools: Array<{ name: string }> = []
  const listeners = new Map<string, Set<() => void>>()
  const ctx = {
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    inject: (_deps: string[], setup: (scope: Context) => void) => setup(ctx as unknown as Context),
    get: (name: string) => (name === 'llm' ? ctx.llm : name === 'webServer' ? ctx.webServer : name === 'tools' ? ctx.tools : name === 'attachments' ? {} : undefined),
    llm: {
      registerAdapter(providers: string[], adapter: LlmAdapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => { for (const provider of providers) adapters.delete(provider) }
      },
    },
    webServer: {
      register(route: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register(definition: { name: string }) {
        tools.push(definition)
        return () => undefined
      },
    },
    emit: vi.fn(),
    on: (event: string, listener: () => void) => {
      const bucket = listeners.get(event) ?? new Set<() => void>()
      listeners.set(event, bucket)
      bucket.add(listener)
      return () => { bucket.delete(listener) }
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  const line = createClinePassLine(ctx as unknown as Context, {
    fetchFn: (async () => new Response('{}')) as typeof fetch,
    disableTools: true,
  })
  disposers.push(() => line.dispose())
  return { line, adapters, routes, tools }
}

describe('Cline Pass line mount', () => {
  it('claims the provider route and registers one settings prefix', () => {
    const { line, adapters, routes } = mountLine()
    expect(adapters.get(PROVIDER_ID)).toBe(line.adapter)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/cline-pass/api' })
  })

  it('advertises the shipped catalog and resolves model metadata', async () => {
    const { line } = mountLine()
    const models = await line.adapter.listModels(PROVIDER_ID)
    expect(models.length).toBeGreaterThanOrEqual(15)
    const glm = models.find((model) => model.id === 'cline-pass/glm-5.3')
    expect(glm).toMatchObject({ name: 'GLM-5.3', inputModalities: ['text'] })
    const resolved = await line.adapter.resolveModel(PROVIDER_ID, 'cline-pass/glm-5.3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'max'])
    expect(resolved.defaultMaxTokens).toBe(64_000)
  })

  it('projects CLINE_PASS_API_KEY as the primary account while the pool is empty', async () => {
    vi.stubEnv('CLINE_PASS_API_KEY', 'sk-ambient')
    const { line } = mountLine()
    const accounts = await line.accountPool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe('acc_primary')
    // The environment key is a projection, not a write: nothing was persisted.
    const stored = await line.accountPool.mirrorStore().read()
    expect(stored).toBeNull()
  })

  it('still projects the ambient key when the credential backend cannot answer', async () => {
    // A bare Linux runner has no Secret Service, so the platform store throws on
    // read; the environment key is an independent source and must survive that.
    vi.stubEnv('CLINE_PASS_API_KEY', 'sk-ambient')
    const { line } = mountLine()
    const store = line.accountPool.mirrorStore()
    vi.spyOn(store, 'read').mockRejectedValue(new Error('secret-tool is unavailable'))
    const accounts = await line.accountPool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe('acc_primary')
  })

  it('reports itself on the hub summary without touching an upstream', async () => {
    const { line } = mountLine()
    const summary = await line.hubSource.read()
    expect(summary).toMatchObject({
      enabled: true,
      accountCount: 0,
      authenticated: false,
      totalModelCount: 15,
    })
    expect(summary.enabledModelCount).toBe(15)
  })
})
