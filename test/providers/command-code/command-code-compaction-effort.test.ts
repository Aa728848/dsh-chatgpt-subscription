/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and this line's default is
 * null, so without the effort memory a compaction body would omit `reasoning_effort`
 * while the main turn carried one. The effort is part of what the upstream caches
 * against, so that mismatch sends the whole conversation cold.
 */
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CommandCodeAdapter } from '../../../src/host/providers/command-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../../../src/host/providers/command-code/token-store.ts'
import { clearCachedCatalog } from '../../../src/host/providers/command-code/client.ts'

const CATALOG = [
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 },
]

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function sseResponse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
})

/** An adapter whose configured default is null, recording every chat body. */
function buildAdapter(bodies: Array<Record<string, unknown>>): CommandCodeAdapter {
  const store = new FileCredentialStore(tmp('cc-effort-cred'))
  vi.spyOn(store, 'read').mockResolvedValue({ apiKey: 'cmd_key' })
  const modelSettings = new FileModelSettingsStore(tmp('cc-effort-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
  })
  return new CommandCodeAdapter(store, modelSettings, undefined, { loadCatalog: async () => CATALOG })
}

async function send(adapter: CommandCodeAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    provider: 'command-code',
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as unknown as GenerateOptions
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

describe('Command Code auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the (null) default', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch
    try {
      await send(adapter, { sessionId: 'cc-sess', reasoningEffort: 'high' })
      await send(adapter, { sessionId: 'cc-sess', purpose: 'compaction' })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'high'])
  })

  it('sends no effort with no session main turn', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    }) as typeof fetch
    try {
      await send(adapter, { sessionId: 'cc-none', purpose: 'compaction' })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(bodies[0]!.reasoning_effort).toBeUndefined()
  })
})
