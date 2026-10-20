/**
 * The Cline Pass request loop: a pinned channel is abandoned only before the
 * first delivered chunk, and the next candidate serves the turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ClinePassAdapter } from '../src/host/cline-pass/adapter.ts'
import { ClinePassAccountPool } from '../src/host/cline-pass/account-pool.ts'
import { createClinePassStore } from '../src/host/cline-pass/store.ts'
import { ClinePassModelSettingsStore, FileCredentialStore, type ClinePassCredentials } from '../src/host/cline-pass/token-store.ts'
import { createClinePassEngine } from './cline-pass-test-helpers.ts'
import { POOL_COOLDOWN_MS } from '../src/host/cline-pass/types.ts'

const MODEL = 'cline-pass/glm-5.3'
const SSE_OK = [
  'data: {"choices":[{"delta":{"content":"hello"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
  'data: [DONE]',
  '',
].join('\n\n')

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
let calls: Array<Record<string, unknown>>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-pass-adapter-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  pool = new ClinePassAccountPool({ store: credential, backend: new MemoryBackend() as never })
  settings = new ClinePassModelSettingsStore(path.join(dir, 'models.json'))
  store = createClinePassStore()
  calls = []
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function adapterWith(fetchFn: typeof fetch): ClinePassAdapter {
  const engine = createClinePassEngine({ pool, store, settings })
  // The test's fetch is the whole transport; the engine's own seam is replaced
  // through the adapter's engine, so one double answers both probe and request.
  ;(engine as unknown as { options: { fetchFn: typeof fetch } }).options.fetchFn = fetchFn
  return new ClinePassAdapter(engine, store, settings, pool)
}

describe('ClinePassAdapter', () => {
  it('fails over from a refused pinned channel before the first chunk', async () => {
    await pool.addAccount({ apiKey: 'sk-a', alias: 'main' })
    await settings.setPin(MODEL, { upstreams: ['baseten', 'deepseek'], exclude: [], pinMode: 'strict', sort: '' })
    await settings.update({ enabledModelIds: [MODEL] })
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push(body)
      const provider = body.provider as { only?: string[] } | undefined
      if (provider?.only?.includes('baseten')) {
        return Response.json({ error: { message: 'provider refused the pin' } }, { status: 429 })
      }
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const adapter = adapterWith(fetchFn)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'cline-pass',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: undefined,
    } as never)) chunks.push(chunk)

    expect(calls).toHaveLength(2)
    expect((calls[0]?.provider as { only: string[] }).only).toEqual(['baseten'])
    expect((calls[1]?.provider as { only: string[] }).only).toEqual(['deepseek'])
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text)).toEqual(['hello'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // The history names both attempts, so a failover is visible after the fact.
    const history = store.readHistory(5)
    expect(history[0]?.attempts).toEqual(['baseten', 'deepseek'])
  })

  it('retries a failure that happened before the request was sent', async () => {
    await pool.addAccount({ apiKey: 'sk-a', alias: 'main' })
    await settings.update({ enabledModelIds: [MODEL] })
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls <= 2) {
        throw new TypeError('fetch failed: Client network socket disconnected before secure TLS connection was established')
      }
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const adapter = adapterWith(fetchFn)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'cline-pass',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) chunks.push(chunk)
    expect(calls).toBe(3)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not retry an ambiguous mid-request reset', async () => {
    await pool.addAccount({ apiKey: 'sk-a', alias: 'main' })
    await settings.update({ enabledModelIds: [MODEL] })
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      throw new TypeError('fetch failed: other side closed')
    }) as typeof fetch
    const adapter = adapterWith(fetchFn)
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'cline-pass',
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { /* no chunk */ }
    })()).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })

  it('rotates to another account when the first one rejects its key', async () => {
    await pool.addAccount({ apiKey: 'sk-bad', alias: 'first' })
    await pool.addAccount({ apiKey: 'sk-good', alias: 'second' })
    await settings.update({ enabledModelIds: [MODEL] })
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const key = headers.get('authorization')
      if (key === 'Bearer sk-bad') return Response.json({ error: { message: 'invalid api key' } }, { status: 401 })
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const adapter = adapterWith(fetchFn)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'cline-pass',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) chunks.push(chunk)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(1)
    const accounts = await pool.listAccounts()
    expect(accounts.find((account) => account.alias === 'first')?.authStatus).toBe('invalid')
    // The cooldown constant is exported for the quota path; keep it referenced so
    // a future change that drops it is visible here rather than in a dead export.
    expect(POOL_COOLDOWN_MS).toBeGreaterThan(0)
  })
})
