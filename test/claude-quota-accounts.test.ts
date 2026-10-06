/**
 * The Claude line's per-account quota cache and the snapshot each row carries.
 *
 * WHY THIS FILE EXISTS. Quota follows the ACCOUNT, not the line: rotation
 * decides which account spends the next request, so a single-slot cache could
 * only ever describe whichever account was read last. Two properties have to
 * hold for the account card to be honest, and neither is visible to a type
 * checker:
 *
 *   1. two accounts' readings never displace one another, and the map is
 *      bounded so a long-lived host cannot accumulate one snapshot per token it
 *      has ever seen;
 *   2. a window whose consumed share nobody measured is DROPPED from the row
 *      rather than drawn as 0% — "not stated" and "nothing used" are different
 *      claims, and a bar is the one place the difference becomes a lie.
 *
 * Everything runs against an injected fetch. No test here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { ClaudeAccountPool, claudePoolQuota } from '../src/host/claude/account-pool.ts'
import {
  cachedQuotaFor,
  cachedQuotaForPool,
  clearCachedCatalog,
  clearCachedQuota,
  fetchAccountQuota,
  getCachedQuota,
  type ClaudeAccountQuota,
  type ClaudeUsageWindow,
} from '../src/host/claude/client.ts'
import { FileCredentialStore, type ClaudeCredentials } from '../src/host/claude/token-store.ts'

const RESET_ISO = '2030-06-15T05:00:00.000Z'
const RESET_MS = Date.parse(RESET_ISO)

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** Mirrors the platform backends: JSON in memory, and the parse hook on read. */
class MemoryBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/** A managed credential for account n, as the pool stores it. */
function credential(n: number): ClaudeCredentials {
  return {
    accessToken: `at-${n}`,
    refreshToken: `rt-${n}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
  }
}

/** The documented usage payload, with only the windows each test needs. */
function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    five_hour: { utilization: 25, resets_at: RESET_ISO },
    seven_day: { utilization: 0, resets_at: '2030-06-22T00:00:00.000Z' },
    seven_day_sonnet: null,
    ...overrides,
  }
}

/** Read one account's usage through the real client, over an injected fetch. */
function readQuota(
  credentials: ClaudeCredentials,
  payload: Record<string, unknown>,
  accountId?: string,
): Promise<ClaudeAccountQuota> {
  const fetchFn = (async () => Response.json(payload)) as unknown as typeof fetch
  return fetchAccountQuota(credentials, {
    fetchFn,
    force: true,
    ...(accountId === undefined ? {} : { accountId }),
  })
}

function pool(): ClaudeAccountPool {
  return new ClaudeAccountPool({
    store: new FileCredentialStore(tmpFile('claude-quota-doc'), new MemoryBackend() as never),
    backend: new MemoryBackend() as never,
  })
}

/** One hand-built window, so a mapping case the wire cannot state is reachable. */
function window(overrides: Partial<ClaudeUsageWindow> = {}): ClaudeUsageWindow {
  return {
    id: 'five_hour',
    label: '5-hour',
    windowMinutes: 300,
    usedFraction: 0.25,
    usedPercent: 25,
    remainingPercent: 75,
    resetsAt: RESET_ISO,
    source: 'usage',
    ...overrides,
  }
}

function snapshot(windows: ClaudeUsageWindow[], overrides: Partial<ClaudeAccountQuota> = {}): ClaudeAccountQuota {
  return {
    windows,
    extraUsage: null,
    fetchedAt: RESET_MS - 60_000,
    observedAt: RESET_MS - 60_000,
    status: null,
    representativeClaim: null,
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

describe('claude per-account quota cache', () => {
  it('keeps two accounts apart, and answers "latest" only when asked without one', async () => {
    const first = credential(1)
    const second = credential(2)
    await readQuota(first, usagePayload({ five_hour: { utilization: 20, resets_at: RESET_ISO } }))
    await readQuota(second, usagePayload({ five_hour: { utilization: 90, resets_at: RESET_ISO } }))

    // The later read of the OTHER account does not displace the first one.
    expect(cachedQuotaFor(first)?.windows[0]?.usedPercent).toBe(20)
    expect(getCachedQuota(first)?.windows[0]?.usedPercent).toBe(20)
    expect(getCachedQuota(second)?.windows[0]?.usedPercent).toBe(90)
    // Without a credential the pre-pool answer is kept: whatever was read last.
    expect(getCachedQuota()?.windows[0]?.usedPercent).toBe(90)
  })

  it('drops every snapshot on clear, and answers null for an account never read', async () => {
    const first = credential(1)
    await readQuota(first, usagePayload())
    expect(cachedQuotaFor(credential(9))).toBeNull()

    clearCachedQuota()
    expect(getCachedQuota(first)).toBeNull()
    expect(getCachedQuota()).toBeNull()
  })

  it('evicts the oldest reading once more accounts than the cap have been read', async () => {
    const credentials = Array.from({ length: 21 }, (_, index) => credential(index + 1))
    for (const entry of credentials) await readQuota(entry, usagePayload())

    // The cap is 20, so the very first reading is gone and the second survives.
    expect(cachedQuotaFor(credentials[0]!)).toBeNull()
    expect(cachedQuotaFor(credentials[1]!)).not.toBeNull()
    expect(cachedQuotaFor(credentials[20]!)).not.toBeNull()
  })
})

describe('claude pool-row keying', () => {
  it('keeps a row\'s snapshot across the token rotation every refresh performs', async () => {
    const before = credential(1)
    await readQuota(before, usagePayload({ five_hour: { utilization: 33, resets_at: RESET_ISO } }), 'acc_row_1')

    // The pool refreshed the token: the row is the same, the credential is not.
    const rotated: ClaudeCredentials = { ...before, accessToken: 'at-1-rotated', refreshToken: 'rt-1-rotated' }
    expect(cachedQuotaForPool('acc_row_1', rotated)?.windows[0]?.usedPercent)
      .toBe(33)
    // The token-tail form has nothing for the new token, and another row is never
    // answered with this reading.
    expect(cachedQuotaFor(rotated)).toBeNull()
    expect(cachedQuotaForPool('acc_row_2', rotated)).toBeNull()
  })

  it('serves a row-keyed read from its own row cache rather than from the newest read', async () => {
    const first = credential(1)
    const second = credential(2)
    await readQuota(first, usagePayload({ five_hour: { utilization: 20, resets_at: RESET_ISO } }), 'acc_row_1')
    await readQuota(second, usagePayload({ five_hour: { utilization: 90, resets_at: RESET_ISO } }), 'acc_row_2')

    // Both rows keep their own reading; the second read did not overwrite the first.
    expect(cachedQuotaForPool('acc_row_1', first)?.windows[0]?.usedPercent).toBe(20)
    expect(cachedQuotaForPool('acc_row_2', second)?.windows[0]?.usedPercent).toBe(90)
    // A row whose credential names no row of its own falls back to its token tail.
    expect(cachedQuotaForPool(undefined, first)).toBeNull()
  })
})

describe('claudePoolQuota', () => {
  it('says nothing for an account that was never read', () => {
    expect(claudePoolQuota(null)).toBeUndefined()
  })

  it('drops a window whose consumed share nobody measured', () => {
    const quota = claudePoolQuota(snapshot([
      window({ usedFraction: null, usedPercent: null, remainingPercent: null, resetsAt: null }),
    ]))
    // The snapshot itself exists — it has a read time — but it carries no
    // window to draw, which is the honest outcome, not a 0% bar.
    expect(quota?.windows).toEqual([])
    expect(quota?.fetchedAt).toBe(RESET_MS - 60_000)
  })

  it('derives the share from the remaining one when that is all the source stated', () => {
    const quota = claudePoolQuota(snapshot([window({ usedPercent: null, usedFraction: null, remainingPercent: 30 })]))
    expect(quota?.windows).toEqual([
      { label: '5-hour', usedPercent: 70, windowDurationMins: 300, resetsAt: RESET_MS },
    ])
  })

  it('files a header-only reading under when those numbers were seen', () => {
    // No full read behind it: `fetchedAt` is null and `observedAt` is the only
    // honest read time, so the row says when this line last saw the numbers.
    const quota = claudePoolQuota(snapshot([window()], { fetchedAt: null, observedAt: 1_700_000_000_000 }))
    expect(quota?.fetchedAt).toBe(1_700_000_000_000)
  })
})

describe('claude account rows carry their own quota', () => {
  it('publishes quota for the account with a snapshot and omits it for one without', async () => {
    const accounts = pool()
    const first = await accounts.addAccount(credential(1))
    const second = await accounts.addAccount(credential(2))
    // Nothing has been read yet. "Never read" is not "nothing used", so the row
    // is silent rather than reporting a zero.
    expect((await accounts.listAccounts()).every((entry) => entry.quota === undefined)).toBe(true)

    const stored = (await accounts.read()).accounts.find((entry) => entry.id === first.id)!
    // The route reads with the row id it resolved, which is what the summary asks
    // with too.
    await readQuota(stored.credentials, usagePayload(), first.id)

    const byId = new Map((await accounts.listAccounts()).map((entry) => [entry.id, entry]))
    const quota = byId.get(first.id)?.quota
    expect(quota?.windows[0]).toEqual({
      label: '5-hour',
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: RESET_MS,
    })
    expect(quota?.fetchedAt).toBeGreaterThan(0)
    expect(byId.get(second.id)?.quota).toBeUndefined()
  })

  it('publishes only the windows the payload actually measured', async () => {
    const accounts = pool()
    const account = await accounts.addAccount(credential(1))
    const stored = (await accounts.read()).accounts.find((entry) => entry.id === account.id)!

    // `five_hour` is present but states no utilization: the payload is silent
    // about that window, which is not the same as it being empty.
    await readQuota(stored.credentials, usagePayload({ five_hour: {} }), account.id)

    const quota = (await accounts.listAccounts()).find((entry) => entry.id === account.id)?.quota
    expect(quota?.windows.map((entry) => entry.label)).toEqual(['Weekly (7 days)'])
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
