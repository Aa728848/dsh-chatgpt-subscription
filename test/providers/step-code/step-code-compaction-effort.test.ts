/**
 * A compaction summary follows the session's own reasoning effort.
 *
 * The harness names no effort on a compaction request; without inheriting the
 * session's level the line sends no effort at all, a body the upstream cached
 * prefix no longer matches.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StepCodeAdapter } from '../../../src/host/providers/step-code/adapter.ts'
import { clearCachedStepModelCatalog, loadStepModelCatalog } from '../../../src/host/providers/step-code/client.ts'
import { StepCodeCredentialStore, StepCodeModelSettingsStore } from '../../../src/host/providers/step-code/token-store.ts'
import type { StepCodeCredentials } from '../../../src/host/providers/step-code/token-store.ts'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T }
  async save(data: T): Promise<void> { this.data = JSON.parse(JSON.stringify(data)) }
  async clear(): Promise<void> { this.data = null }
}

function credentials(): StepCodeCredentials {
  return { apiKey: 'sk-test', origin: 'manual', profile: 'platform_cn', uid: 'u-1', accountName: null, authenticatedAt: Date.now() }
}

const ANSWER_SSE =
  'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n'
  + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n'
  + 'data: [DONE]\n'

const CATALOG = { data: [{ id: 'step-3', name: 'Step 3', max_input_tokens: 256000, enable_reason: true, enable_vision_input: false, reasoning_effort_support_list: ['low', 'high'] }] }

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(adapter: StepCodeAdapter, overrides: Record<string, unknown>): Promise<void> {
  const call = await adapter.prepareCall('step-code', 'step-3')
  for await (const _chunk of call.stream({ provider: 'step-code', model: 'step-3', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...overrides } as never)) void _chunk
}

describe('Step Code auxiliary request effort', () => {
  beforeEach(() => { clearCachedStepModelCatalog() })

  it('sends a compaction at the session main-turn effort', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'step-effort-'))
    const backend = new MemoryBackend<StepCodeCredentials>()
    await backend.save(credentials())
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1/models')) return Response.json(CATALOG)
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sseResponse(ANSWER_SSE)
    }) as unknown as typeof fetch
    await loadStepModelCatalog({ apiKey: 'sk-test', profile: 'platform_cn', uid: 'u-1' }, { fetchFn })
    const settingsStore = new StepCodeModelSettingsStore(path.join(dir, 'models.json'))
    const adapter = new StepCodeAdapter(
      new StepCodeCredentialStore(path.join(dir, 'credentials.json'), backend as never),
      settingsStore,
      undefined,
      { fetchFn },
    )
    await collect(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await collect(adapter, { sessionId: 'sess-a', purpose: 'compaction' })
    expect(bodies[0]!.reasoning_effort).toBe('high')
    expect(bodies[1]!.reasoning_effort).toBe('high')
  })
})
