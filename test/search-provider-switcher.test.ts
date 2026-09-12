import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../src/compat.ts'
import { SearchProviderSwitcher } from '../src/host/search-provider-switcher.ts'

/** A loader with the two registered backends per capability, as a real profile mounts them. */
async function mountSwitcher() {
  const ctx = new Context()
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.web = WebRuntime
  await ctx.loader.root.update([{
    id: 'web', name: 'cordis:web',
    config: { searchProvider: 'deepseek-official', fetchProvider: 'http' },
  }])
  const providers = ctx.inject(['web'], ctx => {
    for (const id of ['http', CODEX_FETCH_PROVIDER_ID]) {
      ctx.web.registerFetchProvider({
        id, available: () => true,
        fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: id }, truncated: false }),
      })
    }
    for (const id of ['deepseek-official', CODEX_SEARCH_PROVIDER_ID]) {
      ctx.web.registerSearchProvider({
        id, available: () => true,
        search: async () => ({ sources: [{ title: id, url: 'https://example.com' }], truncated: false }),
      })
    }
  })
  await providers.await()
  return { ctx, switcher: new SearchProviderSwitcher(ctx.loader), providers }
}

describe('SearchProviderSwitcher', () => {
  it('repairs a configured entry whose running fiber still uses the previous provider', async () => {
    const { ctx, switcher, providers } = await mountSwitcher()
    try {
      const entry = ctx.loader.resolve('web')
      entry.options.config = { searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_FETCH_PROVIDER_ID }
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
      await switcher.select('codex')
      await providers.await()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      const update = vi.spyOn(entry.fiber!, 'update')
      await switcher.select('codex')
      expect(update).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('serializes rapid selections and ignores queued work after disposal', async () => {
    const { ctx, switcher, providers } = await mountSwitcher()
    try {
      await Promise.all([switcher.select('codex'), switcher.select('dsh'), switcher.select('codex')])
      await providers.await()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      const pending = switcher.select('dsh')
      switcher.dispose()
      await pending
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
    } finally { await ctx.fiber.dispose() }
  })

  it('switches both search and fetch providers when selecting Codex', async () => {
    const { ctx, switcher, providers } = await mountSwitcher()
    try {
      for (const preference of ['codex', 'dsh', 'codex'] as const) {
        await switcher.select(preference)
        await providers.await()
        expect(ctx.loader.resolve('web').options).toMatchObject({ id: 'web', name: 'cordis:web' })
        expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content)
          .toBe(preference === 'codex' ? CODEX_FETCH_PROVIDER_ID : 'http')
        expect((await ctx.web.search({ query: 'example' })).sources[0].title)
          .toBe(preference === 'codex' ? CODEX_SEARCH_PROVIDER_ID : 'deepseek-official')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hands the fetch tool to this plugin while a proxy makes the built-in provider unusable', async () => {
    const { ctx, switcher, providers } = await mountSwitcher()
    try {
      await switcher.select('dsh', { pluginFetch: true })
      await providers.await()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe('deepseek-official')

      // Losing the proxy returns the tool to the built-in provider without disturbing search.
      await switcher.select('dsh', { pluginFetch: false })
      await providers.await()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe('deepseek-official')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports configuration without inventing defaults or exposing raw errors', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader).await()
    ctx.loader.builtins.web = WebRuntime
    await ctx.loader.root.update([{ id: 'web', name: 'cordis:web', config: {} }])
    const switcher = new SearchProviderSwitcher(ctx.loader)
    try {
      await switcher.select('codex')
      expect(switcher.status()).toEqual({ state: 'applied', configuredSearchProvider: CODEX_SEARCH_PROVIDER_ID, configuredFetchProvider: CODEX_FETCH_PROVIDER_ID })
      await switcher.select('dsh')
      expect(switcher.status()).toEqual({ state: 'applied', configuredSearchProvider: null, configuredFetchProvider: null })
      expect(ctx.loader.resolve('web').options.config).toEqual({})
    } finally { await ctx.fiber.dispose() }
  })

  it('redacts configuration and exceptions when an update fails', async () => {
    const { ctx, switcher } = await mountSwitcher()
    try {
      const entry = ctx.loader.resolve('web')
      entry.options.config = { fetchProvider: 'https://user:secret@example.com/private', secret: 'hidden' }
      vi.spyOn(entry, 'update').mockRejectedValue(new Error('credential-secret'))
      await expect(switcher.select('codex')).rejects.toThrow('credential-secret')
      expect(switcher.status()).toEqual({ state: 'failed', configuredSearchProvider: null, configuredFetchProvider: null })
    } finally { await ctx.fiber.dispose() }
  })

  it('reports a missing Web entry without exposing unrelated configuration', async () => {
    const switcher = new SearchProviderSwitcher({ entries: () => [] })
    await switcher.select('codex')
    expect(switcher.status()).toEqual({ state: 'missing', configuredSearchProvider: null, configuredFetchProvider: null })
  })
})
