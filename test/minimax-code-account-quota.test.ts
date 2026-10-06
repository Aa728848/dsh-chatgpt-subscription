/**
 * Quota follows the account on the MiniMax Code line.
 *
 * The line's usage cache used to be one global slot with no account key at all,
 * which is the shape that makes a bar lie: a rotation moves which credential is
 * spent next, so the slot described whichever account happened to be active
 * when it was read. These tests pin the two halves of the fix — the cache keeps
 * each account's own read (bounded, evicting the oldest), and the pool publishes
 * that read on that account's summary and on no other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearCachedQuota,
  fetchTokenPlanQuota,
  getCachedQuota,
  getCachedQuotaFor,
  parseTokenPlanQuota,
} from '../src/host/minimax-code/client.ts'
import {
  MinimaxCodeAccountPool,
  minimaxCodePoolQuota,
  parseMinimaxCodePoolData,
} from '../src/host/minimax-code/account-pool.ts'
import {
  MinimaxCodeCredentialStore,
  type MinimaxCodeCredentials,
} from '../src/host/minimax-code/token-store.ts'

/** One `model_remains` row, shaped like the service's own answer. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_name: 'general',
    end_time: 1_700_018_000_000,
    current_interval_total_count: 1000,
    current_interval_usage_count: 250,
    current_interval_remaining_percent: 75,
    current_weekly_total_count: 5000,
    current_weekly_usage_count: 1000,
    current_weekly_remaining_percent: 80,
    current_interval_status: 1,
    current_weekly_status: 1,
    weekly_end_time: 1_700_600_000_000,
    ...overrides,
  }
}

function payload(rows: Array<Record<string, unknown>>): unknown {
  return { model_remains: rows }
}

function credential(n: number): MinimaxCodeCredentials {
  return {
    accessToken: 'at-' + n,
    refreshToken: 'rt-' + n,
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    generation: 1,
    loginEpoch: 'signin-' + n,
    buildEnv: 'prod',
    region: 'cn',
    recordKey: null,
    source: 'file',
  }
}

/** A usage endpoint that always answers one valid document. */
function quotaFetch(remainingPercent = 75): { fetchFn: typeof fetch; calls: () => number } {
  const mock = vi.fn(async () => Response.json(payload([row({ current_interval_remaining_percent: remainingPercent })])))
  return { fetchFn: mock as unknown as typeof fetch, calls: () => mock.mock.calls.length }
}

