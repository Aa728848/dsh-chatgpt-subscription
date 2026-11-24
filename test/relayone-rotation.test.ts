import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'
import { RelayOneAdapter } from '../src/host/relayone/adapter.ts'
import { RelayOneAccountPool } from '../src/host/relayone/account-pool.ts'
import { RelayOneCatalogManager } from '../src/host/relayone/catalog-manager.ts'
import {
  defaultRelayOneSettings,
  type RelayOneCredentialStore,
  type RelayOneSettings,
  type RelayOneSettingsStore,
} from '../src/host/relayone/token-store.ts'
import type { CredentialStore } from '../src/host/token-store.ts'
import type { PoolData } from '../src/host/common/account-pool.ts'
import type { RelayOnePoolAccount } from '../src/host/relayone/account-pool.ts'
import type { RelayOneCredentials } from '../src/host/relayone/token-store.ts'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import { RELAYONE_PROVIDER_ID } from '../src/shared/relayone-contracts.ts'

const models = {
  object: 'list',
  data: [{ id: 'gpt-6-astra', supported_endpoint_types: ['openai'] }],
}
const pricing = {
  data: [{ model_name: 'gpt-6-astra', vendor_id: -1012, enable_groups: ['openai'], supported_endpoint_types: ['openai'] }],
  vendors: [{ id: -1012, name: 'OpenAI' }],
}

function memoryBackend(): CredentialStore<PoolData<RelayOnePoolAccount>> {
  let stored: PoolData<RelayOnePoolAccount> | null = null
  return {
    load: async () => (stored === null ? null : structuredClone(stored)),
    save: async (value) => { stored = structuredClone(value) },
    clear: async () => { stored = null },
  }
}

function fakeSettings() {
  let settings: RelayOneSettings = defaultRelayOneSettings()
  const settingsStore = {
    read: async () => settings,
    updateSettings: async (patch: Partial<RelayOneSettings>) => { settings = { ...settings, ...patch }; return settings },
  } as unknown as RelayOneSettingsStore
  return { settingsStore }
}

/** The pre-pool key file, kept empty so the pool is the only source. */
function emptyLegacyStore(): RelayOneCredentialStore {
  return {
    read: async () => null,
    write: async () => undefined,
    delete: async () => undefined,
    path: () => 'memory',
  } as unknown as RelayOneCredentialStore
}

/**
 * A complete Responses-protocol turn.
 *
 * The catalog puts gpt-6-astra on the Responses wire, so a double that answered
 * with Chat Completions frames would exercise the protocol fallback instead of
 * the key selection this file is about.
 */
function chatResponse(text = 'ok'): Response {
  const NL = String.fromCharCode(10)
  const frames = [
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 2, output_tokens: 1 } } },
  ]
  const SSE = frames.map(frame => 'data: ' + JSON.stringify(frame) + NL + NL).join('')
  return new Response(SSE, { status: 200 })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

function turn(): GenerateOptions {
  return {
    provider: RELAYONE_PROVIDER_ID, model: 'gpt-6-astra',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  } as GenerateOptions
}

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'relayone-switch-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  const storages = path.join(home, 'storages')
  const names = await fs.readdir(storages).catch(() => [] as string[])
  for (const name of names) await fs.unlink(path.join(storages, name)).catch(() => undefined)
  await fs.rmdir(storages).catch(() => undefined)
  await fs.rmdir(home).catch(() => undefined)
})

/**
 * A network double that records which key each request presented and answers
 * the chat call through a per-test policy.
 */
function network(chat: (apiKey: string, calls: number) => Response) {
  const presented: string[] = []
  let calls = 0
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/models')) return Response.json(models)
    if (url.endsWith('/api/pricing')) return Response.json(pricing)
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
    presented.push(authorization.replace('Bearer ', ''))
    calls += 1
    return chat(presented[presented.length - 1]!, calls)
  }) as unknown as typeof fetch
  return { fetchFn, presented }
}

async function fixture(chat: (apiKey: string, calls: number) => Response, keys: string[]) {
  const { fetchFn, presented } = network(chat)
  const pool = new RelayOneAccountPool({ store: emptyLegacyStore(), backend: memoryBackend() })
  for (const key of keys) await pool.addAccount({ apiKey: key, authenticatedAt: 1 })
  const catalog = new RelayOneCatalogManager(pool, { fetchFn })
  await catalog.refresh(true)
  const adapter = new RelayOneAdapter(emptyLegacyStore(), fakeSettings().settingsStore, catalog, {
    fetchFn, accountPool: pool,
  })
  return { adapter, pool, presented, catalog }
}

