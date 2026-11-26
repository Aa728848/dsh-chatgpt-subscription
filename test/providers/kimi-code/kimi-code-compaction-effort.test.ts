/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and the settings default
 * may differ from the level the session runs at. The effort is part of what the
 * service caches against, so a mismatch sends the whole conversation cold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions as HarnessGenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../../../src/host/common/llm-compat.ts'
import { KimiCodeAdapter } from '../../../src/host/providers/kimi-code/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../../../src/host/providers/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel } from '../../../src/host/providers/kimi-code/token-store.ts'
import { clearCachedCatalog } from '../../../src/host/providers/kimi-code/client.ts'
import { resetCacheStats } from '../../../src/host/providers/kimi-code/mapper.ts'

const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' },
]

const CHAT_TURN = [
  { choices: [{ delta: { content: 'hi' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
]

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

function sseResponse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''))
}

afterEach(() => {
  clearCachedCatalog()
  resetCacheStats()
  vi.restoreAllMocks()
})

/** An adapter whose settings default is `max`, recording every request body. */
function buildAdapter(bodies: Array<Record<string, unknown>>): KimiCodeAdapter {
  const store = new FileCredentialStore(tmp('kc-effort-cred'))
  vi.spyOn(store, 'read').mockResolvedValue({
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 86_400_000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  })
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-effort-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: 'max',
  })
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return sseResponse(CHAT_TURN)
  }) as unknown as typeof fetch
  return new KimiCodeAdapter(store, modelSettings, undefined, { loadCatalog: async () => CATALOG, fetchFn })
}

async function send(adapter: KimiCodeAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    model: 'k3.1-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as unknown as HarnessGenerateOptions
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
}

describe('auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the settings default', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    await send(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-a', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'high'])
    expect(bodies[1]!.thinking).toMatchObject({ effort: 'high' })
  })

  it('keeps an effort the auxiliary request names itself', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    await send(adapter, { sessionId: 'sess-b', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-b', purpose: 'compaction', reasoningEffort: 'low' })

    expect(bodies[1]!.reasoning_effort).toBe('low')
  })

  it('falls back to the settings default with no main turn, another session, or another model', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    await send(adapter, { sessionId: 'sess-c', purpose: 'compaction' })
    await send(adapter, { sessionId: 'sess-c', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-other', purpose: 'compaction' })
    await send(adapter, { sessionId: 'sess-c', purpose: 'compaction', model: 'k3' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['max', 'high', 'max', 'max'])
  })

  it('does not let an auxiliary request overwrite the remembered effort', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = buildAdapter(bodies)
    await send(adapter, { sessionId: 'sess-d', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-d', purpose: 'compaction', reasoningEffort: 'low' })
    await send(adapter, { sessionId: 'sess-d', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['high', 'low', 'high'])
  })
})
