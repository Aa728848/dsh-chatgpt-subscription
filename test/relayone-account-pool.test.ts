import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayOneAccountPool, parseRelayOnePoolData, relayOneAccountKey } from '../src/host/relayone/account-pool.ts'
import type { CredentialStore } from '../src/host/token-store.ts'
import type { PoolData } from '../src/host/common/account-pool.ts'
import type { RelayOnePoolAccount } from '../src/host/relayone/account-pool.ts'
import type { RelayOneCredentials } from '../src/host/relayone/token-store.ts'

/**
 * In-memory stand-in for the platform credential backend.
 *
 * The real one is DPAPI on Windows, the Keychain on macOS and the Secret Service
 * on Linux; all three are unavailable in CI, and none of them is what these
 * tests are about.
 */
function memoryBackend(): CredentialStore<PoolData<RelayOnePoolAccount>> {
  let stored: PoolData<RelayOnePoolAccount> | null = null
  return {
    load: async () => (stored === null ? null : structuredClone(stored)),
    save: async (value) => { stored = structuredClone(value) },
    clear: async () => { stored = null },
  }
}

function pool(backend = memoryBackend()): RelayOneAccountPool {
  return new RelayOneAccountPool({ store: null, backend })
}

/** One pasted key, as the route hands it to the pool. */
function key(apiKey: string): RelayOneCredentials {
  return { apiKey, authenticatedAt: Date.now() }
}

describe('RelayOne account pool', () => {
  beforeEach(() => { vi.stubEnv('DSH_HOME', '') })
  afterEach(() => { vi.unstubAllEnvs() })

  it('holds several keys and reports them without leaking any', async () => {
    const accounts = pool()
    await accounts.addAccount(key('sk-alpha'), '主号')
    await accounts.addAccount(key('sk-beta'), '备号')
    const listed = await accounts.listAccounts()
    expect(listed.map((account) => account.alias)).toEqual(['主号', '备号'])
    // The secret never crosses the DTO boundary: a card renders these rows.
    expect(JSON.stringify(listed)).not.toContain('sk-alpha')
    expect(JSON.stringify(listed)).not.toContain('sk-beta')
  })

  it('treats the same key pasted twice as one account', async () => {
    const accounts = pool()
    await accounts.addAccount(key('sk-alpha'), '主号')
    await accounts.addAccount(key('sk-alpha'), '重复粘贴')
    const listed = await accounts.listAccounts()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.alias).toBe('重复粘贴')
  })

  it('identity is the key digest and is stable across reads', () => {
    expect(relayOneAccountKey(key('sk-alpha'))).toBe(relayOneAccountKey(key('sk-alpha')))
    expect(relayOneAccountKey(key('sk-alpha'))).not.toBe(relayOneAccountKey(key('sk-beta')))
  })

  it('serves every request from the selected key and never rotates on its own', async () => {
    const accounts = pool()
    const first = await accounts.addAccount(key('sk-alpha'))
    const second = await accounts.addAccount(key('sk-beta'))
    // The first key added is the selection until the user changes it.
    for (let index = 0; index < 4; index += 1) {
      expect((await accounts.getEffectiveCredential())?.credentials.apiKey).toBe('sk-alpha')
    }
    await accounts.switchTo(second.id)
    for (let index = 0; index < 4; index += 1) {
      expect((await accounts.getEffectiveCredential())?.credentials.apiKey).toBe('sk-beta')
    }
    // Switching back is the same operation, not a cycle.
    await accounts.switchTo(first.id)
    expect((await accounts.getEffectiveCredential())?.credentials.apiKey).toBe('sk-alpha')
  })

  it('remembers the selection across a fresh pool instance', async () => {
    const backend = memoryBackend()
    const accounts = pool(backend)
    await accounts.addAccount(key('sk-alpha'))
    const second = await accounts.addAccount(key('sk-beta'))
    await accounts.switchTo(second.id)
    // A restart rebuilds the pool from the same document; the user's choice is
    // part of it, not a per-process detail.
    const reopened = pool(backend)
    expect(await reopened.activeAccountId()).toBe(second.id)
    expect((await reopened.getEffectiveCredential()).credentials.apiKey).toBe('sk-beta')
  })

  it('refuses to switch to a key that is not pooled', async () => {
    const accounts = pool()
    await accounts.addAccount(key('sk-alpha'))
    await expect(accounts.switchTo('acc_missing')).rejects.toThrow()
  })

  it('keeps a rejected key selected instead of silently spending another', async () => {
    const accounts = pool()
    const first = await accounts.addAccount(key('sk-dead'))
    await accounts.addAccount(key('sk-good'))
    await accounts.markAuthFailed(first.id, 'RelayOne 拒绝了这个 API Key（401）。', 'invalid')
    // The card shows the state and offers the other key; the request does not
    // quietly succeed on a key the user did not select.
    await expect(accounts.getEffectiveCredential()).rejects.toMatchObject({ code: 'AUTH' })
    const listed = await accounts.listAccounts()
    expect(listed.find((account) => account.id === first.id)?.authStatus).toBe('invalid')
    expect(await accounts.activeAccountId()).toBe(first.id)
  })

  it('parses a stored document defensively', () => {
    const parsed = parseRelayOnePoolData({
      version: 1,
      accounts: [
        { id: 'a', alias: 'good', credentials: { apiKey: 'sk-a', authenticatedAt: 1 }, addedAt: 1, isPrimary: true },
        { id: 'b', credentials: { apiKey: '   ' } },
        { id: '', credentials: { apiKey: 'sk-c' } },
      ],
    })
    expect(parsed.accounts).toHaveLength(1)
    expect(parsed.accounts[0]!.credentials.apiKey).toBe('sk-a')
  })

  it('always reports the sequential strategy, because there is no choice', async () => {
    const accounts = pool()
    await accounts.addAccount(key('sk-alpha'))
    await accounts.addAccount(key('sk-beta'))
    expect(await accounts.strategy()).toBe('sequential')
  })
})
