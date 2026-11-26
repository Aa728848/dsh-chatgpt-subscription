/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and the settings default
 * (null here) may differ from the level the session runs at. The effort is part
 * of what the service caches against, so a mismatch sends the whole conversation
 * cold.
 */
import { describe, expect, it, vi } from 'vitest'
import { OllamaAdapter } from '../../../src/host/providers/ollama/adapter.ts'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** An adapter over gpt-oss (a levels model) that records every chat body. */
function makeAdapter(): { adapter: OllamaAdapter; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/show')) {
      // gpt-oss declares its own three levels; no reading is needed but the probe
      // is harmless. Fall back to the prefix list by stating nothing.
      return json({ details: {} })
    }
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return sse([{ choices: [{ delta: { content: 'ok' } }] }])
  }) as unknown as typeof fetch
  const store = {
    read: vi.fn(async () => ({ apiKey: 'sk-test' })),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
  const settings = {
    enabled: true,
    enabledModelIds: null,
    catalogModels: [{ id: 'gpt-oss:120b' }],
    defaultReasoningEffort: null,
  }
  const modelSettings = {
    read: vi.fn(async () => settings),
    status: vi.fn(() => settings),
    update: vi.fn(async () => settings),
    storeCatalog: vi.fn(async () => settings),
  }
  const adapter = new OllamaAdapter(store as never, modelSettings as never, {
    fetchFn,
    loadCatalog: async () => [{ id: 'gpt-oss:120b' }],
  })
  return { adapter, bodies }
}

async function send(adapter: OllamaAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    provider: 'ollama',
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as unknown as HarnessGenerateOptions
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

describe('Ollama auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the settings default', async () => {
    const { adapter, bodies } = makeAdapter()

    await send(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-a', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'high'])
  })

  it('keeps an effort the auxiliary request names itself', async () => {
    const { adapter, bodies } = makeAdapter()

    await send(adapter, { sessionId: 'sess-b', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-b', purpose: 'compaction', reasoningEffort: 'low' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'low'])
  })

  it('sends no effort when the session had none either', async () => {
    const { adapter, bodies } = makeAdapter()

    await send(adapter, { sessionId: 'sess-c' })
    await send(adapter, { sessionId: 'sess-c', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual([undefined, undefined])
  })
})
