// @vitest-environment node
/**
 * Cache-affinity routing: which accounts a request prefers, and why.
 *
 * The rule is deliberately a pure function of measured inputs, so these tests pin
 * the rules rather than any particular wiring: the quota floor, what "unknown"
 * means, and the promise that an empty result is the same as no preference.
 */
import { describe, expect, it } from 'vitest'
import {
  AFFINITY_QUOTA_FLOOR_SHARE,
  CACHE_AFFINITY_ENV,
  orderAffinityCandidates,
  remainingQuotaShare,
  resolveCacheAffinityEnabled,
} from '../src/host/kimi-code/cache-affinity.ts'
import type { KimiCodeAccountQuota, KimiCodeUsageWindow } from '../src/shared/kimi-code-contracts.ts'

function window(usedFraction: number): KimiCodeUsageWindow {
  return {
    id: 'limit_5h',
    label: '5-hour',
    usedFraction,
    usedPercent: usedFraction * 100,
    windowDurationMins: 300,
    resetsAt: null,
    limit: null,
    used: null,
    remaining: null,
  }
}

function quota(...usedFractions: number[]): KimiCodeAccountQuota {
  return {
    account: {
      userId: null,
      nickname: null,
      email: null,
      planName: null,
      planLevel: null,
      region: null,
      authenticatedAt: null,
    },
    planName: null,
    windows: usedFractions.map((used) => window(used)),
    extraUsage: null,
    fetchedAt: Date.now(),
    sources: [],
  }
}

describe('remainingQuotaShare', () => {
  it('takes the tightest window, not the first or the average', () => {
    // 90% of the weekly window is left, but only 2% of the five-hour one: the
    // account is about to be refused, and this is the number that says so.
    expect(remainingQuotaShare(quota(0.98, 0.1))).toBeCloseTo(0.02, 6)
  })

  it('answers null when no snapshot was ever read', () => {
    expect(remainingQuotaShare(null)).toBeNull()
    expect(remainingQuotaShare(undefined)).toBeNull()
  })

  it('answers null for a snapshot with no windows rather than claiming a full window', () => {
    expect(remainingQuotaShare(quota())).toBeNull()
  })

  it('clamps a reported over-use to zero instead of going negative', () => {
    expect(remainingQuotaShare(quota(1.4))).toBe(0)
  })
})

describe('orderAffinityCandidates', () => {
  const floor = AFFINITY_QUOTA_FLOOR_SHARE

  it('lists a warm account whose remaining quota is above the floor', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'a', warm: true }],
      remainingShareById: { a: 0.8 },
    })).toEqual(['a'])
  })

  it('keeps a warm account exactly at the floor usable', () => {
    // The floor is a boundary, not a trap: raising it by one comparison would
    // silently make it "more than 20%", which nobody chose.
    expect(orderAffinityCandidates({
      candidates: [{ id: 'a', warm: true }],
      remainingShareById: { a: floor },
    })).toEqual(['a'])
  })

  it('drops a warm account that has fallen below the floor', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'a', warm: true }],
      remainingShareById: { a: floor - 0.01 },
    })).toEqual([])
  })

  it('keeps a warm account whose quota nobody measured, after the measured ones', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'unknown', warm: true }, { id: 'known', warm: true }],
      remainingShareById: { unknown: null, known: 0.5 },
    })).toEqual(['known', 'unknown'])
  })

  it('never lists a cold account, whatever its window says', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'cold', warm: false }],
      remainingShareById: { cold: 1 },
    })).toEqual([])
  })

  it('orders the measured candidates by remaining share, keeping pool order on ties', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'a', warm: true }, { id: 'b', warm: true }, { id: 'c', warm: true }],
      remainingShareById: { a: 0.3, b: 0.9, c: 0.3 },
    })).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty list — "no preference" — when nothing qualifies', () => {
    expect(orderAffinityCandidates({
      candidates: [{ id: 'a', warm: true }, { id: 'b', warm: false }],
      remainingShareById: { a: 0.05, b: 1 },
    })).toEqual([])
  })
})

describe('resolveCacheAffinityEnabled', () => {
  it('defaults to enabled when nothing says otherwise', () => {
    expect(resolveCacheAffinityEnabled(undefined, {})).toBe(true)
    expect(resolveCacheAffinityEnabled({}, {})).toBe(true)
  })

  it('follows the live setting, including a getter that reports off', () => {
    expect(resolveCacheAffinityEnabled({ cacheAffinity: false }, {})).toBe(false)
    expect(resolveCacheAffinityEnabled({ cacheAffinity: { get: () => false } }, {})).toBe(false)
    expect(resolveCacheAffinityEnabled({ cacheAffinity: { get: () => undefined } }, {})).toBe(true)
  })

  it('lets the environment override the stored setting in both directions', () => {
    const off = { [CACHE_AFFINITY_ENV]: '0' }
    const on = { [CACHE_AFFINITY_ENV]: 'on' }
    expect(resolveCacheAffinityEnabled({ cacheAffinity: true }, off)).toBe(false)
    expect(resolveCacheAffinityEnabled({ cacheAffinity: false }, on)).toBe(true)
  })

  it('swallows a throwing getter by keeping the feature on instead of failing a request', () => {
    expect(resolveCacheAffinityEnabled({
      cacheAffinity: { get: () => { throw new Error('settings unreadable') } },
    }, {})).toBe(true)
  })
})
