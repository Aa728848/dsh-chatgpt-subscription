/**
 * WorkBuddy quota follows the account, not the line.
 *
 * The pool's settings card renders each account its own reading, which needs
 * two things this file pins: the quota cache remembers one newest snapshot PER
 * ACCOUNT (bounded, oldest evicted) instead of one slot that only ever
 * described whichever account was read last, and the pool publishes that
 * snapshot on the account it belongs to — and on no other.
 *
 * The mapping from the billing DTO is pinned here too, because it is the one
 * place that decides which of the DTO's fields is the consumed share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkBuddyAccountQuota, WorkBuddyMeter } from '../src/shared/workbuddy-contracts.ts'
import {
  WorkBuddyAccountPool,
  parseWorkBuddyPoolData,
  workBuddyPoolQuota,
} from '../src/host/workbuddy/account-pool.ts'
import {
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  getCachedQuotaFor,
} from '../src/host/workbuddy/client.ts'
import { getWorkBuddyWebStatus } from '../src/host/workbuddy/routes.ts'
import { FileModelSettingsStore, type WorkBuddyCredentials } from '../src/host/workbuddy/token-store.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'

const temporaryDirs: string[] = []

/** One managed account in the store, addressable as `cn:u<n>`. */
function credentials(n: number): WorkBuddyCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 3_600_000,
    region: 'cn',
    domain: 'copilot.tencent.com',
    backend: 'https://copilot.tencent.com',
    uid: `u${n}`,
    sourceFile: '',
    sourceMtimeMs: 0,
    source: 'managed',
  }
}

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-quota-accounts-'))
  temporaryDirs.push(dir)
  return dir
}

/** A cycle and a package: 200/500 cycle credits and 400/1000 package credits. */
const BILLING = {
  code: 0,
  data: {
    Response: {
      Data: {
        Accounts: [{
          PackageName: 'Free Plan',
          CapacitySize: 1000,
          CapacityRemain: 400,
          CycleCapacityUsed: 200,
          CycleCapacitySize: 500,
        }],
      },
    },
  },
}

function billingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    if (String(url).includes('billing')) return Response.json(BILLING)
    // The catalog route answers with an empty model list; the shipped table
    // stands in and the status is still about quota.
    return Response.json({ code: 0, data: { models: [] } })
  })
}

