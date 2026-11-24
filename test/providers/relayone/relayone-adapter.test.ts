import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { catalogSnapshotName, catalogSnapshotPath, flushCatalogSnapshots } from '../../../src/host/common/catalog-snapshot.ts'
import { relayOneCredentialFingerprint } from '../../../src/host/providers/relayone/token-store.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../../../src/host/common/llm-compat.ts'
import { RelayOneAdapter } from '../../../src/host/providers/relayone/adapter.ts'
import { RelayOneCatalogManager } from '../../../src/host/providers/relayone/catalog-manager.ts'
import {
  defaultRelayOneSettings,
  type RelayOneCredentials,
  type RelayOneSettings,
} from '../../../src/host/providers/relayone/token-store.ts'
import type { RelayOneCredentialStore, RelayOneSettingsStore } from '../../../src/host/providers/relayone/token-store.ts'
import {
  RELAYONE_CHAT_URL,
  RELAYONE_MESSAGES_URL,
  RELAYONE_RESPONSES_URL,
} from '../../../src/host/providers/relayone/types.ts'
import { RELAYONE_PROVIDER_ID } from '../../../src/shared/relayone-contracts.ts'

const models = {
  object: 'list', data: [
    { id: 'gpt-6-astra', supported_endpoint_types: ['openai'] },
    { id: 'claude-opus-5-5', supported_endpoint_types: ['openai', 'anthropic'] },
    { id: 'deepseek-v4.1-flash-1017', supported_endpoint_types: ['openai'] },
    { id: 'seedream-5.0', supported_endpoint_types: ['openai', 'image-generation'] },
  ],
}
const pricing = {
  data: [
    { model_name: 'gpt-6-astra', vendor_id: -1012, enable_groups: ['openai'], supported_endpoint_types: ['openai'] },
    { model_name: 'claude-opus-5-5', vendor_id: -1002, enable_groups: ['claude'], supported_endpoint_types: ['openai', 'anthropic'] },
    { model_name: 'deepseek-v4.1-flash-1017', vendor_id: -1005, enable_groups: ['domestic'], supported_endpoint_types: ['openai'] },
    { model_name: 'seedream-5.0', vendor_id: -1012, enable_groups: ['images'], supported_endpoint_types: ['openai', 'image-generation'] },
  ],
  vendors: [{ id: -1012, name: 'OpenAI' }, { id: -1002, name: 'Anthropic' }, { id: -1005, name: 'DeepSeek' }],
}
function options(model: string, tools = false): GenerateOptions {
  return {
    provider: RELAYONE_PROVIDER_ID, model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...(tools ? { tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }] } : {}),
  } as GenerateOptions
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
function fakeStores(key = 'sk-test', initialSettings = defaultRelayOneSettings()) {
  let credentials: RelayOneCredentials | null = { apiKey: key, authenticatedAt: 1 }
  let settings: RelayOneSettings = initialSettings
  const store = {
    read: async () => credentials,
    write: async (next: RelayOneCredentials) => { credentials = next },
    delete: async () => { credentials = null },
    path: () => 'memory',
  } as unknown as RelayOneCredentialStore
  const settingsStore = {
    read: async () => settings,
    updateSettings: async (patch: Partial<RelayOneSettings>) => { settings = { ...settings, ...patch }; return settings },
  } as unknown as RelayOneSettingsStore
  return {
    store, settingsStore,
    setKey(value: string) { credentials = { apiKey: value, authenticatedAt: Date.now() } },
    setSettings(value: RelayOneSettings) { settings = value },
  }
}
function catalogFetch(fetchGeneration?: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify(models), { status: 200 })
    if (url.endsWith('/api/pricing')) return new Response(JSON.stringify(pricing), { status: 200 })
    if (fetchGeneration !== undefined) return fetchGeneration(url, init)
    throw new Error('unexpected fetch ' + url)
  }) as unknown as typeof fetch
}
function chatResponse(text = 'ok'): Response {
  const frames = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200 })
}
function responsesToolStream(): Response {
  const frames = [
    { type: 'response.output_item.added', item_id: 'item_a', item: { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item_a', call_id: 'call_a', name: 'lookup', delta: '{"x":' },
    { type: 'response.function_call_arguments.done', item_id: 'item_a', call_id: 'call_a', name: 'lookup', arguments: '{"x":1}' },
    { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"x":1}' }], usage: { input_tokens: 2, output_tokens: 3 } } },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { status: 200 })
}

let testHome = ''
beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-adapter-'))
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

describe('RelayOne adapter protocol integration', () => {
  it('lists only enabled key-visible chat models and hides generation-only media', async () => {
    const stores = fakeStores()
    const fetchFn = catalogFetch()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    expect((await adapter.listModels()).map(model => model.id)).toEqual(['gpt-6-astra', 'claude-opus-5-5', 'deepseek-v4.1-flash-1017'])
    stores.setSettings({ ...defaultRelayOneSettings(), enabledModelIds: [] })
    expect(await adapter.listModels()).toEqual([])
    const resolved = await adapter.resolveModel(RELAYONE_PROVIDER_ID, 'gpt-6-astra')
    expect(resolved.reasoning?.efforts.map(item => item.id)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolved.context).toEqual({ contextWindow: 272000 })
  })
  it.each([false, true])('streams and replays one progress sentence alongside a tool call (native message: %s)', async nativeMessage => {
    const update = 'The two checks passed; the contract is consistent.'
    const content = [{ type: 'output_text', text: update }]
    const progress = { type: 'message', role: 'assistant', phase: 'commentary', content }
    const call = { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'lookup', arguments: '{}' }
    const frames = [
      { type: 'response.output_text.delta', delta: update },
      { type: 'response.output_item.added', item: call },
      { type: 'response.completed', response: { output: nativeMessage ? [progress, call] : [call] } },
    ]
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = catalogFetch(async (url, init) => {
      expect(url).toBe(RELAYONE_RESPONSES_URL)
      bodies.push(JSON.parse(String(init?.body)))
      const events = bodies.length === 1 ? frames : [{ type: 'response.completed', response: { output: [] } }]
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
    })
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const turn = options('gpt-6-astra', true)
    const chunks = await collect(adapter.stream(turn))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: update }])
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.reason.kind).toBe('tool-calls')
    const assistant = { role: 'assistant', source: { kind: 'model', replayState: finish?.replayState },
      content: chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : []),
    }
    const result = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'ok' }] }] }
    await collect(adapter.stream({ ...turn, messages: [...turn.messages, assistant, result] } as GenerateOptions))
    expect(bodies[1]?.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      nativeMessage ? progress : { role: 'assistant', content },
      call,
      { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
    ])
  })
  it('uses standard Responses and parses a complete function call', async () => {
    const generation = vi.fn(async (url: string, _init?: RequestInit) => {
      expect(url).toBe(RELAYONE_RESPONSES_URL)
      return responsesToolStream()
    })
    const fetchFn = catalogFetch(generation)
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const chunks = await collect(adapter.stream(options('gpt-6-astra', true)))
    const calls = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [])
    expect(calls).toEqual([{ type: 'tool-call', id: 'call_a', name: 'lookup', arguments: '{"x":1}' }])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const init = generation.mock.calls[0]?.[1]
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
    expect(request).not.toHaveProperty('originator')
  })
  it('routes related GPT requests by an opaque durable session key, and reports only metered cache reads', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn = catalogFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 3 }
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [], usage } }) + '\n\n')
    })
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = () => new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const normal = { ...options('gpt-6-astra', true), sessionId: 'private-test-session' } as GenerateOptions
    const chunks = await collect(adapter().stream(normal))
    expect(chunks).toContainEqual({ type: 'usage', usage: { cacheReadTokens: 1024, inputTokens: 176, outputTokens: 3 } })
    // Changed history, a fresh adapter, and a retry must not change the conversation identity.
    const turn2 = { ...normal, system: 'a different prefix after compaction' }
    await collect(adapter().stream(turn2))
    await collect(adapter().stream(turn2))
    await collect(adapter().stream({ ...normal, sessionId: 'another-session' } as GenerateOptions))
    await collect(adapter().stream(options('gpt-6-astra')))
    await collect(adapter().stream({ ...normal, purpose: 'title' } as unknown as GenerateOptions))
    stores.setKey('another-opaque-fixture')
    await catalog.refresh(true)
    await collect(adapter().stream(normal))
    const keys = bodies.map(body => body.prompt_cache_key)
    expect(keys[0]).toEqual(expect.stringMatching(/^dsh-[a-f0-9]{32}$/))
    expect(keys.slice(1, 3)).toEqual([keys[0], keys[0]])
    expect(keys[3]).toEqual(expect.any(String))
    expect(keys[3]).not.toEqual(keys[0])
    expect(keys.slice(4, 6)).toEqual([undefined, undefined])
    expect(keys[6]).toEqual(expect.any(String))
    expect(keys[6]).not.toEqual(keys[0])
    const disabled = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn, promptCache: { mode: 'none' } })
    await collect(disabled.stream(normal))
    expect(bodies.at(-1)).not.toHaveProperty('prompt_cache_key')
  })
  it('sends Opus 5.5 effort through Messages without a legacy budget or fallback', async () => {
    const generation = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (url !== RELAYONE_MESSAGES_URL || body.thinking?.type !== 'adaptive'
        || 'budget_tokens' in body.thinking || body.output_config?.effort !== 'max' || 'temperature' in body) {
        return new Response(JSON.stringify({ error: {
          message: 'claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort',
        } }), { status: 400 })
      }
      return new Response('data: {"type":"message_stop"}\n\n')
    })
    const stores = fakeStores()
    const fetchFn = catalogFetch(generation)
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const model = 'claude-opus-5-5'
    const resolved = await adapter.resolveModel(RELAYONE_PROVIDER_ID, model)
    expect(resolved.reasoning?.efforts.map(item => item.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const chunks = await collect(adapter.stream({ ...options(model), temperature: 0.3, reasoningEffort: 'max' } as GenerateOptions))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(generation).toHaveBeenCalledTimes(1)
  })
  it('uses native Anthropic headers and Chat for DeepSeek', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchFn = catalogFetch(async (url, init) => {
      seen.push({ url, init })
      if (url === RELAYONE_MESSAGES_URL) {
        expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01')
        const frames = [
          { type: 'message_start', message: { usage: { input_tokens: 2 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { status: 200 })
      }
      expect(url).toBe(RELAYONE_CHAT_URL)
      return chatResponse('deepseek')
    })
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const forSession = (model: string) => ({ ...options(model), sessionId: 'test-conversation' } as GenerateOptions)
    const claude = await collect(adapter.stream(forSession('claude-opus-5-5')))
    const deepseek = await collect(adapter.stream(forSession('deepseek-v4.1-flash-1017')))
    const claudeBody = JSON.parse(String(seen[0]?.init?.body))
    const chatBody = JSON.parse(String(seen[1]?.init?.body))
    expect(claudeBody.metadata?.user_id).toEqual(expect.any(String))
    expect(claudeBody).not.toHaveProperty('prompt_cache_key')
    expect(chatBody).not.toHaveProperty('prompt_cache_key')
    expect(chatBody).not.toHaveProperty('metadata')
    expect(JSON.stringify(claude)).toContain('claude')
    expect(JSON.stringify(deepseek)).toContain('deepseek')
    expect(seen.map(item => item.url)).toEqual([RELAYONE_MESSAGES_URL, RELAYONE_CHAT_URL])
  })
  it('falls back once on an explicit Responses refusal and caches by key/model', async () => {
    const generationUrls: string[] = []
    const keys: unknown[] = []
    const fetchFn = catalogFetch(async (url, init) => {
      generationUrls.push(url)
      keys.push(JSON.parse(String(init?.body)).prompt_cache_key)
      if (url === RELAYONE_RESPONSES_URL) return new Response(JSON.stringify({ error: { message: 'unsupported endpoint: responses' } }), { status: 400 })
      return chatResponse('fallback')
    })
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    const turn = { ...options('gpt-6-astra'), sessionId: 'fallback-test' } as GenerateOptions
    expect(JSON.stringify(await collect(adapter.stream(turn)))).toContain('fallback')
    expect(JSON.stringify(await collect(adapter.stream(turn)))).toContain('fallback')
    expect(keys).toEqual([expect.any(String), keys[0], keys[0]])
    expect(generationUrls).toEqual([RELAYONE_RESPONSES_URL, RELAYONE_CHAT_URL, RELAYONE_CHAT_URL])
  })
  it('does not disguise an ordinary request error as a protocol fallback', async () => {
    const generation = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid tool arguments for sk-test' } }), { status: 400 }))
    const fetchFn = catalogFetch(generation)
    const stores = fakeStores()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(stores.store, stores.settingsStore, catalog, { fetchFn })
    await expect(collect(adapter.stream(options('gpt-6-astra', true)))).rejects.toThrow(/invalid tool arguments for \[REDACTED\]/)
    expect(generation).toHaveBeenCalledTimes(1)
  })
})

