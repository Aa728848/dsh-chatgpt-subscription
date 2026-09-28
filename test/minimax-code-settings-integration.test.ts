import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { MinimaxCodeCredentialStore, MinimaxCodeModelSettingsStore } from '../src/host/minimax-code/token-store.ts'
import { MinimaxCodeAccountPool, parseMinimaxCodePoolData } from '../src/host/minimax-code/account-pool.ts'
import { getMinimaxCodeWebStatus, registerMinimaxCodeRoutes } from '../src/host/minimax-code/routes.ts'

/** Mirrors the platform pool backends: JSON, with the parse hook applied on read. */
class PoolBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : parseMinimaxCodePoolData(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function request(input: { url: string; method?: string; body?: unknown }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const req = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  } as unknown as IncomingMessage
  if (input.method === 'POST') {
    queueMicrotask(() => {
      if (input.body !== undefined) listeners.get('data')?.forEach((l) => l(Buffer.from(JSON.stringify(input.body))))
      listeners.get('end')?.forEach((l) => l())
    })
  }
  return req
}

function exchange(): { response: ServerResponse; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

let dshHome = ''
let minimaxHome = ''

beforeEach(async () => {
  dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mm-integ-'))
  // An EMPTY MiniMax home, so no test reads the developer's real ~/.minimax.
  minimaxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mm-native-'))
  process.env.DSH_HOME = dshHome
  process.env.MINIMAX_HOME = minimaxHome
})

afterEach(async () => {
  delete process.env.DSH_HOME
  delete process.env.MINIMAX_HOME
  // Name the files, then rmdir deepest-first: a recursive delete follows a
  // junction into its target, so it is never used here.
  const files = [
    path.join(dshHome, 'storages', 'minimax-code-credentials.json'),
    path.join(dshHome, 'storages', 'minimax-code-models.json'),
  ]
  for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined)
  const directories = [
    path.join(dshHome, 'storages'),
    dshHome,
    minimaxHome,
  ]
  for (const directory of directories) await fs.rmdir(directory).catch(() => undefined)
})

function harness(pool?: MinimaxCodeAccountPool) {
  const store = new MinimaxCodeCredentialStore()
  const settings = new MinimaxCodeModelSettingsStore()
  const routes: Array<{ path: string; handler: (r: IncomingMessage, s: ServerResponse) => Promise<void> }> = []
  const ctx = {
    webServer: { register(route: { path: string; handler: unknown }) { routes.push(route as never); return () => undefined } },
    logger: { warn() {}, info() {} },
    emit() {},
  } as unknown as Context
  const dispose = registerMinimaxCodeRoutes(ctx, store, { accountPool: pool }, settings)
  return { store, settings, handler: routes[0]!.handler, dispose }
}

function poolFor(store: MinimaxCodeCredentialStore): MinimaxCodeAccountPool {
  return new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
}

