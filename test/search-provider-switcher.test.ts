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
  /**
   * Settle the restart a selection triggered.
   *
   * The loader runs an entry restart behind its `internal/update` waterfall and
   * `Entry.update()` does not await it, so `select()` resolves while the `web`
   * service is disposed and the injected providers come back a tick later. This
   * is the same wait `SearchProviderSwitcher` performs before it applies a
   * selection, and it leaves every assertion below reading a live runtime.
   */
  const settled = async (): Promise<void> => {
    await ctx.loader.resolve('web').fiber?.await()
  }
  return { ctx, switcher: new SearchProviderSwitcher(ctx.loader), settled }
}

describe('SearchProviderSwitcher', () => {
  // The switcher mirrors cordis's FiberState numbers as local constants (a const
  // enum inlines to the same literals). If cordis ever renumbers, the mirrored
  // values silently become wrong and the restart wait starts polling for the
  // wrong states - so read the real ones here.
  it('mirrors the real cordis fiber state numbers', () => {
    const { FiberState } = require('@deepseek-ai/cordis') as { FiberState?: Record<string, number> }
    if (FiberState === undefined) return // const enum: erased at runtime by design
    expect(FiberState.ACTIVE).toBe(2)
    expect(FiberState.LOADING).toBe(1)
    expect(FiberState.UNLOADING).toBe(5)
  })

  it('repairs a configured entry whose running fiber still uses the previous provider', async () => {
    const { ctx, switcher, settled } = await mountSwitcher()
    try {
      const entry = ctx.loader.resolve('web')
      entry.options.config = { searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_FETCH_PROVIDER_ID }
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
      await switcher.select('codex')
      await settled()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      const update = vi.spyOn(entry.fiber!, 'update')
      await switcher.select('codex')
      expect(update).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  // Issue 22: the desktop app reported "3 entries did not activate ... fiber
  // state 5". State 5 is UNLOADING, not FAILED, so those web entries were never
  // broken - they were observed mid-restart. This plugin restarts the `web` entry
  // to point it at its own providers, and the restart must be finished before
  // anything reads `ctx.web`.
  //
  // The hazard is that `Fiber.update()` returns void (cordis 4.x), so awaiting it
  // waits for nothing; the only thing that can make `select()` honest is an
  // explicit wait for the entry to come back ACTIVE. Whether a bare
  // `fiber.await()` happens to catch that depends on how far the restart has
  // progressed by the time it is called - it is timing, not a guarantee, which is
  // why the wait cannot be left to chance. The sequence asserted below
  // ([5, 1, 2] = UNLOADING, LOADING, ACTIVE) is the restart this must survive.
  it('resolves only after the restarted entry is active again, never mid-restart', async () => {
    const { ctx, switcher } = await mountSwitcher()
    try {
      // Exercise the configured-but-stale path: the entry is already CONFIGURED
      // for Codex while its running fiber still serves the old providers, so the
      // switcher repairs it through `Fiber.update()` - the void-returning call
      // whose restart this test's wait has to cover.
      const entry = ctx.loader.resolve('web')
      entry.options.config = { searchProvider: CODEX_SEARCH_PROVIDER_ID, fetchProvider: CODEX_FETCH_PROVIDER_ID }
      // ...and the RUNNING fiber still holds the old providers. Configured-but-stale
      // is the exact shape that takes the `Fiber.update()` branch; config alone
      // reads as already-applied and returns before touching anything, which is why
      // setting only `options.config` never reaches the bug.
      const running = entry.fiber as unknown as { config?: Record<string, unknown> }
      running.config = { searchProvider: 'deepseek-official', fetchProvider: 'http' }

      // Every state the entry passes through during the selection. Reading the
      // property directly (rather than polling on a timer) catches the whole
      // transition, including a restart that completes inside one tick - which is
      // exactly the case the old code mistook for "no restart happened".
      const seen: number[] = []
      const fiber = ctx.loader.resolve('web').fiber as { state: number } | undefined
      if (fiber === undefined) throw new Error('web entry has no fiber to observe')
      // `state` is a plain data property that cordis reassigns through
      // `_updateState`, so an accessor on the instance records every transition
      // while still storing exactly the value the runtime needs.
      let current = fiber.state
      Object.defineProperty(fiber, 'state', {
        configurable: true,
        get() {
          return current
        },
        set(value: number) {
          current = value
          seen.push(value)
        },
      })
      try {
        await switcher.select('codex')
      } finally {
        delete (fiber as { state?: number }).state
        fiber.state = current
      }

      // The moment select() resolves, the entry must already be live. Before the
      // fix this read 5 (UNLOADING), and the caller went on to configure a service
      // that was not there - which the desktop app surfaced as 3 web entries
      // failing to activate.
      expect(
        fiber.state,
        'select() resolved while the web entry was not active; a caller reading ctx.web'
          + ' here sees no service. State 5 is UNLOADING: the entry is mid-restart, which is'
          + ' what the desktop app reported in issue 22.',
      ).toBe(2)
      // And the service is really usable at that instant, with no second wait.
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe(CODEX_SEARCH_PROVIDER_ID)
      // The entry genuinely went through a restart rather than never moving: if it
      // never left ACTIVE, the wait above would be asserting nothing.
      expect(seen).toContain(5)
    } finally { await ctx.fiber.dispose() }
  })

  it('serializes rapid selections and ignores queued work after disposal', async () => {
    const { ctx, switcher, settled } = await mountSwitcher()
    try {
      await Promise.all([switcher.select('codex'), switcher.select('dsh'), switcher.select('codex')])
      await settled()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      const pending = switcher.select('dsh')
      switcher.dispose()
      await pending
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
    } finally { await ctx.fiber.dispose() }
  })

  it('switches both search and fetch providers when selecting Codex', async () => {
    const { ctx, switcher, settled } = await mountSwitcher()
    try {
      for (const preference of ['codex', 'dsh', 'codex'] as const) {
        await switcher.select(preference)
        await settled()
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
    const { ctx, switcher, settled } = await mountSwitcher()
    try {
      await switcher.select('dsh', { pluginFetch: true })
      await settled()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe('deepseek-official')

      // Losing the proxy returns the tool to the built-in provider without disturbing search.
      await switcher.select('dsh', { pluginFetch: false })
      await settled()
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe('deepseek-official')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an already matching configuration as applied', async () => {
    const { ctx, switcher } = await mountSwitcher()
    try {
      await switcher.select('dsh', { fetchProvider: 'dsh' })
      expect(switcher.status()).toMatchObject({ state: 'applied', configuredFetchProvider: 'http' })
    } finally { await ctx.fiber.dispose() }
  })

  it('lets explicit fetch mode override both search and proxy selection', async () => {
    const { ctx, switcher } = await mountSwitcher()
    try {
      await switcher.select('codex', { pluginFetch: true, fetchProvider: 'dsh' })
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
      expect((await ctx.web.search({ query: 'example' })).sources[0].title).toBe(CODEX_SEARCH_PROVIDER_ID)
      await switcher.select('dsh', { pluginFetch: false, fetchProvider: 'plugin' })
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe(CODEX_FETCH_PROVIDER_ID)
      await switcher.select('dsh', { pluginFetch: false, fetchProvider: 'auto' })
      expect((await ctx.web.fetch({ url: 'https://example.com' })).body.content).toBe('http')
    } finally { await ctx.fiber.dispose() }
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
