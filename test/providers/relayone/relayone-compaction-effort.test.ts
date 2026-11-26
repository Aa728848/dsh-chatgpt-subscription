/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request. The effort is part of
 * what the upstream caches the prefix against, so an auxiliary call at a
 * different level re-reads the whole conversation cold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushCatalogSnapshots } from '../../../src/host/common/catalog-snapshot.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { RelayOneAdapter } from '../../../src/host/providers/relayone/adapter.ts'
import { RelayOneCatalogManager } from '../../../src/host/providers/relayone/catalog-manager.ts'
import { defaultRelayOneSettings } from '../../../src/host/providers/relayone/token-store.ts'
import type { RelayOneCredentialStore, RelayOneSettingsStore, RelayOneCredentials, RelayOneSettings } from '../../../src/host/providers/relayone/token-store.ts'
import { RELAYONE_RESPONSES_URL } from '../../../src/host/providers/relayone/types.ts'
import { RELAYONE_PROVIDER_ID } from '../../../src/shared/relayone-contracts.ts'

const models = { object: 'list', data: [{ id: 'gpt-6-astra', supported_endpoint_types: ['openai'] }] }
const pricing = {
  data: [{ model_name: 'gpt-6-astra', vendor_id: -1012, enable_groups: ['openai'], supported_endpoint_types: ['openai'] }],
  vendors: [{ id: -1012, name: 'OpenAI' }],
}

let testHome = ''
beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-effort-'))
  vi.stubEnv('DSH_HOME', testHome)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  const directory = path.join(testHome, 'storages')
  const files = await fs.readdir(directory).catch(() => [] as string[])
  for (const file of files) if (file.startsWith('relayone-')) await fs.unlink(path.join(directory, file))
  await fs.rmdir(directory).catch(() => undefined)
  await fs.rmdir(testHome).catch(() => undefined)
})

function fakeStores() {
  let credentials: RelayOneCredentials | null = { apiKey: 'sk-test', authenticatedAt: 1 }
  let settings: RelayOneSettings = defaultRelayOneSettings()
  const store = { read: async () => credentials, write: async (next: RelayOneCredentials) => { credentials = next }, delete: async () => { credentials = null }, path: () => 'memory' } as unknown as RelayOneCredentialStore
  const settingsStore = { read: async () => settings, updateSettings: async (patch: Partial<RelayOneSettings>) => { settings = { ...settings, ...patch }; return settings } } as unknown as RelayOneSettingsStore
  return { store, settingsStore }
}

async function collect(stream: AsyncIterable<unknown>): Promise<void> { for await (const _chunk of stream) void _chunk }

function buildAdapter(bodies: Array<Record<string, unknown>>) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify(models), { status: 200 })
    if (url.endsWith('/api/pricing')) return new Response(JSON.stringify(pricing), { status: 200 })
    expect(url).toBe(RELAYONE_RESPONSES_URL)
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 2, output_tokens: 1 } } }) + '\n\n', { status: 200 })
  }) as unknown as typeof fetch
  const stores = fakeStores()
  const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
  const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
  return { adapter, catalog }
}

async function send(adapter: RelayOneAdapter, overrides: Record<string, unknown>): Promise<void> {
  const request = { provider: RELAYONE_PROVIDER_ID, model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...overrides } as GenerateOptions
  await collect(adapter.stream(request))
}

describe('RelayOne auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const { adapter, catalog } = buildAdapter(bodies)
    await catalog.refresh(true)
    await send(adapter, { sessionId: 'sess-a', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'sess-a', purpose: 'compaction' })
    expect((bodies[0]!.reasoning as { effort?: string } | undefined)?.effort).toBe('high')
    expect((bodies[1]!.reasoning as { effort?: string } | undefined)?.effort).toBe('high')
  })
})
