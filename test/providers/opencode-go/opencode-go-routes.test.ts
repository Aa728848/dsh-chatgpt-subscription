import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerOpenCodeGoRoutes } from '../../../src/host/providers/opencode-go/routes.ts'
import { OpenCodeGoAccountPool } from '../../../src/host/providers/opencode-go/account-pool.ts'
import { OpenCodeGoCatalogManager } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import { OpenCodeGoSettingsStore } from '../../../src/host/providers/opencode-go/token-store.ts'
import { credential, memoryBackend } from './helpers.ts'

const rawModels = [{ id: 'deepseek-v4.1-flash', type: 'chat', name: 'DeepSeek', capabilities: { tools: { supported: true }, reasoning: { effort: ['low', 'high'] } }, modalities: { input: ['text'] }, limit: { context: 100000, output: 1000 } }]
const usage = { rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-25T12:00:00Z' }, weekly: { status: 'ok', percent: 2, resetsAt: '2026-11-30T00:00:00Z' }, monthly: { status: 'ok', percent: 3, resetsAt: '2026-12-25T00:00:00Z' } }

describe('OpenCode Go routes', () => {
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let settingsStore: OpenCodeGoSettingsStore
  let filePath: string
  beforeEach(() => { filePath = path.join(tmpdir(), 'opencode-go-' + randomUUID() + '.json'); settingsStore = new OpenCodeGoSettingsStore(filePath) })
  afterEach(async () => { await fs.unlink(filePath).catch(() => undefined) })

  function setup(fetchFn: typeof fetch): { emit: ReturnType<typeof vi.fn> } {
    const emit = vi.fn()
    const ctx = { emit, webServer: { register: (route: { handler: typeof handler }) => { handler = route.handler; return () => undefined } } } as unknown as Context
    registerOpenCodeGoRoutes(ctx, new OpenCodeGoAccountPool({ backend: memoryBackend() }), settingsStore, new OpenCodeGoCatalogManager(), { fetchFn })
    return { emit }
  }

  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
    request.method = method
    request.url = url
    request.headers = { host: 'dsh.local', origin: 'http://dsh.local' }
    let status = 0
    let text = ''
    const response = { writeHead(code: number) { status = code }, end(chunk: string) { text = chunk } } as unknown as ServerResponse
    await handler(request, response)
    return { status, json: text === '' ? null : JSON.parse(text) }
  }

  it('adds a verified key without returning it, refreshes models and reads all quota windows', async () => {
    const { emit } = setup(async (url) => {
      if (url.toString().endsWith('/v1/models')) return new Response(JSON.stringify({ data: rawModels }), { status: 200 })
      if (url.toString().endsWith('/v1/usage')) return new Response(JSON.stringify({ usage }), { status: 200 })
      throw new Error('unexpected ' + url)
    })
    const added = await call('POST', '/opencode-go/api/accounts', { apiKey: 'oc_sk_secret' })
    expect(added.status).toBe(200)
    expect(JSON.stringify(added.json)).not.toContain('oc_sk_secret')
    const refreshed = await call('POST', '/opencode-go/api/models/refresh')
    expect(refreshed.json.value.models).toHaveLength(1)
    const quota = await call('POST', '/opencode-go/api/quota/refresh')
    expect(quota.json.value.accounts[0].quota.windows).toHaveLength(3)
    expect(emit).toHaveBeenCalledWith('llm/adapters-updated')
  })

  it('applies model settings and runs an explicit connection test', async () => {
    setup(async (url) => {
      if (url.toString().endsWith('/v1/models')) return new Response(JSON.stringify({ data: rawModels }), { status: 200 })
      if (url.toString().endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
      throw new Error('unexpected ' + url)
    })
    await call('POST', '/opencode-go/api/accounts', { apiKey: 'oc_sk_secret' })
    await call('POST', '/opencode-go/api/models/refresh')
    const updated = await call('POST', '/opencode-go/api/settings', { enabledModelIds: [], defaultReasoningEffort: 'low' })
    expect(updated.json.value.models[0].enabled).toBe(false)
    expect(updated.json.value.defaultReasoningEffort).toBe('low')
    const connection = await call('POST', '/opencode-go/api/connection/test')
    expect(connection.json.value.connected).toBe(true)
    expect(connection.json.value.model).toBe('deepseek-v4.1-flash')
  })

  it('rejects cross-origin mutation', async () => {
    setup(async () => new Response('{}'))
    const request = Readable.from([Buffer.from(JSON.stringify({ apiKey: 'x' }))]) as IncomingMessage
    request.method = 'POST'
    request.url = '/opencode-go/api/accounts'
    request.headers = { host: 'dsh.local', origin: 'https://evil.example' }
    let status = 0
    const response = { writeHead(code: number) { status = code }, end() {} } as unknown as ServerResponse
    await handler(request, response)
    expect(status).toBe(403)
  })
})
