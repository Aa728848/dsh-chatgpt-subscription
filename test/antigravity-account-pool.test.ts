import { describe, expect, it, vi, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { AccountPoolStore, type AntigravityPoolAccount } from '../src/host/antigravity/account-pool.ts'
import { FileCredentialStore, type AntigravityCredentials } from '../src/host/antigravity/token-store.ts'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { FileModelSettingsStore } from '../src/host/antigravity/token-store.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

class MemoryCredentialStore {
  private data: any = null
  async load() { return this.data ? JSON.parse(JSON.stringify(this.data)) : null }
  async save(data: any) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

describe('AccountPoolStore', () => {
  let memoryBackend: MemoryCredentialStore
  let legacyStore: FileCredentialStore
  let poolStore: AccountPoolStore

  const cred1: AntigravityCredentials = {
    access: 'token-1',
    refresh: 'refresh-1',
    expires: Date.now() + 3600_000,
    email: 'acc1@gmail.com',
    projectId: 'proj-1',
  }

  const cred2: AntigravityCredentials = {
    access: 'token-2',
    refresh: 'refresh-2',
    expires: Date.now() + 3600_000,
    email: 'acc2@gmail.com',
    projectId: 'proj-2',
  }

  beforeEach(() => {
    memoryBackend = new MemoryCredentialStore()
    legacyStore = new FileCredentialStore()
    vi.spyOn(legacyStore, 'read').mockResolvedValue(null)
    vi.spyOn(legacyStore, 'write').mockResolvedValue(undefined)
    vi.spyOn(legacyStore, 'delete').mockResolvedValue(undefined)
    poolStore = new AccountPoolStore('/tmp/test-pool.json', memoryBackend as any, legacyStore)
  })

  it('migrates existing legacy credential as primary account on first load', async () => {
    vi.spyOn(legacyStore, 'read').mockResolvedValue(cred1)
    const save = vi.spyOn(memoryBackend, 'save')
    const data = await poolStore.read()
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0]!.email).toBe('acc1@gmail.com')
    expect(data.accounts[0]!.isPrimary).toBe(true)
    expect(data.activeAccountId).toBe('acc_primary')
    // Reading must not persist the migration: the callers that change the pool
    // write it back themselves, and a getter that silently rewrites encrypted
    // storage is what let a test run overwrite live credentials.
    expect(save).not.toHaveBeenCalled()
  })

  it('supports adding multiple accounts, setting primary and deleting accounts', async () => {
    const a1 = await poolStore.addAccount(cred1, '主账号')
    const a2 = await poolStore.addAccount(cred2, '备用账号')

    let list = await poolStore.listAccounts()
    expect(list).toHaveLength(2)
    expect(list[0]!.isPrimary).toBe(true)
    expect(list[1]!.isPrimary).toBe(false)

    // Switch primary to a2
    await poolStore.setPrimary(a2.id)
    list = await poolStore.listAccounts()
    expect(list.find((a) => a.id === a2.id)!.isPrimary).toBe(true)
    expect(list.find((a) => a.id === a1.id)!.isPrimary).toBe(false)

    // Delete a1
    await poolStore.deleteAccount(a1.id)
    list = await poolStore.listAccounts()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(a2.id)
  })

  it('rotates accounts based on strategy: sequential prefers primary, round-robin rotates LRU', async () => {
    const a1 = await poolStore.addAccount(cred1, '账号1')
    const a2 = await poolStore.addAccount(cred2, '账号2')
    await poolStore.setPrimary(a1.id)

    // Sequential: should pick primary (a1)
    const eff1 = await poolStore.getEffectiveAccount()
    expect(eff1.account.id).toBe(a1.id)

    // Mark a1 in cooldown
    await poolStore.markCooldown(a1.id, 600_000, '429 Rate Limit')

    // Next request should smoothly pick a2
    const eff2 = await poolStore.getEffectiveAccount()
    expect(eff2.account.id).toBe(a2.id)

    // Clear cooldown on a1
    await poolStore.clearCooldown(a1.id)

    // Switch strategy to round-robin
    await poolStore.setStrategy('round-robin')
    // a2 was used most recently, so LRU chooses a1
    const eff3 = await poolStore.getEffectiveAccount()
    expect(eff3.account.id).toBe(a1.id)
  })

  it('throws 429 when all accounts in the pool are in cooldown', async () => {
    const a1 = await poolStore.addAccount(cred1, '账号1')
    await poolStore.markCooldown(a1.id, 600_000, 'Quota Exhausted')

    await expect(poolStore.getEffectiveAccount()).rejects.toThrow(/全部 1 个 Antigravity 账号均处于配额限制或冷却中/)
  })
})

describe('AntigravityAdapter multi-account failover on 429', () => {
  it('automatically fails over to next account when first account hits 429', async () => {
    const memoryBackend = new MemoryCredentialStore()
    const legacyStore = new FileCredentialStore()
    vi.spyOn(legacyStore, 'read').mockResolvedValue(null)
    vi.spyOn(legacyStore, 'write').mockResolvedValue(undefined)
    const poolStore = new AccountPoolStore('/tmp/test-pool.json', memoryBackend as any, legacyStore)

    const a1 = await poolStore.addAccount({
      access: 'token-acc-1',
      refresh: 'ref-1',
      expires: Date.now() + 3600_000,
      email: 'acc1@gmail.com',
      projectId: 'proj-1',
    }, '账号1')

    const a2 = await poolStore.addAccount({
      access: 'token-acc-2',
      refresh: 'ref-2',
      expires: Date.now() + 3600_000,
      email: 'acc2@gmail.com',
      projectId: 'proj-2',
    }, '账号2')

    await poolStore.setPrimary(a1.id)

    const modelSettings = new FileModelSettingsStore()
    vi.spyOn(modelSettings, 'read').mockResolvedValue({
      enabled: true,
      enabledModelIds: ['gemini-3.8-flash'],
      catalogModels: [],
    })

    const fetchCalls: Array<{ url: string; auth: string }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      const auth = headers?.Authorization || headers?.authorization || ''
      fetchCalls.push({ url: String(url), auth })

      if (auth.includes('token-acc-1')) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }), {
          status: 429,
          headers: { 'retry-after': '300', 'content-type': 'application/json' },
        })
      }

      // Token 2 succeeds with SSE
      const sseContent = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello from account 2!"}]}}],"finishReason":"STOP"}',
        '',
      ].join('\n')
      return new Response(sseContent, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const adapter = new AntigravityAdapter(legacyStore, modelSettings, undefined, {}, poolStore)
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as unknown as GenerateOptions)) {
        chunks.push(chunk)
      }

      // Check that it tried account 1, got 429, marked cooldown, and automatically retried account 2!
      expect(fetchCalls.some((c) => c.auth.includes('token-acc-1'))).toBe(true)
      expect(fetchCalls.some((c) => c.auth.includes('token-acc-2'))).toBe(true)
      expect(fetchCalls[fetchCalls.length - 1]!.auth).toContain('token-acc-2')

      // Verify the stream received chunk from account 2
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello from account 2!' })

      // Verify account 1 is in cooldown in the pool
      const accounts = await poolStore.listAccounts()
      const acc1 = accounts.find((a) => a.id === a1.id)
      expect(acc1?.cooldownUntil).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