describe('MiniMax Code settings surface', () => {
  it('exposes the enable flag, model rows and settings fields on /status', async () => {
    const { handler } = harness()
    const { response, captured } = exchange()
    await handler(request({ url: '/minimax-code/api/status' }), response)
    expect(captured.status).toBe(200)
    expect(captured.body.value.enabled).toBe(true)
    expect(captured.body.value.models.length).toBeGreaterThan(0)
    expect(captured.body.value.models[0]).toHaveProperty('contextWindow')
    expect(captured.body.value.models[0]).toHaveProperty('enabled')
    expect(captured.body.value.contextWindowOverrides).toEqual({})
    expect(captured.body.value.defaultReasoningEffort).toBeNull()
    // No credential may cross this boundary.
    expect(JSON.stringify(captured.body)).not.toMatch(/accessToken|refreshToken/)
  })

  it('narrows the selection through /models', async () => {
    const { handler } = harness()
    const narrowed = exchange()
    await handler(request({
      url: '/minimax-code/api/models',
      method: 'POST',
      body: { enabledModelIds: ['MiniMax-M3'] },
    }), narrowed.response)
    expect(narrowed.captured.body.value.models.filter((m: any) => m.enabled).map((m: any) => m.id))
      .toEqual(['MiniMax-M3'])
  })

  it('turns the whole line off, which reports every model as unoffered', async () => {
    const { handler } = harness()
    const off = exchange()
    await handler(request({ url: '/minimax-code/api/settings', method: 'POST', body: { enabled: false } }), off.response)
    expect(off.captured.body.value.enabled).toBe(false)
    // The card greys every row out while the line is off, matching the sibling
    // lines: "off" has to mean no model is offered, including the ticked ones.
    expect(off.captured.body.value.models.every((m: any) => m.enabled === false)).toBe(true)
    // The rows are still returned, or the card could not show what to re-enable.
    expect(off.captured.body.value.models.length).toBeGreaterThan(0)

    // And the switch can be turned back on.
    const on = exchange()
    await handler(request({ url: '/minimax-code/api/settings', method: 'POST', body: { enabled: true } }), on.response)
    expect(on.captured.body.value.enabled).toBe(true)
  })

  it('applies a context-window override, reports it, and restores the default on null', async () => {
    const { handler } = harness()
    const override = exchange()
    await handler(request({
      url: '/minimax-code/api/settings',
      method: 'POST',
      body: { contextWindowOverrides: { 'MiniMax-M3': 1_000_000 } },
    }), override.response)
    const m3 = override.captured.body.value.models.find((m: any) => m.id === 'MiniMax-M3')
    expect(m3.contextWindow).toBe(1_000_000)
    expect(override.captured.body.value.contextWindowOverrides['MiniMax-M3']).toBe(1_000_000)

    // null is the card's "restore the catalog default": it must delete the key,
    // not persist a zero.
    const reset = exchange()
    await handler(request({
      url: '/minimax-code/api/settings',
      method: 'POST',
      body: { contextWindowOverrides: { 'MiniMax-M3': null } },
    }), reset.response)
    expect(reset.captured.body.value.contextWindowOverrides['MiniMax-M3']).toBeUndefined()
  })

  it('rejects a cross-origin settings mutation', async () => {
    const { handler } = harness()
    const { response, captured } = exchange()
    const req = request({ url: '/minimax-code/api/settings', method: 'POST', body: { enabled: false } })
    ;(req as unknown as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3000', origin: 'http://evil.test' }
    await handler(req, response)
    expect(captured.status).toBe(403)
  })

  it('reports poolInstalled false without a pool, rather than looking broken', async () => {
    const status = await getMinimaxCodeWebStatus(new MinimaxCodeCredentialStore())
    expect(status.poolInstalled).toBe(false)
    expect(status.accounts).toEqual([])
  })
})

describe('MiniMax Code pool integration', () => {
  it('reports the pool slice on /status and answers /accounts under the same prefix', async () => {
    const store = new MinimaxCodeCredentialStore()
    const { handler } = harness(poolFor(store))

    const status = exchange()
    await handler(request({ url: '/minimax-code/api/status' }), status.response)
    expect(status.captured.body.value.poolInstalled).toBe(true)
    expect(Array.isArray(status.captured.body.value.accounts)).toBe(true)

    const accounts = exchange()
    await handler(request({ url: '/minimax-code/api/accounts' }), accounts.response)
    expect(accounts.captured.status).toBe(200)
    expect(accounts.captured.body.value.poolInstalled).toBe(true)
    expect(accounts.captured.body.value.rotationStrategy).toBe('sequential')
  })

  it('answers an unknown account action with 400 rather than a silent success', async () => {
    const { handler } = harness(poolFor(new MinimaxCodeCredentialStore()))
    const { response, captured } = exchange()
    await handler(request({ url: '/minimax-code/api/accounts', method: 'POST', body: { action: 'nope' } }), response)
    expect(captured.status).toBe(400)
  })

  it('refuses a cross-origin account mutation', async () => {
    const { handler } = harness(poolFor(new MinimaxCodeCredentialStore()))
    const { response, captured } = exchange()
    const req = request({ url: '/minimax-code/api/accounts', method: 'POST', body: { action: 'delete', accountId: 'a' } })
    ;(req as unknown as { headers: Record<string, string> }).headers = { host: '127.0.0.1:3000', origin: 'http://evil.test' }
    await handler(req, response)
    expect(captured.status).toBe(403)
  })
})
