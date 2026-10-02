import { describe, expect, it } from 'vitest'
import { OllamaAccountPool, ollamaAccountKey, parseOllamaPoolData } from '../src/host/ollama/account-pool.ts'
import type { OllamaCredentials } from '../src/host/ollama/token-store.ts'

/** Mirrors the platform backends: JSON round trip, parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function pool(): OllamaAccountPool {
  return new OllamaAccountPool({
    backend: new PoolBackend(parseOllamaPoolData) as never,
    store: { read: async () => null, write: async () => undefined, clear: async () => undefined } as never,
  })
}

const a: OllamaCredentials = { apiKey: 'sk-a', alias: '账号 A' }
const b: OllamaCredentials = { apiKey: 'sk-b', alias: '账号 B' }

describe('Ollama account pool', () => {
  it('identifies an account by its key, without storing the key as the id', () => {
    const id = ollamaAccountKey(a)
    expect(id).not.toBe('sk-a')
    expect(id).toHaveLength(64)
    // Two keys from one account are still two accounts here: a user rotating
    // several free keys is the whole point of the pool.
    expect(ollamaAccountKey(b)).not.toBe(id)
  })

  it('rotates to a different key once one is on cooldown', async () => {
    const p = pool()
    const first = await p.addAccount(a)
    await p.addAccount(b)
    await p.markCooldown(first.id, 60_000, '429')

    const second = await p.getEffectiveAccount()
    expect(second.account.id).not.toBe(first.id)
  })

  it('skips accounts this turn already tried, so failover makes progress', async () => {
    const p = pool()
    const first = await p.addAccount(a)
    const second = await p.addAccount(b)
    const tried = new Set([first.id])

    const next = await p.getEffectiveAccount(tried)
    expect(next.account.id).toBe(second.id)
  })

  it('reports that no other account can serve, rather than looping', async () => {
    const p = pool()
    const only = await p.addAccount(a)
    expect(await p.hasAnotherAvailableAccount(new Set([only.id]))).toBe(false)
  })

  it('keeps a rejected key but takes it out of rotation', async () => {
    // A key the user can replace, not one to delete: signing in again restores it,
    // and deleting the account would throw away the alias the user chose.
    const p = pool()
    const account = await p.addAccount(a)
    await p.addAccount(b)
    await p.markAuthFailed(account.id, 'rejected (401)', 'invalid')

    const summaries = await p.listAccounts()
    const bad = summaries.find(entry => entry.id === account.id)
    expect(bad?.authStatus).toBe('invalid')
    // ...and it is not what the next request picks.
    const next = await p.getEffectiveAccount()
    expect(next.account.id).not.toBe(account.id)
  })

  it('spreads requests over accounts under round-robin', async () => {
    const p = pool()
    const first = await p.addAccount(a)
    await p.addAccount(b)
    await p.setStrategy('round-robin')

    const seen = new Set<string>()
    for (let i = 0; i < 4; i += 1) {
      seen.add((await p.getEffectiveAccount()).account.id)
    }
    expect(seen.size).toBe(2)
    expect(seen.has(first.id)).toBe(true)
  })

  it('honors a user-chosen alias, so several keys stay distinguishable', async () => {
    const p = pool()
    await p.addAccount(a)
    await p.addAccount(b)
    const summaries = await p.listAccounts()
    expect(summaries.map(entry => entry.alias).sort()).toEqual(['账号 A', '账号 B'])
  })

  it('never exposes a key in the card summary', async () => {
    const p = pool()
    await p.addAccount(a)
    const [entry] = await p.listAccounts()
    // The summary is what a settings card renders, so a secret in it would reach
    // the browser. The id is a digest, the alias is the user's own label.
    expect(JSON.stringify(entry)).not.toContain('sk-a')
  })

  it('round-trips a pool document through the parser', () => {
    const parsed = parseOllamaPoolData({
      version: 1,
      rotationStrategy: 'round-robin',
      accounts: [{ id: 'x', alias: 'X', credentials: { apiKey: 'sk-x' }, isPrimary: true }],
    })
    expect(parsed.accounts[0]?.credentials.apiKey).toBe('sk-x')
    expect(parsed.rotationStrategy).toBe('round-robin')
  })

  it('accumulates token counts across turns instead of replacing them', async () => {
    const p = pool()
    const account = await p.addAccount(a)
    await p.recordUsage(account.id, 100, 20)
    await p.recordUsage(account.id, 50, 5)
    const [entry] = await p.listAccounts()
    // A replace would show 50/5 after the second turn and lose the first
    // entirely, which is the failure a running total must not have.
    expect(entry?.usage).toMatchObject({ inputTokens: 150, outputTokens: 25, requestCount: 2 })
  })

  it('counts a turn that reported no tokens as no request at all', async () => {
    // A 429 that returned no usage must not inflate the request count; the
    // number answers how much this key has served, and nothing was served.
    const p = pool()
    const account = await p.addAccount(a)
    await p.recordUsage(account.id, 0, 0)
    const [entry] = await p.listAccounts()
    expect(entry?.usage).toBeUndefined()
  })

  it('ignores usage for an account that no longer exists', async () => {
    // The pool can be edited while a request is in flight; a late write must not
    // throw or resurrect a deleted key.
    const p = pool()
    const account = await p.addAccount(a)
    await p.deleteAccount(account.id)
    await expect(p.recordUsage(account.id, 10, 10)).resolves.toBeUndefined()
  })

  it('drops a hand-edited counter block rather than trusting it', () => {
    // A negative or partial total must not shrink the card on the next request.
    const negative = parseOllamaPoolData({
      version: 1,
      rotationStrategy: 'sequential',
      accounts: [{
        id: 'x', alias: 'X', credentials: { apiKey: 'sk-x' },
        usage: { inputTokens: -1, outputTokens: 5, requestCount: 1 },
      }],
    })
    expect(negative.accounts[0]?.usage).toBeUndefined()
    const partial = parseOllamaPoolData({
      version: 1,
      rotationStrategy: 'sequential',
      accounts: [{
        id: 'x', alias: 'X', credentials: { apiKey: 'sk-x' },
        usage: { inputTokens: 10 },
      }],
    })
    expect(partial.accounts[0]?.usage).toBeUndefined()
  })

  it('refuses a pool document whose account has no key', () => {
    // A keyless account is unusable, and silently dropping it would look like a
    // pool that lost an account.
    expect(() => parseOllamaPoolData({ accounts: [{ id: 'x', credentials: {} }] })).toThrow()
  })
});
