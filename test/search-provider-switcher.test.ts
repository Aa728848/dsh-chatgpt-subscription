import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import { CODEX_FETCH_PROVIDER_ID, CODEX_SEARCH_PROVIDER_ID } from '../src/compat.ts'
import { SearchProviderSwitcher } from '../src/host/search-provider-switcher.ts'

describe('SearchProviderSwitcher', () => {
  it('switches both search and fetch providers when selecting Codex', async () => {
    const ctx = new Context()
    try {
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
      const switcher = new SearchProviderSwitcher(ctx.loader)

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
})
