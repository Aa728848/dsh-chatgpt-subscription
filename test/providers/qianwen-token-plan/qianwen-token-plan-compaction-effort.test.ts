/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and this line falls back to
 * the configured default. When the session ran at a different level, the compaction
 * body carried the default instead — a different `reasoning_effort`, so the
 * upstream re-read the whole conversation cold. This proves the compaction body
 * carries the main turn's level, not the settings default.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import type { CredentialStore } from '../../../src/host/infra/storage/token-store.ts'
import { QianwenTokenPlanAdapter } from '../../../src/host/providers/qianwen-token-plan/adapter.ts'
import { QianwenCredentialStore, QianwenSettingsStore, type QianwenCredentials } from '../../../src/host/providers/qianwen-token-plan/token-store.ts'
import { PROVIDER_ID } from '../../../src/host/providers/qianwen-token-plan/types.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) await fs.unlink(path.join(dir, name)).catch(() => undefined)
    await fs.rmdir(dir).catch(() => undefined)
  }
  vi.restoreAllMocks()
})

class MemoryBackend implements CredentialStore<QianwenCredentials> {
  value: QianwenCredentials | null = null
  async load() { return this.value }
  async save(value: QianwenCredentials) { this.value = value }
  async clear() { this.value = null }
}

async function stores() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-effort-'))
  dirs.push(dir)
  const credentials = new QianwenCredentialStore('/tmp/qwen-effort', new MemoryBackend())
  const settings = new QianwenSettingsStore(path.join(dir, 'settings.json'))
  return { credentials, settings }
}

const SSE = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'

function requestOptions(overrides: Record<string, unknown> = {}): HarnessGenerateOptions {
  return {
    provider: PROVIDER_ID, model: 'qwen4-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...overrides,
  } as HarnessGenerateOptions
}

describe('Qwen token-plan auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the settings default', async () => {
    const { credentials, settings } = await stores()
    await credentials.write({ apiKey: 'sk-sp-secret', authenticatedAt: 1 })
    // The settings default is 'low'; the session runs at 'high', so only the
    // effort memory can make the compaction body say 'high'.
    await settings.updateSettings({ defaultReasoningEffort: 'low' })
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const adapter = new QianwenTokenPlanAdapter(credentials, settings, { fetchFn })

    for await (const _c of adapter.stream(requestOptions({ sessionId: 'qwen-effort', reasoningEffort: 'high' }))) { /* drain */ }
    for await (const _c of adapter.stream(requestOptions({ sessionId: 'qwen-effort', purpose: 'compaction' }))) { /* drain */ }

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'high'])
  })

  it('falls back to the settings default with no session main turn', async () => {
    const { credentials, settings } = await stores()
    await credentials.write({ apiKey: 'sk-sp-secret', authenticatedAt: 1 })
    await settings.updateSettings({ defaultReasoningEffort: 'low' })
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const adapter = new QianwenTokenPlanAdapter(credentials, settings, { fetchFn })

    for await (const _c of adapter.stream(requestOptions({ sessionId: 'qwen-none', purpose: 'compaction' }))) { /* drain */ }
    expect(bodies[0]!.reasoning_effort).toBe('low')
  })
})
