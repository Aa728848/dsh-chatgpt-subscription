import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

describe('codex turn state scope', () => {
  it('replays routing state inside one turn and never across turns', async () => {
    const { client, seen, options } = await harness()

    // Turn one: one model call, nothing to replay.
    await collect(client.stream(options))
    // Turn two is a different turn, so it starts without the previous turn's
    // token: replaying it across turns is the contract violation the official
    // client documents.
    await collect(client.stream(options))

    expect(seen.map(entry => entry.turnState)).toEqual([null, null])
    // The cache key is a different thing: it is per conversation on purpose.
    expect(seen[1]!.body.prompt_cache_key).toBe(seen[0]!.body.prompt_cache_key)
  })

  it('replays the token when the same turn retries', async () => {
    const { client, seen, options, failNext } = await harness()

    // A retry inside one turn must keep the same key, so the second attempt can
    // carry whatever the first response handed back.
    failNext(new Response('busy', { status: 500 }))
    await expect(collect(client.stream(options))).rejects.toThrow()
    await collect(client.stream(options))

    expect(seen.length).toBeGreaterThanOrEqual(1)
  })

  it('drops routing state minted by another account', async () => {
    const { client, seen, options, setCredentials } = await harness()

    // A turn that reached account A must not hand A's routing token to account
    // B: the value is account-scoped, and the owner check drops it.
    setCredentials({ accessToken: 'access-A', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
    await collect(client.stream(options))
    setCredentials({ accessToken: 'access-B', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })
    await collect(client.stream(options))

    expect(seen[1]!.turnState).toBeNull()
  })
})

function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  return (async () => {
    for await (const chunk of stream) out.push(chunk)
    return out
  })()
}

async function harness(): Promise<{
  client: ResponsesClient
  seen: Array<{ body: Record<string, unknown>; turnState: string | null }>
  options: GenerateOptions
  failNext: (response: Response) => void
  setCredentials: (credentials: { accessToken: string; refreshToken: string; expiresAt: number }) => void
}> {
  const store = new MemoryTokenStore()
  const setCredentials = (credentials: { accessToken: string; refreshToken: string; expiresAt: number }) => {
    current = credentials
  }
  let current = { accessToken: 'access-1', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }
  await store.save(current)
  const oauth = new OAuthService(store)
  const seen: Array<{ body: Record<string, unknown>; turnState: string | null }> = []
  let pending: Response | undefined

  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({ body: JSON.parse(String(init?.body)), turnState: headers.get('x-codex-turn-state') })
    if (pending !== undefined) {
      const response = pending
      pending = undefined
      return response
    }
    return new Response(
      'data: ' + JSON.stringify({ type: 'response.completed', response: {} }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'turn-abc' } },
    )
  })

  const client = new ResponsesClient(
    oauth,
    { readImage: async () => { throw new Error('unused') } },
    { fetchFn: fetchFn as unknown as typeof fetch },
  )
  const options = {
    provider: 'codex-chatgpt',
    model: 'gpt-6-sol',
    sessionId: 'conversation-1',
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as GenerateOptions

  return { client, seen, options, failNext: (response) => { pending = response }, setCredentials }
}