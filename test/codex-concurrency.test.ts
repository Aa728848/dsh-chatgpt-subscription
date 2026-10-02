import { describe, expect, it } from 'vitest'
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

describe('codex per-account concurrency', () => {
  it('keeps a running request counted after a sibling request finishes', async () => {
    const backend = new MemoryBackend(parseCodexPoolData)
    const pool = new CodexAccountPool({ store: new MemoryTokenStore(), backend: backend as never })
    const account = await pool.addAccount(credential(1))
    chatGPTConcurrency().setLimit(account.id, 2)

    let inFlight = 0
    let peak = 0
    let releaseSlow: (() => void) | undefined
    const slowStarted = new Promise<void>(resolve => {
      const release = releaseSlow
      releaseSlow = () => { release?.(); resolve() }
    })
    let call = 0

    const fetchFn = async () => {
      call += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)
      if (call === 2) {
        // The second request finishes immediately; the first is still streaming.
        inFlight -= 1
        return new Response(
          'data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      await slowStarted
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
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never

    const slow = (async () => { for await (const _ of client.stream(options)) { /* wait */ } })()
    const quick = (async () => {
      for await (const _ of client.stream({ ...(options as object), sessionId: 's2' } as never)) { /* wait */ }
    })()
    await quick

    // The quick request ended, but the slow one is still running and must still
    // hold its slot. A client-wide release would have freed it here.
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(1)

    releaseSlow?.()
    await slow
    expect(chatGPTConcurrency().inFlight(account.id)).toBe(0)
    chatGPTConcurrency().setLimit(account.id, 0)
  })
})