/** Mirrors the platform pool backends: JSON, with the parse hook applied on read. */
class PoolBackend {
  private data: unknown = null
  private readonly parse: (value: unknown) => unknown
  constructor(parse: (value: unknown) => unknown) {
    this.parse = parse
  }
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

let dshHome = ''
let minimaxHome = ''

beforeEach(async () => {
  clearCachedQuota()
  dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-quota-home-'))
  // An EMPTY MiniMax home: no test may adopt the developer's real ~/.minimax.
  minimaxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-quota-native-'))
  process.env.DSH_HOME = dshHome
  process.env.MINIMAX_HOME = minimaxHome
})

afterEach(() => {
  clearCachedQuota()
  delete process.env.DSH_HOME
  delete process.env.MINIMAX_HOME
  delete process.env.DSH_MINIMAX_CODE_QUOTA_HOST
  vi.restoreAllMocks()
})

function harness() {
  const store = new MinimaxCodeCredentialStore('cn')
  const backend = new PoolBackend(parseMinimaxCodePoolData)
  return { pool: new MinimaxCodeAccountPool({ store, backend: backend as never }), store }
}

describe('minimaxCodePoolQuota', () => {
  it('names each window from its length instead of shipping display text', () => {
    const quota = parseTokenPlanQuota(payload([row()]), 1_700_000_000_000)!
    const dto = minimaxCodePoolQuota(quota)!
    expect(dto.fetchedAt).toBe(1_700_000_000_000)
    // The line's own card calls these 5 小时窗口 / 每周窗口, so 300 / 10080 minutes
    // is what lets the shared account card name an unlabeled window.
    expect(dto.windows.map((window) => [window.label, window.windowDurationMins])).toEqual([
      ['', 300],
      ['', 10_080],
    ])
    expect(dto.windows[0]!.usedPercent).toBe(25)
    expect(dto.windows[0]!.resetsAt).toBe(1_700_018_000_000)
  })

  it('drops a window nobody measured rather than calling it 0%', () => {
    const dto = minimaxCodePoolQuota({
      label: 'Token Plan',
      fetchedAtMs: 1_700_000_000_000,
      windows: [
        // No percentage was read for this one: a null is not 0.
        { key: 'interval', remainingPercent: null },
        { key: 'weekly', remainingPercent: 80, usedPercent: 20 },
        // Unlimited states no consumed share at all, and the per-account shape
        // cannot say "unlimited", so it is dropped instead of drawn as empty.
        { key: 'weekly', remainingPercent: null, unlimited: true },
      ],
    })!
    expect(dto.windows).toHaveLength(1)
    expect(dto.windows[0]!.usedPercent).toBe(20)
    expect(dto.windows[0]!.windowDurationMins).toBe(10_080)
  })

  it('publishes the single figure a snapshot stated, unnamed and unmeasured as a window', () => {
    const dto = minimaxCodePoolQuota({ label: 'Token Plan', usedPercent: 40, resetsAtMs: 999, fetchedAtMs: 5 })!
    expect(dto.fetchedAt).toBe(5)
    expect(dto.windows).toEqual([{
      label: '',
      usedPercent: 40,
      windowDurationMins: null,
      // Seconds are told apart from milliseconds by magnitude (see quotaResetMs).
      resetsAt: 999_000,
    }])
  })

  it('publishes nothing for a snapshot with no read time, or no snapshot at all', () => {
    expect(minimaxCodePoolQuota({ label: 'Token Plan', usedPercent: 40 })).toBeUndefined()
    expect(minimaxCodePoolQuota(null)).toBeUndefined()
    expect(minimaxCodePoolQuota(undefined)).toBeUndefined()
  })
})

describe('MiniMax Code per-account usage cache', () => {
  it('keeps two accounts apart and never serves one the other numbers', async () => {
    const first = quotaFetch(75)
    await fetchTokenPlanQuota(credential(1), { fetchFn: first.fetchFn, accountId: 'acc_a' })
    expect(getCachedQuotaFor('acc_a')!.windows![0]!.usedPercent).toBe(25)
    expect(getCachedQuotaFor('acc_b')).toBeNull()
    // The no-argument accessor keeps its pre-pool meaning: the newest read.
    expect(getCachedQuota()).not.toBeNull()
    expect(getCachedQuotaFor()).not.toBeNull()

    // A read for the other account is a real read, not a reused snapshot.
    const second = quotaFetch(10)
    await fetchTokenPlanQuota(credential(2), { fetchFn: second.fetchFn, accountId: 'acc_b' })
    expect(second.calls()).toBe(1)
    expect(getCachedQuotaFor('acc_b')!.windows![0]!.usedPercent).toBe(90)
    // The first account still holds its own reading.
    expect(getCachedQuotaFor('acc_a')!.windows![0]!.usedPercent).toBe(25)

    clearCachedQuota()
    expect(getCachedQuotaFor('acc_a')).toBeNull()
    expect(getCachedQuotaFor('acc_b')).toBeNull()
    expect(getCachedQuota()).toBeNull()
  })

  it('remembers a bounded number of accounts, evicting the oldest', async () => {
    const { fetchFn } = quotaFetch()
    for (let index = 1; index <= 21; index += 1) {
      await fetchTokenPlanQuota(credential(index), { fetchFn, accountId: 'acc_' + index, force: true })
    }
    // 21 accounts read, 20 kept: the first one read is the one evicted.
    expect(getCachedQuotaFor('acc_1')).toBeNull()
    expect(getCachedQuotaFor('acc_2')).not.toBeNull()
    expect(getCachedQuotaFor('acc_21')).not.toBeNull()
  })

  it('serves an account the last numbers it read, and says they are stale', async () => {
    const ok = quotaFetch(75)
    await fetchTokenPlanQuota(credential(1), { fetchFn: ok.fetchFn, accountId: 'acc_a' })
    const failing = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const fallback = await fetchTokenPlanQuota(credential(1), { fetchFn: failing, accountId: 'acc_a', force: true })
    expect(fallback!.windows![0]!.usedPercent).toBe(25)
    expect(getCachedQuotaFor('acc_a')!.windows![0]!.usedPercent).toBe(25)
  })
})

describe('MiniMax Code pool summaries', () => {
  it('attributes a credential-less read to the account that would serve next', async () => {
    const { pool } = harness()
    const first = await pool.addAccount(credential(1))
    const second = await pool.addAccount(credential(2))
    // A stub that must never be called: resolving the target performs no network
    // request and moves no rotation state.
    const fetchFn = vi.fn(async () => { throw new Error('the read target must not fetch') }) as unknown as typeof fetch

    expect((await pool.getQuotaReadTarget(fetchFn)).accountId).toBe(first.id)
    await pool.setPrimary(second.id)
    expect((await pool.getQuotaReadTarget(fetchFn)).accountId).toBe(second.id)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('publishes quota on the account that has a snapshot and omits it on one that has none', async () => {
    const { pool } = harness()
    const read = await pool.addAccount(credential(1))
    const unread = await pool.addAccount(credential(2))

    const { fetchFn, calls } = quotaFetch()
    await fetchTokenPlanQuota(read.credentials, { fetchFn, accountId: read.id, force: true })

    const summaries = await pool.listAccounts()
    const published = summaries.find((entry) => entry.id === read.id)!
    expect(published.quota?.windows.map((window) => window.windowDurationMins)).toEqual([300, 10_080])
    expect(published.quota?.windows[0]?.usedPercent).toBe(25)
    // Absent means "never read for this account" — a different claim from
    // "nothing used", which is why it is not an empty snapshot.
    expect(summaries.find((entry) => entry.id === unread.id)!.quota).toBeUndefined()

    // Building the list is a memory read: it starts no upstream request.
    const before = calls()
    await pool.listAccounts()
    expect(calls()).toBe(before)
  })
})
