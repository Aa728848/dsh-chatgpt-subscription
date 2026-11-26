/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request. The effort is part of what
 * the gateway caches against, so an unnamed compaction at a different level (or
 * with no level at all) re-reads the whole conversation cold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { OpenDesignAdapter } from '../../../src/host/providers/opendesign/adapter.ts'
import { OpenDesignAccountPool } from '../../../src/host/providers/opendesign/account-pool.ts'
import {
  FileCredentialStore,
  OpenDesignModelSettingsStore,
  type OpenDesignCredentials,
} from '../../../src/host/providers/opendesign/token-store.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

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
let pool: OpenDesignAccountPool
let settings: OpenDesignModelSettingsStore

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-effort-'))
  const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<OpenDesignCredentials>() as never)
  pool = new OpenDesignAccountPool({ store: credential, backend: new MemoryBackend() as never })
  settings = new OpenDesignModelSettingsStore(path.join(dir, 'models.json'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function sse(frames: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** An adapter that records every request body it sends upstream. */
function buildAdapter(bodies: Array<Record<string, unknown>>): OpenDesignAdapter {
  const fetchFn = (async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return sse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
  }) as unknown as typeof fetch
  return new OpenDesignAdapter(settings, { fetchFn, accountPool: pool })
}

async function send(adapter: OpenDesignAdapter, overrides: Record<string, unknown>): Promise<void> {
  const opts = { model: 'gpt-6-luna', messages: [], ...overrides } as unknown as GenerateOptions
  for await (const _chunk of adapter.stream(opts)) { /* drain */ }
}

describe('OpenDesign auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)

    await send(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-a', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'high'])
  })

  it('keeps an effort the auxiliary request names itself', async () => {
    await pool.addAccount({ kind: 'api-key', apiKey: 'od_good' }, 'main')
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)

    await send(adapter, { sessionId: 'sess-b', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-b', purpose: 'compaction', reasoningEffort: 'low' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'low'])
  })
})
