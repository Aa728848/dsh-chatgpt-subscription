import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  clearCachedCatalog,
  clearCachedQuota,
  fixedPointToCents,
  loadProviderModels,
  parseExtraUsage,
  parsePlanLevel,
  parsePlanName,
  parseUsageWindows,
  parseUserInfo,
  parseTimestamp,
} from '../src/host/kimi-code/client.ts'
import { FileCredentialStore } from '../src/host/kimi-code/token-store.ts'

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

/** The payload the official parser documents, in the service's snake_case. */
const USAGE_PAYLOAD = {
  goods_version: 2,
  usages: {
    limit_5h: { used_ratio: 0.3, reset_time: '2026-09-11T18:00:00Z' },
    limit_7d: { used_ratio: 0.2, reset_time: '2026-09-17T00:00:00Z' },
    limit_month_total: { used_ratio: 0.4, reset_time: '2026-10-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0.25, reset_time: '2026-10-01T00:00:00Z' },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: '20000000000', amountLeft: '10000000000' },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: 'CNY', priceInCents: '20000' },
    monthlyUsed: { currency: 'CNY', priceInCents: '5000' },
  },
}

afterEach(() => {
  clearCachedQuota()
  clearCachedCatalog()
  vi.restoreAllMocks()
})

describe('parseUsageWindows', () => {
  it('reads every window the service reports with its reset time', () => {
    const windows = parseUsageWindows(USAGE_PAYLOAD)
    expect(windows.map((window) => window.id)).toEqual([
      'limit_5h', 'limit_7d', 'limit_month_total', 'limit_month_code',
    ])
    const fiveHour = windows[0]!
    expect(fiveHour.usedFraction).toBeCloseTo(0.3)
    expect(fiveHour.usedPercent).toBe(30)
    expect(fiveHour.windowDurationMins).toBe(300)
    expect(fiveHour.resetsAt).toBe(Date.parse('2026-09-11T18:00:00Z'))
  })

  it('labels the two monthly pools distinctly so a shared-quota stop is visible', () => {
    const windows = parseUsageWindows(USAGE_PAYLOAD)
    const labels = windows.map((window) => window.label)
    expect(labels).toContain('Monthly (membership)')
    expect(labels).toContain('Monthly (Kimi Code)')
  })

  it('accepts a used_ratio sent as a numeric string', () => {
    const windows = parseUsageWindows({ usages: { limit_5h: { used_ratio: '0.5' } } })
    expect(windows[0]?.usedFraction).toBeCloseTo(0.5)
  })

  it('clamps an out-of-range ratio instead of rendering a broken meter', () => {
    const windows = parseUsageWindows({ usages: { limit_5h: { used_ratio: 1.4 } } })
    expect(windows[0]?.usedFraction).toBe(1)
  })

  it('drops an entry with no usable ratio rather than inventing 0%', () => {
    expect(parseUsageWindows({ usages: { limit_5h: { reset_time: '2026-01-01T00:00:00Z' } } })).toEqual([])
  })

  it('tolerates the alternative usage + limits[] shape', () => {
    // A community-documented variant of the same endpoint; the card should
    // still render rather than blank out if the service switches shape.
    const windows = parseUsageWindows({
      usage: { limit: '2048', used: '214', remaining: '1834', resetTime: '2026-01-09T15:23:13Z' },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used_ratio: 0.7 } }],
    })
    const ids = windows.map((window) => window.id)
    expect(ids).toContain('limit_7d')
    expect(ids).toContain('limit_5h')
  })

  it('returns nothing for an unrecognized payload', () => {
    expect(parseUsageWindows({ unexpected: true })).toEqual([])
  })
})

describe('parseExtraUsage', () => {
  it('converts the fixed-point wallet amounts into cents', () => {
    const wallet = parseExtraUsage(USAGE_PAYLOAD)
    // amounts are 1e-6 cents: 10_000_000_000 / 1_000_000 = 10_000 cents.
    expect(wallet).not.toBeNull()
    expect(wallet?.balanceCents).toBe(10_000)
    expect(wallet?.totalCents).toBe(20_000)
    expect(wallet?.currency).toBe('CNY')
    expect(wallet?.monthlyChargeLimitEnabled).toBe(true)
    expect(wallet?.monthlyChargeLimitCents).toBe(20_000)
    expect(wallet?.monthlyUsedCents).toBe(5_000)
  })

  it('reports no wallet when the balance is not a booster balance', () => {
    expect(parseExtraUsage({ boosterWallet: { balance: { type: 'GIFT', amount: '1000' } } })).toBeNull()
    expect(parseExtraUsage({ boosterWallet: { balance: { type: 'BOOSTER', amount: '0' } } })).toBeNull()
    expect(parseExtraUsage({})).toBeNull()
  })
})

