/**
 * A compaction summary follows the session's own effort on Codex/ChatGPT.
 *
 * The Responses body carries the effort inside its `reasoning` block, which is
 * part of what the backend caches against. An unnamed compaction that sent no
 * effort would diverge from the main turn's body and re-read the conversation.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodexChatGptAdapter } from '../../../src/host/providers/codex-chatgpt/adapter.ts'
import { ResponsesClient } from '../../../src/host/providers/codex-chatgpt/responses-client.ts'
import { OAuthService } from '../../../src/host/providers/codex-chatgpt/oauth-service.ts'
import { MemoryTokenStore } from '../../../src/host/infra/storage/token-store.ts'

function sse(frames: unknown[]): Response {
  return new Response(
    frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** An adapter whose Responses transport records every request body. */
async function buildAdapter(bodies: Array<Record<string, unknown>>): Promise<{ adapter: CodexChatGptAdapter; oauth: OAuthService }> {
  const store = new MemoryTokenStore()
  await store.save({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
  const oauth = new OAuthService(store)
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return sse([{ type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } }])
  })
  const client = new ResponsesClient(oauth, { readImage: async () => { throw new Error('unused') } }, { fetchFn: fetchFn as unknown as typeof fetch })
  return { adapter: new CodexChatGptAdapter(client), oauth }
}

async function send(adapter: CodexChatGptAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    provider: 'codex-chatgpt',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  } as unknown as GenerateOptions
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

function effortOf(body: Record<string, unknown>): unknown {
  return (body.reasoning as { effort?: unknown } | undefined)?.effort
}

describe('Codex auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { adapter, oauth } = await buildAdapter(bodies)

    await send(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-a', purpose: 'compaction' })

    expect(bodies.map(effortOf)).toEqual(['high', 'high'])
    oauth.dispose()
  })

  it('keeps an effort the auxiliary request names itself', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { adapter, oauth } = await buildAdapter(bodies)

    await send(adapter, { sessionId: 'sess-b', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-b', purpose: 'compaction', reasoningEffort: 'low' })

    expect(bodies.map(effortOf)).toEqual(['high', 'low'])
    oauth.dispose()
  })
})
