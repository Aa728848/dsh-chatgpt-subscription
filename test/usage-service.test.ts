import { describe, expect, it, vi } from 'vitest'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { mapCodexUsage, UsageService } from '../src/host/usage-service.ts'

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
      },
      {
        id: 'code-review', name: 'Code review', planType: 'pro', primary: null,
        secondary: { usedPercent: 80, windowDurationMins: 60, resetsAt: null },
      },
    ])
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
