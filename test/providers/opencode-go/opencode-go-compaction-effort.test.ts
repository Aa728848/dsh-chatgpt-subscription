/**
 * A compaction summary follows the session's own reasoning effort.
 *
 * The harness names no effort on a compaction request; without inheriting the
 * session's level the line sends its settings default, a different body the
 * upstream cached prefix no longer matches.
 */
import { describe, expect, it } from 'vitest'
import { OpenCodeGoAdapter } from '../../../src/host/providers/opencode-go/adapter.ts'
import { OpenCodeGoAccountPool } from '../../../src/host/providers/opencode-go/account-pool.ts'
import type { OpenCodeGoCatalogManager } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import type { OpenCodeGoSettingsStore } from '../../../src/host/providers/opencode-go/token-store.ts'
import { credential, memoryBackend, modelEntry, settings, sse } from './helpers.ts'

function catalog(): OpenCodeGoCatalogManager {
  const entries = [modelEntry()]
  return { warm: async () => entries, snapshot: () => ({ entries }) } as unknown as OpenCodeGoCatalogManager
}
function store(): OpenCodeGoSettingsStore {
  return { read: async () => settings() } as unknown as OpenCodeGoSettingsStore
}
async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) void _chunk
}

describe('OpenCode Go auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the settings default', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    await pool.addAccount(credential(), 'main')
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }), JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })])
    }
    const adapter = new OpenCodeGoAdapter(store(), catalog(), { accountPool: pool, fetchFn })
    const base = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }] }
    await collect(adapter.stream({ ...base, reasoningEffort: 'high' } as never))
    await collect(adapter.stream({ ...base, purpose: 'compaction' } as never))
    expect(bodies[0]!.reasoning_effort).toBe('high')
    expect(bodies[1]!.reasoning_effort).toBe('high')
  })
})
