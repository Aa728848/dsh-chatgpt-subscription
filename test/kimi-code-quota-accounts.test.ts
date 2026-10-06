/**
 * The Kimi Code line's per-account quota cache and the snapshot each row carries.
 *
 * WHY THIS FILE EXISTS. Quota follows the ACCOUNT, not the line: rotation
 * decides which account spends the next request, so a single slot could only
 * ever describe whichever account was read last. Two properties have to hold
 * for the account card to be honest, and neither is visible to a type checker:
 *
 *   1. two accounts' readings never displace one another, and the map is
 *      bounded so a long-lived host cannot accumulate one snapshot per account
 *      it has ever seen;
 *   2. a window whose consumed share nobody measured never becomes a bar —
 *      "not stated" and "nothing used" are different claims, and the parser is
 *      the first place that difference can be lost.
 *
 * Everything runs against an injected fetch. No test here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { KimiCodeAccountPool, kimiCodePoolQuota, parseKimiCodePoolData } from '../src/host/kimi-code/account-pool.ts'
import {
  cachedQuotaFor,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  getCachedQuotaFor,
} from '../src/host/kimi-code/client.ts'
import { FileCredentialStore, type KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeAccountQuota, KimiCodeUsageWindow } from '../src/shared/kimi-code-contracts.ts'

/** A reset instant in the unit this line states it: Unix MILLISECONDS. */
const RESET_MS = Date.parse('2030-06-15T05:00:00Z')

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

class CredentialBackend {
  private data: KimiCodeCredentials | null = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: KimiCodeCredentials) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function credential(n: number): KimiCodeCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    userId: `user-${n}`,
    email: `user${n}@example.com`,
    nickname: `Kimi ${n}`,
    planName: 'GOAT',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

function pool(): KimiCodeAccountPool {
  const mirror = new FileCredentialStore(tmp('kc-quota-mirror'), new CredentialBackend() as never)
  return new KimiCodeAccountPool({ store: mirror, backend: new PoolBackend(parseKimiCodePoolData) as never })
}

/** The service's own shape: one `{used_ratio, reset_time}` entry per window. */
function usagePayload(usedRatio = 0.42): Record<string, unknown> {
  return { usages: { limit_5h: { used_ratio: usedRatio, reset_time: RESET_MS } } }
}

/** Read one account's usage through the real client, over an injected fetch. */
async function readQuota(
  store: FileCredentialStore,
  credentials: KimiCodeCredentials,
  accountId: string,
  payload: Record<string, unknown> = usagePayload(),
): Promise<KimiCodeAccountQuota | null> {
  const fetchFn = (async () => Response.json(payload)) as unknown as typeof fetch
  return fetchAccountQuota(store, { fetchFn, credentials, accountId, force: true })
}

function quotaStore(): FileCredentialStore {
  return new FileCredentialStore(tmp('kc-quota'), new CredentialBackend() as never)
}

/** One hand-built window, so the parser is bypassed for a mapping case. */
function window(overrides: Partial<KimiCodeUsageWindow> = {}): KimiCodeUsageWindow {
  return {
    id: 'limit_5h',
    label: '5-hour',
    usedFraction: 0.42,
    usedPercent: 42,
    windowDurationMins: 300,
    resetsAt: RESET_MS,
    limit: '100',
    used: '42',
    remaining: '58',
    ...overrides,
  }
}

beforeEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
})

afterEach(() => {
  clearCachedCatalog()
  clearCachedQuota()
})

describe('kimi-code per-account quota cache', () => {
  it('keeps two accounts apart, and answers "latest" only when asked without one', async () => {
    const store = quotaStore()
    await readQuota(store, credential(1), 'acc_a', usagePayload(0.2))
    await readQuota(store, credential(2), 'acc_b', usagePayload(0.9))

    // The later read of the OTHER account does not displace the first one.
    expect(cachedQuotaFor('acc_a')?.windows[0]?.usedPercent).toBe(20)
    expect(getCachedQuotaFor('acc_a')?.windows[0]?.usedPercent).toBe(20)
    expect(getCachedQuotaFor('acc_b')?.windows[0]?.usedPercent).toBe(90)
    // Without an account the pre-pool answer is kept: whatever was read last.
    expect(getCachedQuota()?.windows[0]?.usedPercent).toBe(90)
    // An account this line has never read is null rather than someone else's.
    expect(getCachedQuotaFor('acc_c')).toBeNull()
  })

  it('drops every snapshot on clear', async () => {
    const store = quotaStore()
    await readQuota(store, credential(1), 'acc_a')
    expect(getCachedQuotaFor('acc_a')).not.toBeNull()

    clearCachedQuota()
    expect(getCachedQuotaFor('acc_a')).toBeNull()
    expect(getCachedQuota()).toBeNull()
  })

  it('evicts the oldest reading once more accounts than the cap have been read', async () => {
    const store = quotaStore()
    const ids = Array.from({ length: 21 }, (_, index) => `acc_${index + 1}`)
    for (const [index, id] of ids.entries()) await readQuota(store, credential(index + 1), id)

    // The cap is 20, so the very first reading is gone and the second survives.
    expect(cachedQuotaFor(ids[0]!)).toBeNull()
    expect(cachedQuotaFor(ids[1]!)).not.toBeNull()
    expect(cachedQuotaFor(ids[20]!)).not.toBeNull()
  })
})