describe('RelayOne catalog manager credential scope', () => {
  it('warm performs no network and refresh notifies only for actual content changes', async () => {
    const stores = fakeStores()
    const changed = vi.fn()
    const fetchFn = catalogFetch()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn, onChanged: changed })
    await catalog.warm()
    expect(fetchFn).not.toHaveBeenCalled()
    await catalog.refresh(true)
    await catalog.refresh(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('keeps the last good catalog on a malformed 200 and clears the snapshot on a valid empty listing', async () => {
    const stores = fakeStores()
    const fetchFn = catalogFetch()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    const snapshotName = catalogSnapshotName('relayone', relayOneCredentialFingerprint({ apiKey: 'sk-test', authenticatedAt: 1 }))
    await expect(fs.access(catalogSnapshotPath(snapshotName))).resolves.toBeUndefined()
    const mock = fetchFn as unknown as ReturnType<typeof vi.fn>
    mock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/v1/models') ? Response.json({ unexpected: true }) : Response.json(pricing))
    await catalog.refresh(true)
    expect(catalog.snapshot().state).toBe('stale')
    expect(catalog.snapshot().entries.length).toBeGreaterThan(0)
    mock.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/v1/models') ? Response.json({ data: [] }) : Response.json(pricing))
    await catalog.refresh(true)
    expect(catalog.snapshot().entries).toEqual([])
    await expect(fs.access(catalogSnapshotPath(snapshotName))).rejects.toThrow()
  })
  it('clears the previous key catalog before serving a replacement key', async () => {
    const stores = fakeStores('sk-a')
    const fetchFn = catalogFetch()
    const catalog = new RelayOneCatalogManager(stores.store, { fetchFn })
    await catalog.refresh(true)
    expect(catalog.snapshot().entries.some(entry => entry.id === 'gpt-6-astra')).toBe(true)
    stores.setKey('sk-b')
    await catalog.warm()
    expect(catalog.snapshot().entries).toEqual([])
  })
})
