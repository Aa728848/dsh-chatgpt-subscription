import { describe, expect, it } from 'vitest'
import { openCodeGoModelOptions, parseOpenCodeGoModelEntries, parsePersistedOpenCodeGoModelEntries, persistedOpenCodeGoModelEntries, resolveOpenCodeGoModel } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import { fetchOpenCodeGoUsage } from '../../../src/host/providers/opencode-go/client.ts'
import { credential, jsonResponse, settings } from './helpers.ts'

const rawModels = [{
  id: 'deepseek-v4.1-flash', object: 'model', type: 'chat', name: 'DeepSeek V4.1 Flash', canonical_id: 'deepseek/deepseek-v4.1-flash-1017',
  capabilities: { tools: { supported: true }, reasoning: { supported: true, effort: ['low', 'high', 'max'] } },
  modalities: { input: ['text', 'image/png'], output: ['text'] }, limit: { context: 1_000_000, output: 384_000 },
  go: { training: false, zdr: true, limited_regions: false },
}]

describe('OpenCode Go model catalog and quota', () => {
  it('uses only declared model capabilities and preserves tri-state selection', () => {
    const entries = parseOpenCodeGoModelEntries(rawModels)!
    expect(entries).toHaveLength(1)
    expect(entries[0]?.contextWindow).toBe(1_000_000)
    expect(entries[0]?.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(openCodeGoModelOptions(entries, settings({ enabledModelIds: null }))[0]?.enabled).toBe(true)
    expect(openCodeGoModelOptions(entries, settings({ enabledModelIds: [] }))[0]?.enabled).toBe(false)
    expect(openCodeGoModelOptions(entries, settings({ enabledModelIds: ['other'] }))[0]?.enabled).toBe(false)
    expect(openCodeGoModelOptions(entries, settings({ enabledModelIds: ['deepseek-v4.1-flash'] }))[0]?.enabled).toBe(true)
  })

  it('round-trips the production snapshot codec', () => {
    const entries = parseOpenCodeGoModelEntries(rawModels)!
    const restored = parsePersistedOpenCodeGoModelEntries(persistedOpenCodeGoModelEntries(entries))
    expect(restored).toEqual(entries)
    expect(resolveOpenCodeGoModel(restored!, 'deepseek-v4.1-flash').canonicalId).toBe('deepseek/deepseek-v4.1-flash-1017')
  })

  it('keeps aggregated chat entries when tools are declared unsupported', () => {
    const unsupported = structuredClone(rawModels[0]!)
    unsupported.capabilities.tools.supported = false
    const entries = parseOpenCodeGoModelEntries([unsupported]) ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.supportsTools).toBe(false)
    expect(openCodeGoModelOptions(entries, settings())[0]?.hint).toContain('no tools')
  })

  it('does not let an earlier account overwrite a newer account catalog', async () => {
    const { OpenCodeGoCatalogManager } = await import('../../../src/host/providers/opencode-go/model-catalog.ts')
    const manager = new OpenCodeGoCatalogManager()
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const fetching = new Promise<void>(resolve => { started = resolve })
    const first = manager.warm({ account: { id: 'acc_a' }, credentials: credential('acc_a') }, async () => {
      started?.()
      await new Promise<void>(resolve => { release = resolve })
      return jsonResponse({ data: [{ id: 'model-a', type: 'chat' }] })
    }, true)
    await fetching
    const second = manager.warm({ account: { id: 'acc_b' }, credentials: credential('acc_b') }, async () => jsonResponse({ data: [{ id: 'model-b', type: 'chat' }] }), true)
    release?.()
    const [firstEntries] = await Promise.all([first, second])
    expect(firstEntries.map(entry => entry.id)).toEqual(['model-a'])
    expect(manager.snapshot().scope).toBe('acc_b')
    expect(manager.snapshot().entries.map(entry => entry.id)).toEqual(['model-b'])
  })

  it('rejects a model the current account does not serve', () => {
    expect(() => resolveOpenCodeGoModel([], 'not-available')).toThrow(/current key catalog/)
  })

  it('maps rolling, weekly and monthly usage without fabricating plan data', async () => {
    const snapshot = await fetchOpenCodeGoUsage('acc_1', credential(), async () => jsonResponse({ usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-25T12:00:00Z' },
      weekly: { status: 'ok', percent: 24, resetsAt: '2026-11-30T00:00:00Z' },
      monthly: { status: 'ok', percent: 38, resetsAt: '2026-12-25T00:00:00Z' },
    } }))
    expect(snapshot.windows.map(window => window.key)).toEqual(['rolling', 'weekly', 'monthly'])
    expect(snapshot.windows.map(window => window.usedPercent)).toEqual([12, 24, 38])
    expect(snapshot.planName).toBeNull()
  })

  it('rejects incomplete usage payloads', async () => {
    await expect(fetchOpenCodeGoUsage('acc_1', credential(), async () => jsonResponse({ usage: {} }))).rejects.toThrow(/missing a window/)
  })
})
