/**
 * Antigravity's quota snapshot belongs to the primary account, and says so.
 *
 * This line has no per-account usage path: its read goes through the legacy
 * single-credential file, which the pool mirrors its PRIMARY account into, and
 * its cache is one global slot with no account key. Under round-robin or sticky
 * the numbers therefore still describe the primary row, so they are published
 * there and nowhere else — never on whichever account happens to be serving.
 *
 * The second half of the file is about the one rule that governs every mapping
 * here: a share nobody measured is NOT zero. A bucket the service stated nothing
 * for must never be published (or drawn) as fully consumed, while a stated 0 is
 * a real reading and must survive.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPoolStore, antigravityPoolQuota } from '../src/host/antigravity/account-pool.ts'
import { clearCachedQuota, fetchAccountQuota, parseQuotaSummary } from '../src/host/antigravity/client.ts'
import { FileCredentialStore, type AntigravityCredentials } from '../src/host/antigravity/token-store.ts'
import type { AntigravityAccountQuota } from '../src/shared/antigravity-contracts.ts'

class MemoryCredentialStore {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function credential(n: number): AntigravityCredentials {
  return {
    access: 'token-' + n,
    refresh: 'refresh-' + n,
    expires: Date.now() + 3_600_000,
    email: 'acc' + n + '@example.com',
    projectId: 'proj-' + n,
  }
}

/** A snapshot as the line's own client caches it. */
function snapshot(overrides: Partial<AntigravityAccountQuota> = {}): AntigravityAccountQuota {
  return {
    projectId: 'proj-1',
    groups: [{
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', displayName: '5 hours', remainingFraction: 0.85, resetTime: '2030-06-15T18:00:00Z' },
        { bucketId: 'gemini-weekly', displayName: 'Weekly', remainingFraction: 1 },
      ],
    }],
    models: [],
    catalogModels: [],
    fetchedAt: Date.parse('2030-06-15T12:00:00Z'),
    ...overrides,
  }
}

describe('antigravityPoolQuota', () => {
  it('draws what is SPENT, from the fraction the service states as left', () => {
    const dto = antigravityPoolQuota(snapshot())!
    expect(dto.fetchedAt).toBe(Date.parse('2030-06-15T12:00:00Z'))
    expect(dto.windows).toHaveLength(2)
    expect(dto.windows[0]!.label).toBe('5 hours')
    expect(dto.windows[0]!.usedPercent).toBeCloseTo(15, 6)
    expect(dto.windows[0]!.resetsAt).toBe(Date.parse('2030-06-15T18:00:00Z'))
    expect(dto.windows[1]!.usedPercent).toBe(0)
    // Nothing in this line interprets a bucket's `window` field as a duration,
    // so no length is claimed and the card names the window from its label.
    expect(dto.windows[0]!.windowDurationMins).toBeNull()
    expect(dto.windows[1]!.resetsAt).toBeNull()
  })

  it('drops a bucket whose fraction was never measured, or is not a share', () => {
    const dto = antigravityPoolQuota(snapshot({
      groups: [{
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'unmeasured', displayName: 'Unmeasured', remainingFraction: null },
          { bucketId: 'nan', displayName: 'Not a number', remainingFraction: Number.NaN },
          { bucketId: 'over', displayName: 'Over one', remainingFraction: 1.4 },
          { bucketId: 'under', displayName: 'Under zero', remainingFraction: -0.2 },
          { bucketId: 'measured', displayName: 'Measured', remainingFraction: 0.5 },
        ],
      }],
    }))!
    expect(dto.windows.map((window) => window.label)).toEqual(['Measured'])
    expect(dto.windows[0]!.usedPercent).toBe(50)
  })

  it('keeps a missing fraction absent, and a stated 0 fully consumed', () => {
    // The parser is where an absent field used to become 0 — which meant "100%
    // used" for a bucket nobody had measured. It must stay absent instead, while
    // a stated 0 (a real reading) still means the allowance is gone.
    const { groups } = parseQuotaSummary({
      groups: [{
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'unmeasured', displayName: 'Unmeasured' },
          { bucketId: 'stringy', displayName: 'Not a number', remainingFraction: '0.5' },
          { bucketId: 'exhausted', displayName: 'Exhausted', remainingFraction: 0 },
        ],
      }],
    })
    expect(groups[0]!.buckets.map((bucket) => bucket.remainingFraction)).toEqual([null, null, 0])

    const dto = antigravityPoolQuota({ groups, models: [], catalogModels: [], fetchedAt: 1_700_000_000_000 })!
    // Only the measured bucket is published, and the stated 0 survives as 100%.
    expect(dto.windows.map((window) => [window.label, window.usedPercent])).toEqual([['Exhausted', 100]])
  })

  it('names a bucket from its group when the bucket name alone identifies nothing', () => {
    const dto = antigravityPoolQuota(snapshot({
      groups: [
        { displayName: 'Gemini', buckets: [{ bucketId: 'a', displayName: '5 hours', remainingFraction: 0.9 }] },
        { displayName: 'Claude', buckets: [{ bucketId: 'b', displayName: '5 hours', remainingFraction: 0.4 }] },
        { displayName: 'Nameless group', buckets: [{ bucketId: 'c', displayName: '', remainingFraction: 0.7 }] },
      ],
    }))!
    expect(dto.windows.map((window) => window.label)).toEqual(['Gemini · 5 hours', 'Claude · 5 hours', 'Nameless group'])
  })

  it('publishes nothing without a snapshot, or without a read time', () => {
    expect(antigravityPoolQuota(undefined)).toBeUndefined()
    expect(antigravityPoolQuota(snapshot({ fetchedAt: 0 }))).toBeUndefined()
  })
})