describe('RelayOne manual key switching', () => {
  it('fails on a rejected key instead of silently spending another', async () => {
    const f = await fixture(
      (apiKey) => (apiKey === 'sk-dead' ? new Response('bad key', { status: 401 }) : chatResponse('from-good')),
      ['sk-dead', 'sk-good'],
    )
    await expect(collect(f.adapter.stream(turn()))).rejects.toThrow()
    // Only the selected key was tried. Retrying on the second one would spend an
    // account the user never chose, which is the behaviour this line lacks.
    expect(f.presented).toEqual(['sk-dead'])
    // The refusal is still recorded, so the card can explain what happened.
    const accounts = await f.pool.listAccounts()
    expect(accounts.find(account => account.alias === 'RelayOne 账号 1')?.authStatus).toBe('invalid')
  })

  it('serves the next request from the key the user switched to', async () => {
    const f = await fixture(
      (apiKey) => (apiKey === 'sk-dead' ? new Response('bad key', { status: 401 }) : chatResponse('from-good')),
      ['sk-dead', 'sk-good'],
    )
    await expect(collect(f.adapter.stream(turn()))).rejects.toThrow()
    const good = (await f.pool.listAccounts()).find(account => account.alias === 'RelayOne 账号 2')!
    await f.pool.switchTo(good.id)
    // The route's `use` action re-scopes the catalog, because a snapshot is
    // keyed by credential. Reproduce that here so the test exercises the switch
    // rather than a missing refresh.
    f.catalog.reset()
    await f.catalog.refresh(true)
    f.presented.length = 0
    const chunks = await collect(f.adapter.stream(turn()))
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: 'from-good' },
    ])
    expect(f.presented).toEqual(['sk-good'])
  })

  it('records a 429 on the key without moving to another one', async () => {
    const f = await fixture(
      (apiKey) => (apiKey === 'sk-busy' ? new Response('slow down', { status: 429 }) : chatResponse('from-idle')),
      ['sk-busy', 'sk-idle'],
    )
    await expect(collect(f.adapter.stream(turn()))).rejects.toThrow()
    expect(f.presented).toEqual(['sk-busy'])
    const accounts = await f.pool.listAccounts()
    const busy = accounts.find(account => account.alias === 'RelayOne 账号 1')!
    // The card draws the cooldown; the selection does not move by itself.
    expect(busy.cooldownUntil).toBeGreaterThan(Date.now())
    f.presented.length = 0
    await expect(collect(f.adapter.stream(turn()))).rejects.toThrow()
    expect(f.presented).toEqual(['sk-busy'])
  })

  it('does not blame the key for a failure that is about the request', async () => {
    const f = await fixture(() => new Response('bad request', { status: 400 }), ['sk-a', 'sk-b'])
    await expect(collect(f.adapter.stream(turn()))).rejects.toThrow()
    expect(f.presented).toEqual(['sk-a'])
    const accounts = await f.pool.listAccounts()
    expect(accounts.every(account => account.authStatus === undefined && account.cooldownUntil === undefined)).toBe(true)
  })

  it('uses one key for many requests until the selection changes', async () => {
    const f = await fixture(() => chatResponse(), ['sk-a', 'sk-b'])
    await collect(f.adapter.stream(turn()))
    await collect(f.adapter.stream(turn()))
    // Two requests, one key: there is no rotation to spread them over.
    expect(f.presented).toEqual(['sk-a', 'sk-a'])
  })

  it('sends the single stored key when the line has no pool', async () => {
    let stored: RelayOneCredentials | null = { apiKey: 'sk-solo', authenticatedAt: 1 }
    const store = {
      read: async () => stored,
      write: async (next: RelayOneCredentials) => { stored = next },
      delete: async () => { stored = null },
      path: () => 'memory',
    } as unknown as RelayOneCredentialStore
    const { fetchFn, presented } = network(() => chatResponse('solo'))
    const catalog = new RelayOneCatalogManager(store, { fetchFn })
    await catalog.refresh(true)
    const adapter = new RelayOneAdapter(store, fakeSettings().settingsStore, catalog, { fetchFn })
    await collect(adapter.stream(turn()))
    expect(presented).toEqual(['sk-solo'])
  })
})
