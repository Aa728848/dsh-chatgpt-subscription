import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OAuthService } from '../src/host/oauth-service.ts'
import { ResponsesClient } from '../src/host/responses-client.ts'
import { MemoryTokenStore, type StoredOAuthCredentials } from '../src/host/token-store.ts'

interface Harness {
  client: ResponsesClient
  seen: Array<{ turnState: string | null }>
  turn(overrides?: Partial<GenerateOptions>): GenerateOptions
  setCredentials(credentials: StoredOAuthCredentials): Promise<void>
}

async function harness(): Promise<Harness> {
  const store = new MemoryTokenStore()
  await store.save({ accessToken: 'access-1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 })
  const oauth = new OAuthService(store)
  const seen: Array<{ turnState: string | null }> = []

  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ turnState: new Headers(init?.headers).get('x-codex-turn-state') })
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

  return {
    client,
    seen,
    turn: (overrides = {}) => ({
      provider: 'codex-chatgpt',
      model: 'gpt-6-sol',
      sessionId: 'conversation-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...overrides,
    } as unknown as GenerateOptions),
    setCredentials: async credentials => { await store.save(credentials) },
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* consume */ }
}

describe('codex turn state scope', () => {
  it('cleans request-local routing state after identical repeated prompts', async () => {
    const { client, seen, turn } = await harness()
    const states = (client as unknown as { turnStates: Map<string, unknown> }).turnStates
    for (let index = 0; index < 3; index++) {
      await drain(client.stream(turn()))
      expect(states.size).toBe(0)
    }
    expect(seen.map(entry => entry.turnState)).toEqual([null, null, null])
  })

  it('never reuses one request state for the next request', async () => {
    const { client, seen, turn } = await harness()

    // A tool loop: the model asks for a tool, the harness runs it, and the
    // second step asks again. The harness exposes no turn id, so the routing
    // state is scoped to the request instead. That costs a resend on the rare
    // follow-up within a turn and removes the risk of carrying a token into a
    // turn that never issued it.
    await drain(client.stream(turn()))
    await drain(client.stream(turn({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
        { role: 'user', content: [{ type: 'text', text: 'tool said ok' }], source: { kind: 'tool', callId: 'c1' } },
      ],
    } as Partial<GenerateOptions>)))

    expect(seen.map(entry => entry.turnState)).toEqual([null, null])
  })

  it('does not carry routing state into the next user turn', async () => {
    const { client, seen, turn } = await harness()

    await drain(client.stream(turn()))
    // A different trailing user message is a different turn, so the previous
    // turn's token must not be replayed into it.
    await drain(client.stream(turn({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'something else' }] },
      ],
    } as Partial<GenerateOptions>)))

    expect(seen.map(entry => entry.turnState)).toEqual([null, null])
  })

  it('drops routing state that another account minted', async () => {
    const { client, seen, turn, setCredentials } = await harness()

    await drain(client.stream(turn()))
    // The store is what the client actually reads, so the switch has to happen
    // there: changing a local variable would not move the auth owner at all.
    await setCredentials({ accessToken: 'access-B', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })
    await drain(client.stream(turn({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'a follow-up' }] },
      ],
    } as Partial<GenerateOptions>)))

    expect(seen[1]!.turnState).toBeNull()
  })
})