describe('Antigravity pool summaries', () => {
  beforeEach(() => clearCachedQuota())

  function pool(): AccountPoolStore {
    const legacy = new FileCredentialStore()
    vi.spyOn(legacy, 'read').mockResolvedValue(null)
    vi.spyOn(legacy, 'write').mockResolvedValue(undefined)
    vi.spyOn(legacy, 'delete').mockResolvedValue(undefined)
    return new AccountPoolStore('/tmp/test-pool.json', new MemoryCredentialStore() as never, legacy)
  }

  /**
   * Fill the line's one global quota slot the way a status poll does.
   *
   * The buckets are the UPSTREAM payload, so this exercises the parser as well as
   * the cache: what the service did or did not state is what reaches the pool.
   */
  async function readQuota(buckets: unknown[] = [
    { bucketId: 'gemini-5h', displayName: '5 hours', remainingFraction: 0.85 },
  ]): Promise<void> {
    const store = {
      read: vi.fn(async () => credential(1)),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    } as unknown as FileCredentialStore
    const fetchFn = vi.fn(async (url: string) => url.includes(':retrieveUserQuotaSummary')
      ? Response.json({ groups: [{ displayName: 'Gemini Models', buckets }] })
      : Response.json({})) as unknown as typeof fetch
    await fetchAccountQuota(store, undefined, fetchFn, true)
  }

  it('attaches the snapshot to the primary row and to no other', async () => {
    const store = pool()
    const primary = await store.addAccount(credential(1))
    const secondary = await store.addAccount(credential(2))
    await readQuota()

    const summaries = await store.listAccounts()
    const primarySummary = summaries.find((entry) => entry.id === primary.id)!
    const secondarySummary = summaries.find((entry) => entry.id === secondary.id)!
    expect(primarySummary.isPrimary).toBe(true)
    expect(primarySummary.quota?.windows.map((window) => window.label)).toEqual(['5 hours'])
    expect(primarySummary.quota?.windows[0]?.usedPercent).toBeCloseTo(15, 6)
    // The serving row must not borrow the primary's numbers.
    expect(secondarySummary.quota).toBeUndefined()
  })

  it('publishes no window for a bucket the service never measured', async () => {
    const store = pool()
    const primary = await store.addAccount(credential(1))
    await readQuota([
      { bucketId: 'gemini-5h', displayName: '5 hours', remainingFraction: 0.85 },
      // The service stated nothing for this bucket: absent upstream is not
      // "nothing left", so nothing is published for it either.
      { bucketId: 'gemini-weekly', displayName: 'Weekly' },
    ])

    const summary = (await store.listAccounts()).find((entry) => entry.id === primary.id)!
    expect(summary.quota?.windows.map((window) => window.label)).toEqual(['5 hours'])
    expect(summary.quota?.windows.some((window) => window.usedPercent >= 100)).toBe(false)
  })

  it('publishes nothing while no snapshot was ever read', async () => {
    const store = pool()
    const primary = await store.addAccount(credential(1))
    expect((await store.listAccounts()).find((entry) => entry.id === primary.id)!.quota).toBeUndefined()

    // A sign-out clears the slot; the primary row stops claiming numbers.
    await readQuota()
    expect((await store.listAccounts()).find((entry) => entry.id === primary.id)!.quota).toBeDefined()
    clearCachedQuota()
    expect((await store.listAccounts()).find((entry) => entry.id === primary.id)!.quota).toBeUndefined()
  })
})
