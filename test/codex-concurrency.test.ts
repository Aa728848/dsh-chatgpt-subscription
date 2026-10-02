import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodexAccountPool, chatGPTConcurrency, parseCodexPoolData } from '../src/host/codex-account-pool.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore, type StoredOAuthCredentials } from '../src/host/token-store.ts'

class MemoryBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const end = new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n')
const options = { provider: 'codex-chatgpt', model: 'gpt-6-sol', sessionId: 'same-session', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as unknown as GenerateOptions
async function drain(client: ResponsesClient, signal?: AbortSignal) { for await (const _ of client.stream({ ...options, signal })) { /* consume body */ } }

async function setup(fetchFn: typeof fetch) {
  const pool = new CodexAccountPool({ store: new MemoryTokenStore(), backend: new MemoryBackend(parseCodexPoolData) as never })
  const credentials: StoredOAuthCredentials = { accessToken: 'mock-token', refreshToken: 'mock-refresh', expiresAt: Date.now() + 3600000, accountId: 'mock-account' }
  const account = await pool.addAccount(credentials)
  const client = new ResponsesClient(new OAuthService(new MemoryTokenStore()), { readImage: async () => { throw new Error('unused') } }, { fetchFn, accountPool: pool })
  return { client, account }
}

describe('codex per-account concurrency', () => {
  it('holds each same-session slot until its response body finishes', async () => {
    const started = deferred(), finishSlow = deferred()
    let calls = 0
    const { client, account } = await setup(async () => {
      calls++
      if (calls !== 1) return new Response(end)
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) { started.resolve(); await finishSlow.promise; controller.enqueue(end); controller.close() },
      }))
    })
    chatGPTConcurrency().setLimit(account.id, 2)
    const slow = drain(client)
    try {
      await started.promise
      await drain(client)
      expect(chatGPTConcurrency().inFlight(account.id)).toBe(1)
    } finally { finishSlow.resolve(); await slow; chatGPTConcurrency().setLimit(account.id, 0) }
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
  })

  it('does not infer concurrency limits from an ordinary 429', async () => {
    const started = deferred(), finishSlow = deferred()
    let calls = 0
    const { client, account } = await setup(async () => {
      calls++
      if (calls !== 1) return new Response('token quota exceeded', { status: 429 })
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) { started.resolve(); await finishSlow.promise; controller.enqueue(end); controller.close() },
      }))
    })
    chatGPTConcurrency().setLimit(account.id, 0)
    const slow = drain(client)
    try {
      await started.promise
      await expect(drain(client)).rejects.toThrow('rate limit')
      expect(chatGPTConcurrency().limitFor(account.id)).toBeUndefined()
      expect(chatGPTConcurrency().inFlight(account.id)).toBe(1)
    } finally { finishSlow.resolve(); await slow; chatGPTConcurrency().setLimit(account.id, 0) }
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
  })

  it('releases a slot when response body consumption fails', async () => {
    const { client, account } = await setup(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body failed')) } })))
    await expect(drain(client)).rejects.toThrow('body failed')
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
  })

  it('releases the slot on cancellation while reading the body', async () => {
    const started = deferred()
    const { client, account } = await setup(async () => new Response(new ReadableStream({ start() { started.resolve() } })))
    const controller = new AbortController()
    const running = drain(client, controller.signal)
    const rejected = expect(running).rejects.toBeDefined()
    await started.promise
    controller.abort(new Error('cancel stream'))
    await rejected
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
  })
})
