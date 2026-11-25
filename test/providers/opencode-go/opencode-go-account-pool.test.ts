import { describe, expect, it } from 'vitest'
import { OpenCodeGoAccountPool, openCodeGoAccountKey, parseOpenCodeGoPoolData } from '../../../src/host/providers/opencode-go/account-pool.ts'
import { credential, memoryBackend } from './helpers.ts'

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
