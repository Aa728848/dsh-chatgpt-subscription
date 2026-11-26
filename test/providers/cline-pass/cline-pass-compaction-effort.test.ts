/**
 * A compaction summary follows the session's own reasoning effort.
 *
 * The harness names no effort on a compaction request; without inheriting the
 * session's level the request body differs from the main turns' and the upstream
 * cached prefix no longer matches.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ClinePassAdapter, type ClinePassAdapterOptions } from '../../../src/host/providers/cline-pass/adapter.ts'
import { ClinePassAccountPool } from '../../../src/host/providers/cline-pass/account-pool.ts'
import { createClinePassStore } from '../../../src/host/providers/cline-pass/store.ts'
import { ClinePassModelSettingsStore, FileCredentialStore } from '../../../src/host/providers/cline-pass/token-store.ts'
import type { ClinePassCredentials } from '../../../src/host/providers/cline-pass/token-store.ts'
import { createClinePassEngine } from './cline-pass-test-helpers.ts'

const MODEL = 'cline-pass/glm-5.3'
const SSE_OK = [
  'data: {"choices":[{"delta":{"content":"hello"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
  'data: [DONE]',
  '',
].join('\n\n')

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

let dir = ''
let pool: ClinePassAccountPool
let settings: ClinePassModelSettingsStore
let store: ReturnType<typeof createClinePassStore>
let calls: Array<Record<string, unknown>>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-effort-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<ClinePassCredentials>() as never)
  pool = new ClinePassAccountPool({ store: credential, backend: new MemoryBackend() as never })
  settings = new ClinePassModelSettingsStore(path.join(dir, 'models.json'))
  store = createClinePassStore()
  calls = []
})

function adapterWith(fetchFn: typeof fetch, attachments?: ClinePassAdapterOptions['attachments']): ClinePassAdapter {
  const engine = createClinePassEngine({ pool, store, settings })
  ;(engine as unknown as { options: { fetchFn: typeof fetch } }).options.fetchFn = fetchFn
  return new ClinePassAdapter(engine, store, settings, pool, { ...(attachments === undefined ? {} : { attachments }) })
}

async function collect(adapter: ClinePassAdapter, overrides: Record<string, unknown>): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: 'cline-pass',
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  } as never)) void _chunk
}

describe('Cline Pass auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort', async () => {
    await pool.addAccount({ apiKey: 'sk-a', alias: 'main' })
    await settings.update({ enabledModelIds: [MODEL] })
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const adapter = adapterWith(fetchFn)
    await collect(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await collect(adapter, { sessionId: 'sess-a', purpose: 'compaction' })
    expect(calls[0]!.reasoning_effort).toBe('high')
    expect(calls[1]!.reasoning_effort).toBe('high')
  })
})
