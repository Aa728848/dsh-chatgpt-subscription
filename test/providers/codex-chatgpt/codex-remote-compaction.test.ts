import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OAuthService } from '../../../src/host/providers/codex-chatgpt/oauth-service.ts'
import { ResponsesClient } from '../../../src/host/providers/codex-chatgpt/responses-client.ts'
import { MemoryTokenStore } from '../../../src/host/infra/storage/token-store.ts'
import {
  checkpointFromMetadata,
  checkpointFromOutputItems,
  codexRemoteCompactionEnabled,
  codexRemoteCompactionThreshold,
  projectFreshCodexCompaction,
  resetCodexRemoteCompaction,
} from '../../../src/host/providers/codex-chatgpt/codex-remote-compaction.ts'

const capabilities = {
  useResponsesLite: false,
  contextWindow: 1000,
  autoCompactTokenLimit: 1,
  compHash: 'config-1',
}

describe('Codex remote compaction v2', () => {
  beforeEach(() => resetCodexRemoteCompaction())

  it('derives the official threshold and caps a catalog override at 90% of the window', () => {
    expect(codexRemoteCompactionThreshold({ contextWindow: 1000, autoCompactTokenLimit: null, compHash: null })).toBe(900)
    expect(codexRemoteCompactionThreshold({ contextWindow: 1000, autoCompactTokenLimit: 2000, compHash: null })).toBe(900)
    expect(codexRemoteCompactionThreshold({ contextWindow: null, autoCompactTokenLimit: null, compHash: null })).toBeNull()
  })

  it('keeps the static head and latest user turn around a fresh checkpoint', () => {
    const payload = {
      model: 'gpt-6.2-astra',
      input: [
        { type: 'message', role: 'developer', content: [] },
        { type: 'message', role: 'user', content: 'old' },
        { type: 'message', role: 'assistant', content: 'old answer' },
        { type: 'message', role: 'user', content: 'current' },
      ],
    }
    const projected = projectFreshCodexCompaction(payload, {
      model: 'gpt-6.2-astra',
      item: { type: 'compaction', encrypted_content: 'opaque' },
    })
    expect(projected.input).toEqual([
      payload.input[0],
      { type: 'compaction', encrypted_content: 'opaque' },
      payload.input[3],
    ])
  })

  it('rejects checkpoints from an incompatible model configuration', () => {
    expect(checkpointFromMetadata({
      model: 'gpt-6.2-astra',
      compHash: 'config-a',
      item: compaction,
    }, 'gpt-6.2-astra', 'config-b')).toBeNull()
  })

  it('requires exactly one encrypted compaction item', () => {
    expect(checkpointFromOutputItems([], 'gpt-6.2-astra', null)).toBeNull()
    expect(checkpointFromOutputItems([
      { type: 'compaction', encrypted_content: 'a' },
      { type: 'compaction', encrypted_content: 'b' },
    ], 'gpt-6.2-astra', null)).toBeNull()
  })

  it('runs remote-v2 before the answer, persists the checkpoint, and projects later history', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (bodies.length === 1) return sse([
        { type: 'response.output_item.done', item: compaction },
        { type: 'response.completed', response: { id: 'compact-1', output: [compaction] } },
      ])
      const answer = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: bodies.length === 2 ? 'first answer' : 'second answer' }],
      }
      return sse([
        { type: 'response.output_item.done', item: answer },
        { type: 'response.completed', response: { id: `answer-${bodies.length}`, output: [answer] } },
      ])
    })
    const client = await clientWith(fetchFn)
    const first = await collect(client.stream(options('current task'), () => capabilities))
    expect(bodies).toHaveLength(2)
    expect((bodies[0]!.input as unknown[]).at(-1)).toEqual({ type: 'compaction_trigger' })
    expect(bodies[1]!.input).toEqual([compaction, expect.objectContaining({ role: 'user' })])
    const finish = first.at(-1) as any
    expect(finish.replayState.response.nativeCompaction).toMatchObject({
      model: 'gpt-6.2-astra',
      compHash: 'config-1',
      item: compaction,
    })
    expect(finish.replayState.response.outputItems[0]).toEqual(compaction)

    const secondOptions = {
      ...options('next task'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'old task' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'first answer' }],
          source: { kind: 'model', provider: 'codex-chatgpt', model: 'gpt-6.2-astra', replayState: finish.replayState },
        },
        { role: 'user', content: [{ type: 'text', text: 'next task' }] },
      ],
    } as GenerateOptions
    await collect(client.stream(secondOptions, () => ({ ...capabilities, autoCompactTokenLimit: 1_000_000 })))
    expect(bodies).toHaveLength(3)
    const thirdInput = bodies[2]!.input as Record<string, unknown>[]
    expect(thirdInput.filter(item => item.type === 'compaction')).toEqual([compaction])
    expect(JSON.stringify(thirdInput)).not.toContain('old task')
    expect(JSON.stringify(thirdInput)).toContain('next task')
  })

  it('falls back to the untouched full window after a definite remote-v2 refusal', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 })
      }
      return sse([{ type: 'response.completed', response: { output: [] } }])
    })
    const client = await clientWith(fetchFn)
    await collect(client.stream(options('current task'), () => capabilities))
    expect(bodies).toHaveLength(2)
    expect(bodies[1]!.input).not.toContainEqual({ type: 'compaction_trigger' })
    expect(JSON.stringify(bodies[1]!.input)).toContain('current task')
    expect(codexRemoteCompactionEnabled()).toBe(false)
  })
})

const compaction = { type: 'compaction', id: 'cp-1', encrypted_content: 'opaque-state' }

function options(text: string): GenerateOptions {
  return {
    provider: 'codex-chatgpt',
    model: 'gpt-6.2-astra',
    sessionId: 'session-1',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  } as unknown as GenerateOptions
}

async function clientWith(fetchFn: typeof fetch): Promise<ResponsesClient> {
  const store = new MemoryTokenStore()
  await store.save({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000 })
  return new ResponsesClient(
    new OAuthService(store),
    { readImage: async () => { throw new Error('unused') } },
    { fetchFn },
  )
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of iterable) result.push(chunk)
  return result
}
