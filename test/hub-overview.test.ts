import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { registerHubOverviewRoutes, type HubSummarySource } from '../src/host/hub-overview.ts'
import { HUB_OVERVIEW_PATH } from '../src/shared/hub-contracts.ts'
import type { HubOverviewDto } from '../src/shared/hub-contracts.ts'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })))
})

function mount(sources: readonly HubSummarySource[]): { origin: Promise<string> } {
  let handler: http.RequestListener | undefined
  const ctx = {
    webServer: {
      register(route: { kind: string; path: string; handler: http.RequestListener }) {
        expect(route).toMatchObject({ kind: 'exact', path: HUB_OVERVIEW_PATH })
        handler = route.handler
        return () => undefined
      },
    },
  }
  const dispose = registerHubOverviewRoutes(ctx as never, sources)
  expect(dispose).toBeTypeOf('function')
  return {
    origin: new Promise((resolveListen) => {
      const server = http.createServer((request, response) => void handler!(request, response))
      servers.push(server)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('no address')
        resolveListen(`http://127.0.0.1:${address.port}`)
      })
    }),
  }
}

function source(id: string, overrides: Partial<HubSummarySource> = {}, read?: HubSummarySource['read']): HubSummarySource {
  return {
    id,
    providerId: `${id}-provider`,
    canToggle: true,
    read: read ?? (async () => ({
      enabled: true,
      accountCount: 2,
      authenticated: true,
      enabledModelCount: 3,
      totalModelCount: 8,
    })),
    ...overrides,
  }
}

describe('hub overview route', () => {
  it('answers one aggregated, read-only summary of every line', async () => {
    const { origin } = mount([source('chatgpt'), source('ollama', { canToggle: false })])
    const response = await fetch(`${await origin}${HUB_OVERVIEW_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { ok: true; value: HubOverviewDto }
    expect(body.ok).toBe(true)
    expect(body.value.providers.map((provider) => provider.id)).toEqual(['chatgpt', 'ollama'])
    const ollama = body.value.providers[1]!
    expect(ollama.canToggle).toBe(false)
    expect(ollama.accountCount).toBe(2)
    expect(ollama.enabledModelCount).toBe(3)
    expect(ollama.totalModelCount).toBe(8)
    expect(ollama.error).toBeUndefined()
    // The overview carries no credentials: only the summary fields exist.
    expect(Object.keys(ollama).sort()).toEqual([
      'accountCount', 'authenticated', 'canToggle', 'enabled', 'enabledModelCount', 'id', 'providerId', 'totalModelCount',
    ])
  })

  it('degrades a failing line to a marked placeholder instead of failing the overview', async () => {
    const { origin } = mount([
      source('chatgpt'),
      source('kimi-code', {}, async () => { throw new Error('store unreadable') }),
    ])
    const response = await fetch(`${await origin}${HUB_OVERVIEW_PATH}`)
    const body = await response.json() as { ok: true; value: HubOverviewDto }
    expect(body.ok).toBe(true)
    const [chatgpt, kimi] = body.value.providers
    expect(chatgpt!.error).toBeUndefined()
    expect(kimi).toMatchObject({
      id: 'kimi-code',
      providerId: 'kimi-code-provider',
      canToggle: true,
      enabled: false,
      accountCount: 0,
      authenticated: false,
      enabledModelCount: null,
      totalModelCount: null,
      error: true,
    })
  })

  it('keeps a switchless line reported as enabled when its own store cannot be read', async () => {
    // `enabled` is false only where a switch exists to be off: a line without one
    // is always servable, and the failure is what `error` is for.
    const { origin } = mount([source('ollama', { canToggle: false }, async () => { throw new Error('unreadable') })])
    const body = await (await fetch(`${await origin}${HUB_OVERVIEW_PATH}`)).json() as { value: HubOverviewDto }
    expect(body.value.providers[0]).toMatchObject({ id: 'ollama', canToggle: false, enabled: true, error: true })
  })

  it('answers only GET, so the read-only route never looks like a mutation', async () => {
    const { origin } = mount([source('chatgpt')])
    const base = await origin
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${base}${HUB_OVERVIEW_PATH}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    }
  })

  it('reads every line concurrently, so one slow line does not serialize the page', async () => {
    let slowStarted = 0
    const slow: HubSummarySource['read'] = async () => {
      slowStarted++
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { enabled: true, accountCount: 1, authenticated: true, enabledModelCount: null, totalModelCount: null }
    }
    const { origin } = mount([source('chatgpt', {}, slow), source('claude', {}, slow)])
    const started = Date.now()
    const response = await fetch(`${await origin}${HUB_OVERVIEW_PATH}`)
    expect(response.status).toBe(200)
    expect(slowStarted).toBe(2)
    // Two 60ms reads in parallel land well under their serialized 120ms.
    expect(Date.now() - started).toBeLessThan(120)
  })
})
