/**
 * Quota follows the account, not the line.
 *
 * The pool's settings card renders each account its own reading, which needs
 * two things this file pins: the quota cache remembers one newest snapshot PER
 * ACCOUNT (bounded, oldest evicted) instead of one slot that only ever
 * described whichever key was read last, and the pool publishes that snapshot
 * on the account it belongs to — and on no other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCodeAccountQuota } from '../src/shared/command-code-contracts.ts'
import {
  CommandCodeAccountPool,
  commandCodePoolQuota,
  parseCommandCodePoolData,
} from '../src/host/command-code/account-pool.ts'
import {
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  getCachedQuotaFor,
} from '../src/host/command-code/client.ts'
import type { CommandCodeCredentials } from '../src/host/command-code/token-store.ts'
import { FileCredentialStore } from '../src/host/command-code/token-store.ts'

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function key(n: number): CommandCodeCredentials {
  return {
    apiKey: `cmd-key-${n}`,
    userId: `user-${n}`,
    userName: `User ${n}`,
    email: `user${n}@example.com`,
    keyName: `laptop-${n}`,
    planLabel: 'GOAT',
    authenticatedAt: Date.now(),
  }
}

/** Answers the four routes one snapshot reads, with a measured 5-hour window. */
function usageFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    if (String(url).includes('/alpha/usage/summary')) {
      return Response.json({
        data: {
          windows: [{ id: 'w1', label: '5 小时', usedPercent: 40, windowDurationMins: 300 }],
        },
      })
    }
    return Response.json({ data: {} })
  })
}

function emptyQuota(overrides: Partial<CommandCodeAccountQuota> = {}): CommandCodeAccountQuota {
  return {
    account: {
      userId: null,
      userName: null,
      email: null,
      organizationName: null,
      keyName: null,
      planLabel: null,
      planId: null,
      authenticatedAt: null,
    },
    creditBalance: null,
    unlimited: false,
    planId: null,
    planName: null,
    planMonthlyCredits: null,
    subscriptionStatus: null,
    periodEndsAt: null,
    meters: [],
    windows: [],
    fetchedAt: 1_700_000_000_000,
    sources: [],
    ...overrides,
  }
}

afterEach(() => {
  clearCachedQuota()
  vi.restoreAllMocks()
})

describe('Command Code per-account quota cache', () => {
  it('keeps two accounts apart and still answers "whatever was read last"', async () => {
    const source = { read: async () => key(1) }
    const fetchFn = usageFetch()

    const first = await fetchAccountQuota(source, fetchFn as unknown as typeof fetch, false, 'acc_a')
    // Wait long enough that the second read is unambiguously the newer one.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await fetchAccountQuota(source, fetchFn as unknown as typeof fetch, false, 'acc_b')

    // Each account keeps its own entry, and neither is served to the other.
    expect(getCachedQuotaFor('acc_a')).toBe(first)
    expect(getCachedQuotaFor('acc_b')).toBe(second)
    expect(getCachedQuotaFor('acc_c')).toBeUndefined()
    // The no-argument form keeps its pre-pool meaning: the most recent read.
    expect(getCachedQuota()).toBe(second)
    // The second read was a real read, not the first account's snapshot reused.
    expect(Math.floor((fetchFn.mock.calls.length as number) / 4)).toBe(2)
  })

  it('evicts the oldest read once more than 20 accounts are remembered', async () => {
    const source = { read: async () => key(1) }
    const fetchFn = usageFetch()

    for (let index = 0; index <= 20; index += 1) {
      await fetchAccountQuota(source, fetchFn as unknown as typeof fetch, false, `acc_${index}`)
    }

    expect(getCachedQuotaFor('acc_0')).toBeUndefined()
    expect(getCachedQuotaFor('acc_1')).toBeDefined()
    expect(getCachedQuotaFor('acc_20')).toBeDefined()
  })
})

describe('Command Code pool quota summary', () => {
  it('publishes the snapshot on the account it belongs to and omits it elsewhere', async () => {
    const backend = new PoolBackend(parseCommandCodePoolData)
    // The mirror store is an in-memory double: the pool must never be given the
    // host's real credential file just to build a summary.
    const pool = new CommandCodeAccountPool({
      store: new FileCredentialStore('cc-quota-accounts.json', {
        async load() { return null },
        async save() { /* nothing to persist in a summary test */ },
        async clear() { /* nothing to persist in a summary test */ },
      }),
      backend: backend as never,
    })
    const first = await pool.addAccount(key(1))
    const second = await pool.addAccount(key(2))
    const fetchFn = usageFetch()
    await fetchAccountQuota(
      { read: async () => key(1) },
      fetchFn as unknown as typeof fetch,
      false,
      first.id,
    )

    // Building the account list must never fan out an upstream request per
    // pooled key: the snapshot is a memory read.
    const callsBefore = fetchFn.mock.calls.length as number
    const accounts = await pool.listAccounts()
    expect(fetchFn.mock.calls.length).toBe(callsBefore)
    expect(accounts.find((account) => account.id === first.id)?.quota).toMatchObject({
      fetchedAt: expect.any(Number),
      windows: [{ label: '5 小时', usedPercent: 40, windowDurationMins: 300 }],
    })
    // Absent means "never read for this account", which is not "nothing used".
    const unread = accounts.find((account) => account.id === second.id)
    expect(unread?.quota).toBeUndefined()
    expect(unread === undefined ? true : 'quota' in unread).toBe(false)
  })

  it('drops a window whose share nobody measured instead of drawing 0', () => {
    const quota = commandCodePoolQuota(emptyQuota({
      windows: [
        { id: 'w1', label: '5 小时', usedPercent: 40, windowDurationMins: 300, resetsAt: 1_700_000_000_000 },
        { id: 'w2', label: '每周', usedPercent: Number.NaN, windowDurationMins: 10_080, resetsAt: null },
      ],
    }))

    expect(quota?.windows).toHaveLength(1)
    expect(quota?.windows[0]).toMatchObject({
      label: '5 小时',
      usedPercent: 40,
      windowDurationMins: 300,
      // The DTO states Unix milliseconds, and milliseconds is what the card
      // receives — no second conversion on the way through.
      resetsAt: 1_700_000_000_000,
    })
    // No read time is not a snapshot either: the card's whole promise is "this
    // is what we last saw, at this time".
    expect(commandCodePoolQuota(emptyQuota({ fetchedAt: 0 }))).toBeUndefined()
  })
})
