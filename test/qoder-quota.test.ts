/**
 * Qoder 额度快照的归一化（issue #74）。
 *
 * 钉的是上游另外报的那两个**账号层面**的事实：额度用尽（isQuotaExceeded）与
 * 升级页（upgradeUrl）。此前这两个字段在产物里一次都没出现，于是三只桶全是 0 时
 * 卡片显示「还有额度」，而上游其实已经把请求拒了——用户于是去重建令牌，
 * 而令牌一直是好的。
 */
import { describe, expect, it } from 'vitest'
import { normalizeQoderQuotaSnapshot } from '../src/host/qoder/client.ts'

describe('normalizeQoderQuotaSnapshot', () => {
  it('上游报的 isQuotaExceeded / upgradeUrl 被带进快照', () => {
    const snapshot = normalizeQoderQuotaSnapshot({
      isQuotaExceeded: true,
      upgradeUrl: 'https://qoder.com/pricing?client=qoder',
      userQuota: { total: 0, remaining: 0 },
    }, 'global', 1)
    expect(snapshot?.quotaExceeded).toBe(true)
    expect(snapshot?.upgradeUrl).toBe('https://qoder.com/pricing?client=qoder')
    // 桶照旧：上游没报的数字保持缺失，绝不发明。
    expect(snapshot?.buckets).toEqual([
      { kind: 'personal', total: 0, used: null, remaining: 0, unit: null },
    ])
  })

  it('上游没报这两个字段时：false / null（不是「用尽了」）', () => {
    const snapshot = normalizeQoderQuotaSnapshot({
      userQuota: { total: 100, used: 10, remaining: 90, unit: 'Credits' },
    }, 'global', 1)
    expect(snapshot?.quotaExceeded).toBe(false)
    expect(snapshot?.upgradeUrl).toBeNull()
  })

  it('上游明说用尽、却没给任何桶时，快照仍然下发（那句话不能被丢掉）', () => {
    const snapshot = normalizeQoderQuotaSnapshot({ isQuotaExceeded: true }, 'global', 1)
    expect(snapshot?.quotaExceeded).toBe(true)
    expect(snapshot?.buckets).toEqual([])
  })

  it('一只桶都不认识、也没说用尽时：快照不下发（卡片显示「读不出来」）', () => {
    expect(normalizeQoderQuotaSnapshot({ somethingElse: 1 }, 'global', 1)).toBeUndefined()
  })
})
