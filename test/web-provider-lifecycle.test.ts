import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { WebError, WebRuntime } from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import * as platformStore from '../src/host/platform-token-store.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { PREFERENCES_NAMESPACE } from '../src/shared/preferences.ts'

const namespace = settingsNamespace(PREFERENCES_NAMESPACE)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('web provider lifecycle', () => {
  it.each(['dsh', 'codex'] as const)('keeps fetch switching across web reloads with %s initially selected', async (initial) => {
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      protected async load() {
        return { [namespace]: { searchProvider: initial, proxyMode: 'direct' } }
      }
      protected async persist() {}
    }

    const store = vi.spyOn(platformStore, 'createPlatformTokenStore').mockReturnValue(new MemoryTokenStore())
    const fetchFn = vi.fn(async () => new Response('plugin page', { headers: { 'content-type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetchFn)
    const ctx = new Context()
    try {
      ctx.provide('webServer', { host: '127.0.0.1', port: 3000, register: () => () => undefined })
      ctx.provide('llm', { registerAdapter: () => () => undefined })
      ctx.provide('attachments', {})
      ctx.provide('tools', { register: () => () => undefined })
      await ctx.plugin(Loader).await()
      await ctx.plugin(MemorySettings).await()
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
})
