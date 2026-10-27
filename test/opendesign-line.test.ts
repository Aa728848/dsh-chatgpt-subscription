/**
 * The OpenDesign line mounted whole: the hub card and the picker must count the
 * same models.
 *
 * They used to be two calculations — the adapter had a private visibility rule and
 * the hub card read a copy in line.ts that knew nothing about the plan — so the
 * card could report models the picker refused to offer. Both now read
 * `openDesignVisibleModelIds`, and this file is what holds them to it.
 *
 * Nothing here reaches OpenDesign: the line is mounted over a fake context, the
 * settings live under the private `DSH_HOME` every test file gets, and fetch is a
 * double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { createOpenDesignLine } from '../src/host/opendesign/line.ts'
import { modelSettingsPath } from '../src/host/opendesign/token-store.ts'
import { DEFAULT_MODELS, PROVIDER_ID } from '../src/host/opendesign/types.ts'

const disposers: Array<() => void> = []

beforeEach(async () => {
  // One store per file under the shared private home: a leftover document from a
  // previous case would answer this one.
  await fs.rm(modelSettingsPath(), { force: true })
})

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.unstubAllGlobals()
})

function mountLine() {
  const adapters = new Map<string, LlmAdapter>()
  const routes: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  const ctx = {
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    inject: (_deps: string[], setup: (scope: Context) => void) => setup(ctx as unknown as Context),
    get: (name: string) => (name === 'llm' ? ctx.llm : name === 'webServer' ? ctx.webServer : name === 'attachments' ? {} : undefined),
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
    emit: vi.fn(),
    on: () => () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
  const line = createOpenDesignLine(ctx as unknown as Context, {
    fetchFn: (async () => new Response('{}')) as typeof fetch,
  })
  disposers.push(() => line.dispose())
  return { line, adapters, routes }
}

describe('OpenDesign line visibility', () => {
  it('mounts one adapter claim and one settings prefix', () => {
    const { line, adapters, routes } = mountLine()
    expect(adapters.get(PROVIDER_ID)).toBe(line.adapter)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/opendesign/api' })
  })

  it('counts the same models the picker offers before any scan', async () => {
    const { line } = mountLine()
    const summary = await line.hubSource.read()
    expect(summary.totalModelCount).toBe(DEFAULT_MODELS.length)
    expect(summary.enabledModelCount).toBe(DEFAULT_MODELS.length)
    expect(await line.adapter.listModels(PROVIDER_ID)).toHaveLength(DEFAULT_MODELS.length)
  })

  it('does not count a model the plan withholds, and counts it again once forced', async () => {
    const { line } = mountLine()
    await line.modelSettings.update({ servedModelIds: ['gpt-6-luna', 'kimi-k3'] })
    const withheld = await line.hubSource.read()
    // The plan knows 37 models and serves two: the card says two, and the picker
    // offers exactly those two — the number IS the list, not an estimate of it.
    expect(withheld.totalModelCount).toBe(DEFAULT_MODELS.length)
    expect(withheld.enabledModelCount).toBe(2)
    const listed = (await line.adapter.listModels(PROVIDER_ID)).map((model) => model.id)
    expect(listed).toEqual(['gpt-6-luna', 'kimi-k3'])
    expect(withheld.enabledModelCount).toBe(listed.length)

    await line.modelSettings.update({ forceVisibleModels: ['claude-sonnet-5.5'] })
    const forced = await line.hubSource.read()
    expect(forced.enabledModelCount).toBe(3)
    expect((await line.adapter.listModels(PROVIDER_ID)).map((model) => model.id)).toContain('claude-sonnet-5.5')
  })

  it('counts a hidden model out on both sides', async () => {
    const { line } = mountLine()
    await line.modelSettings.update({ hiddenModels: ['gpt-6-luna'] })
    const summary = await line.hubSource.read()
    expect(summary.enabledModelCount).toBe(DEFAULT_MODELS.length - 1)
    expect((await line.adapter.listModels(PROVIDER_ID)).map((model) => model.id)).not.toContain('gpt-6-luna')
  })
})
