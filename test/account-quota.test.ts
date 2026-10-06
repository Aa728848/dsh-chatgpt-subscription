import { describe, expect, it } from 'vitest'
import { poolQuota, quotaResetMs, quotaWindow } from '../src/host/common/account-quota.ts'
import { codexAccountQuota } from '../src/host/codex-account-pool.ts'
import type { QuotaBucketDto, QuotaUsageDto } from '../src/shared/contracts.ts'

function usage(buckets: QuotaBucketDto[]): QuotaUsageDto {
  return { buckets, credits: null, individualLimit: null, spendControlReached: null, resetCredits: null }
}

function bucket(overrides: Partial<QuotaBucketDto> = {}): QuotaBucketDto {
  return { id: 'codex', name: 'Codex', planType: 'plus', primary: null, secondary: null, windows: [], ...overrides }
}

describe('per-account quota normalization', () => {
  it('reads a reset instant in seconds or in milliseconds', () => {
    expect(quotaResetMs(2_000_000_000)).toBe(2_000_000_000_000)
    expect(quotaResetMs(2_000_000_000_000)).toBe(2_000_000_000_000)
    // Nothing stated, or a time that cannot be one, is not a reset moment.
    expect(quotaResetMs(null)).toBeNull()
    expect(quotaResetMs(undefined)).toBeNull()
    expect(quotaResetMs(0)).toBeNull()
    expect(quotaResetMs(-1)).toBeNull()
    expect(quotaResetMs(Number.NaN)).toBeNull()
  })

  it('drops a window whose share was never measured, instead of calling it zero', () => {
    // "0% used" and "nobody measured this" are different claims; only one of
    // them may reach a progress bar.
    expect(quotaWindow('5 小时', null)).toBeNull()
    expect(quotaWindow('5 小时', undefined)).toBeNull()
    expect(quotaWindow('5 小时', Number.NaN)).toBeNull()
    expect(quotaWindow('5 小时', 0)).toMatchObject({ label: '5 小时', usedPercent: 0 })
  })

  it('clamps a share into the bar and keeps an empty label for length-named windows', () => {
    expect(quotaWindow('', 140, { windowDurationMins: 300, resetsAt: 1_700_000_000 })).toEqual({
      label: '',
      usedPercent: 100,
      windowDurationMins: 300,
      resetsAt: 1_700_000_000_000,
    })
    expect(quotaWindow('x', -20)).toMatchObject({ usedPercent: 0 })
  })

  it('refuses a snapshot with no read time, and keeps one that merely has no windows', () => {
    expect(poolQuota(null, [])).toBeUndefined()
    expect(poolQuota(0, [])).toBeUndefined()
    // Read, and it stated nothing: that is a fact the card can show.
    expect(poolQuota(1_700_000_000_000, [])).toEqual({ windows: [], fetchedAt: 1_700_000_000_000 })
    expect(poolQuota(1_700_000_000_000, [null, quotaWindow('w', 5)])?.windows).toHaveLength(1)
  })
})

describe('ChatGPT snapshot as a per-account quota', () => {
  it('maps every window of every bucket, with the length kept for the card to name', () => {
    const quota = codexAccountQuota({
      fetchedAt: 1_700_000_000_000,
      usage: usage([bucket({
        windows: [
          { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_700_000_500 },
          { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_700_600_000 },
        ],
      })]),
    })
    expect(quota?.fetchedAt).toBe(1_700_000_000_000)
    expect(quota?.windows).toEqual([
      { label: '', usedPercent: 42, windowDurationMins: 300, resetsAt: 1_700_000_500_000 },
      { label: '', usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_700_600_000_000 },
    ])
  })

  it('falls back to the primary/secondary pair, exactly as the quota card does', () => {
    // Older payloads carry no `windows` list. Reading only that field would
    // leave the account row emptier than the card it belongs to.
    const quota = codexAccountQuota({
      fetchedAt: 1_700_000_000_000,
      usage: usage([bucket({
        primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      })]),
    })
    expect(quota?.windows).toEqual([{ label: '', usedPercent: 88, windowDurationMins: 300, resetsAt: null }])
  })

  it('publishes nothing when the snapshot never measured a share', () => {
    expect(codexAccountQuota({ fetchedAt: 1_700_000_000_000, usage: usage([bucket({ windows: [] })]) }))
      .toEqual({ windows: [], fetchedAt: 1_700_000_000_000 })
    expect(codexAccountQuota({
      fetchedAt: 1_700_000_000_000,
      usage: usage([bucket({ windows: [{ usedPercent: Number.NaN, windowDurationMins: null, resetsAt: null }] })]),
    })?.windows).toEqual([])
  })
})
