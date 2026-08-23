import { describe, expect, it, vi } from 'vitest'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { mapCodexUsage, parseCodexUsage, parseResetCredits, UsageService } from '../src/host/usage-service.ts'

describe('Codex usage mapping', () => {
  it('maps both buckets, clamps percentages, and rejects invalid windows', () => {
    expect(mapCodexUsage({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 120, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: -5, limit_window_seconds: 604_800 },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: null },
        secondary_window: { used_percent: 80, limit_window_seconds: 3_600 },
      },
    })).toEqual([
      {
        id: 'codex', name: 'Codex', planType: 'pro',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
        windows: [
          { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000_000_000 },
          { usedPercent: 0, windowDurationMins: 10_080, resetsAt: null },
        ],
      },
      {
        id: 'code-review', name: 'Code review', planType: 'pro', primary: null,
        secondary: { usedPercent: 80, windowDurationMins: 60, resetsAt: null },
        windows: [
          { usedPercent: 80, windowDurationMins: 60, resetsAt: null },
        ],
      },
    ])
  })

  it('maps additional limits, credits, spend control, and reset credits', () => {
    const usage = parseCodexUsage({
      plan_type: 'team',
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: [
        {
          metered_feature: 'codex_spark',
          limit_name: 'Spark',
          rate_limit: { primary_window: { used_percent: 65, limit_window_seconds: 3600 } },
        },
      ],
      credits: { has_credits: true, unlimited: false, balance: '12.50' },
      spend_control: {
        reached: true,
        individual_limit: { limit: '100', used: '87', remaining_percent: 13, reset_at: 2_100_000_000 },
      },
      rate_limit_reset_credits: { available_count: 3 },
    })
    expect(usage.buckets.map((bucket) => bucket.id)).toEqual(['codex', 'spark'])
    expect(usage.buckets[1]?.windows[0]?.usedPercent).toBe(65)
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.50' })
    expect(usage.spendControlReached).toBe(true)
    expect(usage.individualLimit).toMatchObject({ remainingPercent: 13, resetsAt: 2_100_000_000 })
    expect(usage.resetCredits).toEqual({ availableCount: 3, expiresAt: null })
  })

  it('maps available reset credits and selects the earliest expiry first', () => {
    expect(parseResetCredits({
      available_count: 2,
      credits: [
        { id: 'later', status: 'available', expires_at: '2030-02-01T00:00:00Z' },
        { id: 'redeemed', status: 'redeemed', expires_at: '2029-01-01T00:00:00Z' },
        { id: 'sooner', status: 'available', expires_at: '2030-01-01T00:00:00Z' },
      ],
    })).toEqual({
      availableCount: 2,
      expiresAt: Date.parse('2030-01-01T00:00:00Z') / 1000,
      availableCreditIds: ['sooner', 'later'],
    })
  })

  it('lists, consumes, and refreshes after using one reset credit', async () => {
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'a', refreshToken: 'r', accountId: 'account-1', expiresAt: Date.now() + 3_600_000 })
    const oauth = new OAuthService(store)
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(Response.json({ available_count: 1, credits: [{ id: 'credit-1', status: 'available', expires_at: '2030-01-01T00:00:00Z' }] }))
      .mockResolvedValueOnce(Response.json({ code: 'reset', windows_reset: 1 }))
      .mockResolvedValueOnce(Response.json({ rate_limit: { primary_window: { used_percent: 0 } }, rate_limit_reset_credits: { available_count: 0 } }))
    const service = new UsageService(oauth, { fetchFn: fetchFn as typeof fetch })
    const result = await service.consumeResetCredit()
    expect(result.buckets[0]?.primary?.usedPercent).toBe(0)
    expect(result.resetCredits).toEqual({ availableCount: 0, expiresAt: null })
    const [consumeUrl, consumeInit] = fetchFn.mock.calls[1] as unknown as [string, RequestInit]
    expect(consumeUrl).toContain('/rate-limit-reset-credits/consume')
    expect(consumeInit.method).toBe('POST')
    expect((consumeInit.headers as Record<string, string>)['chatgpt-account-id']).toBe('account-1')
    expect(JSON.parse(String(consumeInit.body))).toMatchObject({ credit_id: 'credit-1' })
    expect(JSON.parse(String(consumeInit.body)).redeem_request_id).toMatch(/^[0-9a-f-]{36}$/)
    oauth.dispose()
  })

  it('caches for 60 seconds and throttles forced upstream refreshes', async () => {
    let now = 1_000_000
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 3_600_000 })
    const oauth = new OAuthService(store, { now: () => now })
    const fetchFn = vi.fn(async () => Response.json({
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3_600 } },
    }))
    const service = new UsageService(oauth, { fetchFn: fetchFn as typeof fetch, now: () => now })
    expect((await service.status(true)).state).toBe('ready')
    await service.status(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    now += 5_000
    expect((await service.status(true, true)).stale).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    now += 15_000
    await service.status(true, true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    oauth.dispose()
  })

  it('keeps old data and honors Retry-After after a 429', async () => {
    let now = 5_000_000
    const store = new MemoryTokenStore()
    await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 3_600_000 })
    const oauth = new OAuthService(store, { now: () => now })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(Response.json({ rate_limit: { primary_window: { used_percent: 42 } } }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '30' } }))
    const service = new UsageService(oauth, { fetchFn: fetchFn as typeof fetch, now: () => now })
    await service.status(true)
    now += 15_000
    const limited = await service.status(true, true)
    expect(limited.state).toBe('stale')
    expect(limited.buckets[0]?.primary?.usedPercent).toBe(42)
    now += 15_000
    await service.status(true, true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    oauth.dispose()
  })
})