function meter(overrides: Partial<WorkBuddyMeter> = {}): WorkBuddyMeter {
  return {
    id: 'meter',
    label: 'Meter',
    usedFraction: null,
    remainingFraction: null,
    used: null,
    limit: null,
    resetsAt: null,
    description: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<WorkBuddyAccountQuota> = {}): WorkBuddyAccountQuota {
  return {
    account: {
      id: 'cn:u1',
      uid: 'u1',
      nickname: null,
      uin: null,
      accountType: null,
      enterpriseId: null,
      region: 'cn',
      backend: 'https://copilot.tencent.com',
      domain: 'copilot.tencent.com',
      expiresAt: null,
      sourceFile: null,
      source: 'managed',
      removable: true,
      hidden: false,
    },
    packageName: 'Free Plan',
    totalCredits: 1000,
    remainingCredits: 400,
    cycleUsedCredits: 200,
    cycleCredits: 500,
    cycleStartsAt: null,
    cycleEndsAt: null,
    meters: [],
    fetchedAt: 1_700_000_000_000,
    sources: [],
    ...overrides,
  }
}

afterEach(async () => {
  clearCachedQuota()
  clearCachedCatalog()
  for (const dir of temporaryDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('WorkBuddy per-account quota cache', () => {
  it('keeps two accounts apart and still answers "whatever was read last"', async () => {
    const dir = await makeRoot()
    const store = createWorkBuddyStore(dir)
    await store.addManaged(credentials(1))
    await store.addManaged(credentials(2))
    const fetchFn = billingFetch()

    const first = await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, 'cn:u1')
    // Wait long enough that the second read is unambiguously the newer one.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, 'cn:u2')

    expect(first.account.id).toBe('cn:u1')
    expect(getCachedQuotaFor('cn:u1')).toBe(first)
    expect(getCachedQuotaFor('cn:u2')).toBe(second)
    expect(getCachedQuotaFor('cn:u3')).toBeUndefined()
    expect(getCachedQuota()).toBe(second)
  })

  it('evicts the oldest read once more than 20 accounts are remembered', async () => {
    const dir = await makeRoot()
    const store = createWorkBuddyStore(dir)
    const fetchFn = billingFetch()

    for (let index = 1; index <= 21; index += 1) {
      await store.addManaged(credentials(index))
      await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, `cn:u${index}`)
    }

    expect(getCachedQuotaFor('cn:u1')).toBeUndefined()
    expect(getCachedQuotaFor('cn:u2')).toBeDefined()
    expect(getCachedQuotaFor('cn:u21')).toBeDefined()
  })
})

describe('WorkBuddy pool quota summary', () => {
  it('publishes the snapshot on the account it belongs to and omits it elsewhere', async () => {
    const dir = await makeRoot()
    const store = createWorkBuddyStore(dir)
    await store.addManaged(credentials(1))
    await store.addManaged(credentials(2))
    const pool = new WorkBuddyAccountPool({
      store,
      backend: new PoolBackend(parseWorkBuddyPoolData) as never,
    })
    await pool.addAccount(credentials(1))
    await pool.addAccount(credentials(2))
    const fetchFn = billingFetch()
    await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, 'cn:u1')

    // Building the account list must never fan out an upstream request per
    // pooled account: the snapshot is a memory read.
    const callsBefore = fetchFn.mock.calls.length as number
    const accounts = await pool.listAccounts()
    expect(fetchFn.mock.calls.length).toBe(callsBefore)
    expect(accounts.find((account) => account.id === 'cn:u1')?.quota).toMatchObject({
      fetchedAt: expect.any(Number),
      windows: [
        { label: 'Billing cycle', usedPercent: 40 },
        { label: 'Free Plan', usedPercent: 60 },
      ],
    })
    // Absent means "never read for this account", which is not "nothing used".
    const unread = accounts.find((account) => account.id === 'cn:u2')
    expect(unread?.quota).toBeUndefined()
    expect(unread === undefined ? true : 'quota' in unread).toBe(false)
  })

  it('states the page-level facts from the selected account, not the newest snapshot', async () => {
    const dir = await makeRoot()
    const store = createWorkBuddyStore(dir)
    await store.addManaged(credentials(1))
    await store.addManaged(credentials(2))
    const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))
    await settings.updateSettings({ selectedAccountId: 'cn:u1' })
    const fetchFn = billingFetch()

    await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, 'cn:u1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await fetchAccountQuota(store, fetchFn as unknown as typeof fetch, false, 'cn:u2')

    // The newest snapshot belongs to the other account; the page-level facts
    // describe this one, so they may only be read from this one.
    expect(getCachedQuota()?.account.id).toBe('cn:u2')
    const status = await getWorkBuddyWebStatus(store, settings, undefined, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(status.quota?.account.id).toBe('cn:u1')
    // The sibling's reading survives the read, which is what lets every account
    // row draw its own bar.
    expect(getCachedQuotaFor('cn:u2')).toBeDefined()
  })

  it('drops a meter that measured no share instead of drawing 0', () => {
    const quota = workBuddyPoolQuota(snapshot({
      cycleCredits: null,
      cycleUsedCredits: null,
      meters: [
        meter({ id: 'package', label: 'Free Plan', usedFraction: 0.25, remainingFraction: 0.75 }),
        meter({ id: 'unmeasured', label: '未测量' }),
      ],
    }))

    expect(quota?.windows.map((window) => window.label)).toEqual(['Free Plan'])
    expect(quota?.windows[0]?.usedPercent).toBe(25)
  })

  it('derives the consumed share from the remaining fraction when that is the one stated', () => {
    const quota = workBuddyPoolQuota(snapshot({
      cycleCredits: null,
      cycleUsedCredits: null,
      meters: [meter({ id: 'package', label: 'Free Plan', usedFraction: null, remainingFraction: 0.4 })],
    }))

    // 40% left is 60% consumed — the DTO states the share, so the bar may draw.
    expect(quota?.windows).toHaveLength(1)
    expect(quota?.windows[0]?.usedPercent).toBeCloseTo(60, 6)
  })

  it('publishes the cycle counters as a window only when no meter already states them', () => {
    const fromCycleFields = workBuddyPoolQuota(snapshot({ meters: [] }))
    expect(fromCycleFields?.windows).toEqual([{
      label: 'Free Plan',
      usedPercent: 40,
      windowDurationMins: null,
      resetsAt: null,
    }])

    // The line's own `cycle` meter already carries the same allowance; drawing
    // it twice under two names would report one reading as two.
    const withCycleMeter = workBuddyPoolQuota(snapshot({
      meters: [meter({ id: 'cycle', label: 'Billing cycle', usedFraction: 0.4, remainingFraction: 0.6 })],
    }))
    expect(withCycleMeter?.windows.map((window) => window.label)).toEqual(['Billing cycle'])
  })
})
