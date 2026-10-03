import { describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { AccountPoolStore } from '../src/host/antigravity/account-pool.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'
import { mergeCatalogSelection } from '../src/host/antigravity/client.ts'
import { MODELS, ROUTING } from '../src/host/antigravity/types.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const ids = ['claude-opus-5-5', 'claude-sonnet-5-5']

function harness() {
  const settings = new FileModelSettingsStore()
  vi.spyOn(settings, 'read').mockResolvedValue({ enabledModelIds: ids, catalogModels: [] })
  const pool = new AccountPoolStore()
  vi.spyOn(pool, 'getEffectiveAccount').mockResolvedValue({
    account: { id: 'test' }, token: 'test-token', projectId: 'test-project',
  } as Awaited<ReturnType<AccountPoolStore['getEffectiveAccount']>>)
  const fetchFn = vi.fn(async () => new Response('data: ' + JSON.stringify({
    response: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] },
  }) + String.fromCharCode(10, 10)))
  return { adapter: new AntigravityAdapter(new FileCredentialStore(), settings, undefined, { fetchFn }, pool), fetchFn }
}

describe('Antigravity Claude 5.5', () => {
  it.each([false, true])('recovers missing thinking signature once (repeat failure: %s)', async repeatFailure => {
    const { adapter, fetchFn } = harness()
    const error = JSON.stringify({ error: { message: JSON.stringify({ error: { message: 'messages.19.content.1.thinking.signature: Field required' } }) } })
    fetchFn.mockResolvedValueOnce(new Response(error, { status: 400 }))
    if (repeatFailure) fetchFn.mockResolvedValueOnce(new Response(error, { status: 400 }))
    const options = { provider: 'antigravity', model: ids[0], messages: [{
      role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: ids[0] },
      content: [{ type: 'reasoning', text: 'Plan', thinkingSignature: 'server-rejected' }, { type: 'text', text: 'Answer' }],
    }, { role: 'user', content: [{ type: 'text', text: 'Continue' }] }] } as unknown as GenerateOptions
    const run = async () => { for await (const _chunk of adapter.stream(options)) { /* consume */ } }
    if (repeatFailure) await expect(run()).rejects.toThrow('thinking.signature: Field required')
    else await run()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][]
    expect(calls[1][0]).toBe(calls[0][0])
    const before = JSON.parse(String(calls[0][1].body))
    const after = JSON.parse(String(calls[1][1].body))
    expect(before.request.contents[0].parts[0].thought).toBe(true)
    expect(after.model).toBe(before.model)
    expect(after.request.contents[0].parts).toEqual([{ text: 'Answer' }])
    expect(after.request.contents[1]).toEqual(before.request.contents[1])
  })

  it.each(ids)('lists and resolves %s with the three supported efforts', async (id) => {
    const { adapter } = harness()
    expect(await adapter.listModels()).toContainEqual(expect.objectContaining({ id, reasoningEfforts: ['low', 'medium', 'high'] }))
    expect(MODELS.find(m => m.id === id)?.inputModalities).toEqual(['text', 'image'])
    expect(await adapter.resolveModel('antigravity', id)).toMatchObject({ id })
    expect(ROUTING[id].fallbackCandidates).toBeUndefined()
  })

  it.each(ids.flatMap(id => [
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
    ['minimal', 'low'], ['xhigh', 'high'], ['none', 'low'], ['off', 'low'],
    [undefined, 'medium'],
  ].map(([effort, suffix]) => ({ id, effort, suffix }))))('routes $id / $effort to $suffix', async ({ id, effort, suffix }) => {
    const { adapter, fetchFn } = harness()
    const options = {
      provider: 'antigravity', model: id, reasoningEffort: effort, maxTokens: 100000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    } as GenerateOptions
    const chunks = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe(id + '-' + suffix)
    expect(body.request.generationConfig).toEqual({ maxOutputTokens: 64000 })
    expect(init.headers).toMatchObject({ 'anthropic-beta': 'interleaved-thinking-2025-05-14' })
  })

  it('preserves selection across runtime-catalog refreshes without enabling unselected models', () => {
    const catalog = ids.flatMap(id => ['low', 'medium', 'high'].map(e => ({ id: id + '-' + e, name: id })))
    expect(mergeCatalogSelection(ids, catalog)).toEqual(ids)
    expect(mergeCatalogSelection([], [])).toEqual(expect.arrayContaining(ids))
    expect(mergeCatalogSelection([], catalog)).toEqual([])
    expect(mergeCatalogSelection(['claude-opus-4-6'], catalog)).toEqual(['claude-opus-4-6'])
  })
})
