import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebError, WebRuntime } from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_FETCH_PROVIDER_ID } from '../src/compat.ts'
import * as plugin from '../src/index.ts'
import { SearchProviderSwitcher } from '../src/host/search-provider-switcher.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'

const namespace = PREFERENCES_NAMESPACE as SettingsNamespace

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

interface MountOptions {
  readonly searchProvider: 'dsh' | 'codex'
  readonly proxyMode: 'auto' | 'custom' | 'direct'
  readonly ready?: { onReady(listener: () => void): () => void }
}

/** One registered settings namespace, the shape `registerPreferenceStore` binds to. */
interface MemoryScope {
  get(): Record<string, unknown>
  update(patch: Record<string, unknown>): Promise<void>
  watch(callback: (next: Record<string, unknown>, prev: Record<string, unknown>) => void | Promise<void>): () => void
}

/** Schema a register-based harness validates a namespace document with. */
type MemorySchema = (value: unknown) => Record<string, unknown>

/**
 * The settings service of the generation this plugin still supports: registering
 * a namespace hands back a scope it reads and watches.
 *
 * Harness 0.1.7 replaced that seam with `SettingsForms`, so the service no longer
 * exists to borrow: a plain double keeps these tests about the web provider
 * lifecycle. Its namespaced `update` is the old service's own method, which is
 * how the cases below drive one preference change.
 */
function memorySettings(initial: Record<string, unknown>) {
  const scopes = new Map<unknown, MemoryScope>()
  return {
    register(registered: unknown, schema: MemorySchema): MemoryScope {
      let value = schema(initial)
      const listeners = new Set<(next: Record<string, unknown>, prev: Record<string, unknown>) => void | Promise<void>>()
      const scope: MemoryScope = {
        get: () => value,
        update: async (patch) => {
          const prev = value
          value = schema({ ...value, ...patch })
          for (const listener of listeners) await listener(value, prev)
        },
        watch: (callback) => {
          listeners.add(callback)
          return () => { listeners.delete(callback) }
        },
      }
      scopes.set(registered, scope)
      return scope
    },
    async update(registered: unknown, patch: Record<string, unknown>): Promise<void> {
      await scopes.get(registered)!.update(patch)
    },
  }
}

/**
 * Mount the plugin over a loader whose built-in fetch provider refuses every
 * request the way DSH does on a proxied machine, and report the config the
 * plugin resolved for the `web` entry.
 */
async function mountPlugin(options: MountOptions) {
  const settings = memorySettings({
    searchProvider: options.searchProvider,
    proxyMode: options.proxyMode,
  })

  const store = vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(new MemoryTokenStore())
  const fetchFn = vi.fn(async () => new Response('plugin page', { headers: { 'content-type': 'text/plain' } }))
  vi.stubGlobal('fetch', fetchFn)
  const ctx = new Context()
  if (options.ready) ctx.provide('appReady', options.ready)
  ctx.provide('webServer', { host: '127.0.0.1', port: 3000, register: () => () => undefined })
  ctx.provide('llm', { registerAdapter: () => () => undefined })
  ctx.provide('attachments', {})
  ctx.provide('tools', { register: () => () => undefined })
  ctx.provide('settings', settings)
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.web = WebRuntime
  await ctx.loader.root.update([{
    id: 'web', name: 'cordis:web',
    config: { searchProvider: 'deepseek-official', fetchProvider: 'http' },
  }])
  const nativeProvider = ctx.inject(['web'], ctx => {
    ctx.web.registerFetchProvider({
      id: 'http', available: () => true,
      fetch: async () => { throw new WebError('URL hostname "example.com" resolves to a non-public IP address', 'WEB_BLOCKED_URL') },
    })
  })
  await nativeProvider.await()
  await ctx.plugin(plugin).await()

  return {
    ctx,
    store,
    webConfig: () => ctx.loader.resolve('web').options.config as Record<string, unknown>,
  }
}

describe('web provider lifecycle', () => {
  it('reconciles the running provider after launcher readiness without toggling preferences', async () => {
    let ready: (() => void) | undefined
    const unwatch = vi.fn()
    const { ctx } = await mountPlugin({ searchProvider: 'codex', proxyMode: 'direct', ready: {
      onReady: listener => { ready = listener; return unwatch },
    } })
    try {
      await vi.waitFor(async () => expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('plugin page'))
      const entry = ctx.loader.resolve('web')
      const desired = entry.options.config
      // Reproduce the observed startup split: desired options, stale runtime.
      const paused = vi.spyOn(SearchProviderSwitcher.prototype, 'select').mockResolvedValue()
      await entry.fiber!.update({ searchProvider: 'deepseek-official', fetchProvider: 'http' }, true)
      entry.options.config = desired
      await vi.waitFor(async () => {
        expect(ctx.web).toBeDefined()
        await expect(ctx.web.fetch({ url: 'https://example.com' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
      })
      paused.mockRestore()
      ready!()
      await vi.waitFor(async () => expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('plugin page'))
    } finally { await ctx.fiber.dispose() }
    expect(unwatch).toHaveBeenCalledTimes(1)
  })

  it.each(['dsh', 'codex'] as const)('keeps fetch switching across web reloads with %s initially selected', async (initial) => {
    const { ctx, store } = await mountPlugin({ searchProvider: initial, proxyMode: 'direct' })
    try {
      const expectSelected = async (searchProvider: 'dsh' | 'codex') => {
        await vi.waitFor(async () => {
          if (searchProvider === 'codex') {
            expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('plugin page')
          } else {
            await expect(ctx.web.fetch({ url: 'https://example.com' }))
              .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
          }
        })
      }
      await expectSelected(initial)

      for (const searchProvider of ['codex', 'dsh', 'codex'] as const) {
        await ctx.settings.update(namespace, { searchProvider })
        await expectSelected(searchProvider)
      }

      await ctx.loader.resolve('web').fiber!.restart()
      await expectSelected('codex')
      expect(store).toHaveBeenCalledTimes(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves the fetch tool from this plugin while a proxy is configured', async () => {
    // A machine with a proxy is exactly the machine whose fake-ip DNS the built-in provider
    // refuses, so the plugin provider takes the tool even with DSH search selected.
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9')
    const { ctx, webConfig } = await mountPlugin({ searchProvider: 'dsh', proxyMode: 'auto' })
    try {
      await vi.waitFor(() => expect(webConfig()).toMatchObject({
        searchProvider: 'deepseek-official',
        fetchProvider: CODEX_FETCH_PROVIDER_ID,
      }))

      // Direct mode takes the proxy away, and the built-in provider gets the tool back.
      await ctx.settings.update(namespace, { proxyMode: 'direct' })
      await vi.waitFor(() => expect(webConfig()).toMatchObject({ fetchProvider: 'http' }))

      await ctx.settings.update(namespace, { proxyMode: 'auto' })
      await vi.waitFor(() => expect(webConfig()).toMatchObject({ fetchProvider: CODEX_FETCH_PROVIDER_ID }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
