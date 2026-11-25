import { describe, expect, it } from 'vitest'
import { OpenCodeGoAdapter } from '../../../src/host/providers/opencode-go/adapter.ts'
import { OpenCodeGoAccountPool } from '../../../src/host/providers/opencode-go/account-pool.ts'
import type { OpenCodeGoCatalogManager } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import type { OpenCodeGoSettingsStore } from '../../../src/host/providers/opencode-go/token-store.ts'
import { credential, memoryBackend, modelEntry, settings, sse, jsonResponse } from './helpers.ts'

function catalog(): OpenCodeGoCatalogManager { return { warm: async () => [modelEntry()] } as unknown as OpenCodeGoCatalogManager }
function store(): OpenCodeGoSettingsStore { return { read: async () => settings() } as unknown as OpenCodeGoSettingsStore }
function options() { return { provider: 'opencode-go', model: 'deepseek-v4.1-flash', sessionId: 'session-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK' }] }] } as never }
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> { const chunks: unknown[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

describe('OpenCodeGoAdapter', () => {
  it('sends the same stable session id across turns and streams the answer', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    await pool.addAccount(credential(), '主账号')
    const sessions: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      sessions.push((init?.headers as Record<string, string>)['x-opencode-session'])
      return sse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }), JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })])
    }
    const adapter = new OpenCodeGoAdapter(store(), catalog(), { accountPool: pool, fetchFn })
    const first = await adapter.prepareCall('opencode-go', 'deepseek-v4.1-flash')
    await collect(first.stream(options()))
    const second = await adapter.prepareCall('opencode-go', 'deepseek-v4.1-flash')
    const chunks = await collect(second.stream(options()))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toBe(sessions[1])
    expect(sessions[0]).toMatch(/^ses_dsh_/)
    expect(chunks.some(chunk => (chunk as { type?: string }).type === 'finish')).toBe(true)
  })

  it('treats an unreadable pool as unconfigured instead of throwing', async () => {
    const backend = { async load() { throw new Error('unreadable') }, async save() { throw new Error('unreadable') }, async clear() {} }
    const pool = new OpenCodeGoAccountPool({ backend })
    const adapter = new OpenCodeGoAdapter(store(), catalog(), { accountPool: pool })
    await expect(adapter.listModels()).resolves.toEqual([])
  })

  it('marks a rejected key as auth failed', async () => {
    const backend = memoryBackend()
    const pool = new OpenCodeGoAccountPool({ backend })
    const account = await pool.addAccount(credential(), '主账号')
    const adapter = new OpenCodeGoAdapter(store(), catalog(), { accountPool: pool, fetchFn: async () => jsonResponse({ error: { message: 'bad key' } }, 401) })
    const call = await adapter.prepareCall('opencode-go', 'deepseek-v4.1-flash')
    await expect(collect(call.stream(options()))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect((await pool.read()).accounts[0]?.authStatus).toBe('expired')
    expect((await pool.read()).accounts[0]?.id).toBe(account.id)
  })

  it('rotates to the next account on 429 before any output', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    await pool.addAccount(credential('oc_sk_first'), '第一个')
    await pool.addAccount(credential('oc_sk_second'), '第二个')
    const keys: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).authorization
      keys.push(authorization)
      if (keys.length === 1) return jsonResponse({ error: { message: 'limited' } }, 429)
      return sse([JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })])
    }
    const adapter = new OpenCodeGoAdapter(store(), catalog(), { accountPool: pool, fetchFn })
    const call = await adapter.prepareCall('opencode-go', 'deepseek-v4.1-flash')
    const chunks = await collect(call.stream(options()))
    expect(keys).toEqual(['Bearer oc_sk_first', 'Bearer oc_sk_second'])
    expect(chunks.some(chunk => (chunk as { type?: string; text?: string }).type === 'text-delta' && (chunk as { text?: string }).text === 'OK')).toBe(true)
  })
})
