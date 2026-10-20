/**
 * The Cline Pass settings API: envelope shape, account handling, pins,
 * visibility and the no-secret boundary.
 *
 * Nothing here reaches Cline: the engine is a double, the pool and credential
 * store are in-memory, and the model settings file lives in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { registerClinePassRoutes, type ClinePassRouteOptions } from '../src/host/cline-pass/routes.ts'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import { ClinePassModelSettingsStore, FileCredentialStore, type ClinePassCredentials } from '../src/host/cline-pass/token-store.ts'
import { createClinePassEngine } from './cline-pass-test-helpers.ts'
import { DEFAULT_MODELS } from '../src/host/cline-pass/types.ts'
import type { ClinePassWebStatus } from '../src/shared/cline-pass-contracts.ts'

interface Captured {
  status: number
  body: { ok: boolean; value?: unknown; error?: unknown }
  raw: string
}

function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: { ok: false }, raw: '' }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? ''
      if (raw !== undefined && raw !== '') captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

function fakeRequest(input: { url: string; method?: string; body?: unknown; origin?: string | null }): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin
  const chunks = input.method === 'POST' && input.body !== undefined ? [Buffer.from(JSON.stringify(input.body))] : []
  return {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  } as unknown as IncomingMessage
}

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

let dir = ''
let pool: ClinePassAccountPool
let settings: ClinePassModelSettingsStore
let store: ReturnType<typeof createClinePassStore>
let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
let emit: ReturnType<typeof vi.fn>
let dispose: () => void

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-pass-routes-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  pool = new ClinePassAccountPool({
    store: credential,
    backend: new MemoryBackend() as never,
  })
  settings = new ClinePassModelSettingsStore(path.join(dir, 'models.json'))
  store = createClinePassStore()
  const engine = createClinePassEngine({ pool, store, settings })
  const registrations: Array<{ kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }> = []
  emit = vi.fn()
  const ctx = {
    webServer: {
      register(options: { kind: string; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> }) {
        registrations.push(options)
        return () => undefined
      },
    },
    emit,
  } as unknown as Context
  const options: ClinePassRouteOptions = {
    settings,
    accountPool: pool,
    store,
    engine,
    fetchFn: (async () => new Response('{}')) as typeof fetch,
    serving: () => true,
    conflict: () => null,
  }
  dispose = registerClinePassRoutes(ctx, options)
  handler = registrations[0]!.handler
})

afterEach(async () => {
  dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

async function call(input: { url: string; method?: string; body?: unknown; origin?: string | null }): Promise<Captured> {
  const { response, captured } = fakeExchange()
  await handler(fakeRequest(input), response)
  return captured
}

describe('Cline Pass settings API', () => {
  it('serves the whole status the card renders', async () => {
    await pool.addAccount({ apiKey: 'sk-secret', alias: 'main' })
    const captured = await call({ url: '/cline-pass/api/status' })
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
    const status = captured.body.value as ClinePassWebStatus
    expect(status.providerId).toBe('cline-pass')
    expect(status.pool.accounts).toHaveLength(1)
    expect(status.authenticated).toBe(true)
    expect(status.models).toHaveLength(DEFAULT_MODELS.length)
    // No credential ever crosses this boundary.
    expect(captured.raw).not.toContain('sk-secret')
  })

  it('adds an account through the shared pool and never returns its key', async () => {
    const captured = await call({
      url: '/cline-pass/api/accounts',
      method: 'POST',
      body: { action: 'add', apiKey: 'sk-new', alias: 'backup' },
    })
    expect(captured.status).toBe(200)
    const status = captured.body.value as ClinePassWebStatus
    expect(status.pool.accounts.map((account) => account.alias)).toContain('backup')
    expect(captured.raw).not.toContain('sk-new')
  })

  it('persists a pin and reports it on the next status read', async () => {
    const model = DEFAULT_MODELS[0]!
    const captured = await call({
      url: '/cline-pass/api/models/pin',
      method: 'POST',
      body: { model, upstreams: ['baseten'], exclude: ['deepseek'], pinMode: 'preferred', sort: 'cost' },
    })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { pin: { upstreams: string[]; pinMode: string }; status: ClinePassWebStatus }
    expect(value.pin).toMatchObject({ upstreams: ['baseten'], pinMode: 'preferred' })
    const status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.find((entry) => entry.id === model)?.pinned).toEqual(['baseten'])
  })

  it('shows and hides models without forgetting them', async () => {
    const model = DEFAULT_MODELS[0]!
    await call({ url: '/cline-pass/api/models/visibility', method: 'POST', body: { model, visible: false } })
    let status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.find((entry) => entry.id === model)?.enabled).toBe(false)
    // The id is still listed, so un-hiding is one click rather than a resync.
    expect(status.models.some((entry) => entry.id === model)).toBe(true)
    await call({ url: '/cline-pass/api/models/visibility-all', method: 'POST', body: { mode: 'all' } })
    status = (await call({ url: '/cline-pass/api/status' })).body.value as ClinePassWebStatus
    expect(status.models.every((entry) => entry.enabled)).toBe(true)
  })

  it('refuses an invalid settings value and stores a valid one', async () => {
    const invalid = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { defaultContextWindow: -1 },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.ok).toBe(false)
    const valid = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { baseURL: 'https://example.test/api/v1', defaultContextWindow: 200_000 },
    })
    expect(valid.status).toBe(200)
    expect((await settings.read()).baseURL).toBe('https://example.test/api/v1')
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
  })

  it('rejects a cross-origin mutation', async () => {
    const captured = await call({
      url: '/cline-pass/api/settings',
      method: 'POST',
      body: { enabled: false },
      origin: 'https://evil.test',
    })
    expect(captured.status).toBe(403)
    expect(captured.body.ok).toBe(false)
  })

  it('answers method and path refusals in the same envelope', async () => {
    expect((await call({ url: '/cline-pass/api/settings' })).status).toBe(405)
    expect((await call({ url: '/cline-pass/api/nope' })).status).toBe(404)
  })

  it('serves the in-process history newest first', async () => {
    store.record({ model: 'cline-pass/glm-5.3', provider: 'baseten', account: 'main', ms: 120, ttft: 20, stream: true })
    const captured = await call({ url: '/cline-pass/api/history?limit=10' })
    expect(captured.status).toBe(200)
    const value = captured.body.value as { total: number; entries: Array<{ model: string; provider: string }> }
    expect(value.total).toBe(1)
    expect(value.entries[0]).toMatchObject({ model: 'cline-pass/glm-5.3', provider: 'baseten' })
  })
})
