import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
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

function credential(n: number): StoredOAuthCredentials {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: Date.now() + 3_600_000,
    accountId: `acct-${n}`,
    email: `user${n}@example.com`,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('codex per-account concurrency', () => {
  it('queues a second request on the same account and frees the slot afterwards', async () => {
    const backend = new MemoryBackend(parseCodexPoolData)
    const pool = new CodexAccountPool({ store: new MemoryTokenStore(), backend: backend as never })
    const account = await pool.addAccount(credential(1))
    chatGPTConcurrency().setLimit(account.id, 1)

    let inFlight = 0
    let peak = 0
    let requests = 0

    // A response that takes a moment keeps the slot held while the body streams,
    // which is the window a second request has to be turned away from.
    const fetchFn = async () => {
      requests += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }

    const client = new ResponsesClient(
      new OAuthService(new MemoryTokenStore()),
      { readImage: async () => { throw new Error('unused') } },
      { fetchFn: fetchFn as unknown as typeof fetch, accountPool: pool },
    )
    const options = {
      provider: 'codex-chatgpt',
      model: 'gpt-6-sol',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as GenerateOptions

    const first = collect(client.stream(options))
    const second = collect(client.stream(options))
    await Promise.all([first, second])

    // Both requests were served, and the cap held while they ran: the account
    // never had two of our requests in flight at once.
    expect(requests).toBe(2)
    expect(peak).toBe(1)
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
    chatGPTConcurrency().setLimit(account.id, 0)
  })
})