describe('kimiCodePoolQuota', () => {
  it('says nothing for an account that was never read', () => {
    expect(kimiCodePoolQuota(null)).toBeUndefined()
  })

  it('never mints a window whose share the payload did not state', () => {
    // A ratio-less entry: the parser drops it outright, so no window — and no
    // 0% bar — can reach the row.
    const quota = kimiCodePoolQuota({
      account: { userId: null, nickname: null, email: null, planName: null, planLevel: null, region: null, authenticatedAt: null },
      planName: null,
      windows: [],
      extraUsage: null,
      fetchedAt: RESET_MS,
      sources: [],
    })
    expect(quota).toEqual({ windows: [], fetchedAt: RESET_MS })
  })

  it('maps the line own fields, milliseconds included', () => {
    const quota = kimiCodePoolQuota({
      account: { userId: null, nickname: null, email: null, planName: null, planLevel: null, region: null, authenticatedAt: null },
      planName: 'GOAT',
      windows: [window({ resetsAt: null, windowDurationMins: null, label: '' })],
      extraUsage: null,
      fetchedAt: RESET_MS,
      sources: [],
    })
    expect(quota?.windows).toEqual([
      { label: '', usedPercent: 42, windowDurationMins: null, resetsAt: null },
    ])
  })
})

describe('kimi-code account rows carry their own quota', () => {
  it('publishes quota for the account with a snapshot and omits it for one without', async () => {
    const accounts = pool()
    const first = await accounts.addAccount(credential(1))
    const second = await accounts.addAccount(credential(2))
    // Nothing has been read yet. "Never read" is not "nothing used", so the row
    // is silent rather than reporting a zero.
    expect((await accounts.listAccounts()).every((entry) => entry.quota === undefined)).toBe(true)

    const stored = (await accounts.read()).accounts.find((entry) => entry.id === first.id)!
    await readQuota(quotaStore(), stored.credentials, first.id)

    const byId = new Map((await accounts.listAccounts()).map((entry) => [entry.id, entry]))
    const quota = byId.get(first.id)?.quota
    expect(quota?.windows[0]).toEqual({
      label: '5-hour',
      usedPercent: 42,
      windowDurationMins: 300,
      resetsAt: RESET_MS,
    })
    expect(quota?.fetchedAt).toBeGreaterThan(0)
    expect(byId.get(second.id)?.quota).toBeUndefined()
  })

  it('does not hand one account the quota of another', async () => {
    const accounts = pool()
    const first = await accounts.addAccount(credential(1))
    const second = await accounts.addAccount(credential(2))
    const records = (await accounts.read()).accounts

    await readQuota(quotaStore(), records.find((entry) => entry.id === second.id)!.credentials, second.id, usagePayload(0.9))

    const byId = new Map((await accounts.listAccounts()).map((entry) => [entry.id, entry]))
    expect(byId.get(second.id)?.quota?.windows[0]?.usedPercent).toBe(90)
    expect(byId.get(first.id)?.quota).toBeUndefined()
  })

  it('publishes only the windows the payload actually measured', async () => {
    const accounts = pool()
    const account = await accounts.addAccount(credential(1))
    const stored = (await accounts.read()).accounts.find((entry) => entry.id === account.id)!

    // `limit_5h` is present but states no ratio: the service is silent about
    // that window, which is not the same as it being spent.
    await readQuota(quotaStore(), stored.credentials, account.id, {
      usages: { limit_5h: {}, limit_7d: { used_ratio: 0.5, reset_time: RESET_MS } },
    })

    const quota = (await accounts.listAccounts()).find((entry) => entry.id === account.id)?.quota
    expect(quota?.windows.map((entry) => entry.label)).toEqual(['Weekly (7-day)'])
  })

  it('builds the account list from memory, with no upstream read per account', async () => {
    const accounts = pool()
    await accounts.addAccount(credential(1))
    await accounts.addAccount(credential(2))

    // Opening the settings card must not cost one usage request per pooled
    // account, so the whole list is built from what is already remembered.
    const upstream = vi.fn(async () => { throw new Error('the card must not read upstream') })
    const realFetch = globalThis.fetch
    globalThis.fetch = upstream as unknown as typeof fetch
    try {
      await accounts.listAccounts()
    } finally {
      globalThis.fetch = realFetch
    }
    expect(upstream).not.toHaveBeenCalled()
  })
})