describe('fixedPointToCents', () => {
  it('rounds a positive sub-cent amount up to one cent', () => {
    // "you have something left" is closer to the truth than "you have nothing".
    expect(fixedPointToCents('100')).toBe(1)
    expect(fixedPointToCents('0')).toBe(0)
    expect(fixedPointToCents(undefined)).toBeNull()
  })
})

describe('parseTimestamp', () => {
  it('reads an RFC3339 string, Unix seconds, and Unix milliseconds', () => {
    expect(parseTimestamp('2026-09-11T18:00:00Z')).toBe(Date.parse('2026-09-11T18:00:00Z'))
    expect(parseTimestamp(1_760_000_000)).toBe(1_760_000_000_000)
    expect(parseTimestamp(1_760_000_000_000)).toBe(1_760_000_000_000)
    expect(parseTimestamp(undefined)).toBeNull()
    expect(parseTimestamp('not a date')).toBeNull()
  })
})

describe('parsePlanName and parsePlanLevel', () => {
  it('reads the tier name from the usage payload', () => {
    expect(parsePlanName({ user_level_name: 'Vivace' })).toBe('Vivace')
    expect(parsePlanLevel({ user_level: 30 })).toBe('30')
  })

  it('maps a machine membership code to its marketing name', () => {
    // \`/usages\` dropped \`user_level_name\`, so a raw enum is often all it sends;
    // showing "LEVEL_ADVANCED" to a user would be useless.
    expect(parsePlanName({ user: { membership: { level: 'LEVEL_ADVANCED' } } })).toBe('Allegro')
  })

  it('returns null when the payload names no tier', () => {
    expect(parsePlanName({})).toBeNull()
    expect(parsePlanLevel({})).toBeNull()
  })
})

describe('parseUserInfo', () => {
  it('maps the snake_case profile onto the camelCase DTO', () => {
    const account = parseUserInfo({
      user_id: 'u_123',
      nickname: 'moonwalker',
      email: 'user@example.com',
      user_level_name: 'Vivace',
      user_level: 30,
      region: 'REGION_CN',
    }, { authenticatedAt: 42 })
    expect(account).toMatchObject({
      userId: 'u_123',
      nickname: 'moonwalker',
      email: 'user@example.com',
      planName: 'Vivace',
      planLevel: '30',
      authenticatedAt: 42,
    })
  })

  it('falls back to the stored credential when the profile omits a field', () => {
    const account = parseUserInfo({ user_id: 'u_9' }, { nickname: 'stored', email: 'stored@example.com' })
    expect(account.userId).toBe('u_9')
    expect(account.nickname).toBe('stored')
    expect(account.email).toBe('stored@example.com')
  })
})

describe('loadProviderModels', () => {
  it('reads the live listing and its per-model capabilities', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.kimi.com/coding/v1/models')
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer at-1')
      return new Response(JSON.stringify({
        data: [
          {
            id: 'k3',
            display_name: 'K3',
            context_length: 1_048_576,
            supports_reasoning: true,
            supports_image_in: true,
            supports_video_in: true,
            think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
          },
          { id: 'unknown', display_name: 'No context' },
        ],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const models = await loadProviderModels({
      fetchFn: fetchMock,
      accessToken: 'at-1',
      region: 'mainland-cn',
      force: true,
    })
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'k3',
      name: 'K3',
      contextWindow: 1_048_576,
      reasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'high',
      inputModalities: ['text', 'image'],
    })
  })

  it('returns nothing rather than throwing when the credential cannot be read', async () => {
    const store = new FileCredentialStore(tmp('kc-models-none'))
    vi.spyOn(store, 'read').mockResolvedValue(null)
    const models = await loadProviderModels({ fetchFn: vi.fn() as unknown as typeof fetch, store })
    expect(models).toEqual([])
  })
})
