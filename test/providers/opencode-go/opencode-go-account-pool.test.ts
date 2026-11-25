import { describe, expect, it } from 'vitest'
import { OpenCodeGoAccountPool, openCodeGoAccountKey, openCodeGoProjectedPressure, parseOpenCodeGoPoolData } from '../../../src/host/providers/opencode-go/account-pool.ts'
import type { OpenCodeGoQuotaSnapshotDto } from '../../../src/shared/opencode-go-contracts.ts'
import { credential, memoryBackend, modelEntry } from './helpers.ts'

function quota(rolling: number, weekly: number, monthly: number): OpenCodeGoQuotaSnapshotDto {
  return { fetchedAt: 100, planName: null, windows: [
    { key: 'rolling', usedPercent: rolling, resetsAt: null },
    { key: 'weekly', usedPercent: weekly, resetsAt: null },
    { key: 'monthly', usedPercent: monthly, resetsAt: null },
  ] }
}

describe('OpenCode Go account pool', () => {
  it('deduplicates the same key without exposing it in summaries', async () => {
    const backend = memoryBackend()
    const pool = new OpenCodeGoAccountPool({ backend })
    await pool.addAccount(credential(), '主账号')
    await pool.addAccount(credential(), '主账号')
    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    const summaries = pool.summariesOf(data)
    expect(summaries[0]?.authKind).toBe('api-key')
    expect(JSON.stringify(summaries)).not.toContain('oc_sk_test')
    expect(openCodeGoAccountKey(credential())).toBe(openCodeGoAccountKey(credential()))
  })

  it('uses a language-neutral default alias', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    const account = await pool.addAccount(credential())
    expect(account.alias).toBe('OpenCode Go #1')
    expect(parseOpenCodeGoPoolData({ accounts: [{ id: account.id, credentials: credential() }] }).accounts[0]?.alias).toBe('OpenCode Go #1')
  })

  it('persists official quota and local allowance estimates without confusing them', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    const account = await pool.addAccount(credential())
    await pool.recordQuota(account.id, quota(10, 20, 30))
    await pool.recordAllowance(account.id, modelEntry(), 10, 'Go Plus')
    await pool.recordAllowance(account.id, modelEntry(), 20, 'Go Plus')
    const stored = (await pool.read()).accounts[0]!
    expect(stored.quota?.windows.map(window => window.usedPercent)).toEqual([10, 20, 30])
    expect(stored.allowanceSinceQuota).toBe(30)
    expect(stored.allowanceCosts?.[modelEntry().id]).toMatchObject({ averageAmount: 15, uses: 2 })
    expect(openCodeGoProjectedPressure(stored, modelEntry())).toBe(122.5)
    expect(parseOpenCodeGoPoolData({ accounts: [stored] }).accounts[0]).toMatchObject({ allowanceSinceQuota: 30, planName: 'Go Plus' })
  })

  it('prefers the account with more projected window headroom unless the user pinned one', async () => {
    const pool = new OpenCodeGoAccountPool({ backend: memoryBackend() })
    const primary = await pool.addAccount(credential('oc_sk_first'))
    const second = await pool.addAccount(credential('oc_sk_second'))
    const unknown = await pool.addAccount(credential('oc_sk_unknown'))
    await pool.recordQuota(primary.id, quota(80, 40, 20))
    await pool.recordAllowance(primary.id, modelEntry(), 10, 'Go')
    await pool.recordQuota(second.id, quota(10, 5, 2))
    await pool.recordPlan(second.id, 'Go')
    expect((await pool.getEffectiveCredential(undefined, fetch, { model: modelEntry() })).account.id).toBe(second.id)
    await pool.recordAllowance(second.id, modelEntry(), 100, 'Go')
    expect((await pool.getEffectiveCredential(undefined, fetch, { model: modelEntry() })).account.id).toBe(unknown.id)
    expect((await pool.getEffectiveCredential(undefined, fetch, { model: modelEntry(), preferAccountIds: [primary.id] })).account.id).toBe(primary.id)
  })

  it('replaces a key in place and clears auth/cooldown state', async () => {
    const backend = memoryBackend()
    const pool = new OpenCodeGoAccountPool({ backend })
    const account = await pool.addAccount(credential(), '主账号')
    await pool.markAuthFailed(account.id, 'expired')
    await pool.markCooldown(account.id, 60_000, 'limited')
    await pool.replaceApiKey(account.id, 'oc_sk_new')
    const data = await pool.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]?.id).toBe(account.id)
    expect(data.accounts[0]?.credentials.apiKey).toBe('oc_sk_new')
    expect(data.accounts[0]?.authStatus).toBeUndefined()
    expect(data.accounts[0]?.cooldownUntil).toBeUndefined()
  })

  it('round-trips pool documents while rejecting malformed credentials', async () => {
    const backend = memoryBackend()
    const pool = new OpenCodeGoAccountPool({ backend })
    const account = await pool.addAccount(credential(), '主账号')
    const restored = parseOpenCodeGoPoolData(await backend.load())
    expect(restored.accounts[0]?.id).toBe(account.id)
    expect(restored.accounts[0]?.credentials.apiKey).toBe('oc_sk_test')
    expect(parseOpenCodeGoPoolData({ accounts: [{ id: 'bad', credentials: { apiKey: '' } }] }).accounts).toEqual([])
  })
})
