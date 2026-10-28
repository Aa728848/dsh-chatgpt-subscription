/**
 * 预热预算与用量登记表。
 *
 * 两条硬性要求在这里被钉住：
 *
 * 1. 预热期保守（约 512-1024 token 的字符预算），连续两次命中率 ≥ 0.97 且无 drift
 *    才放大到稳态；任何 drift 立刻把连续计数清零。
 * 2. `recordCacheWarmupUsage` / `cacheWarmupBudget` / `cacheWarmupSnapshot` 都是
 *    **不抛出的 total function** —— Kimi adapter 在 finally 路径里调用它们，
 *    任何异常都不能顶掉原始异常。这里用异常注入（把 Map 的方法打成抛出）证明这点。
 *
 * 夹具的 token 语义与上游一致：`inputTokens` 是**未命中**部分，
 * `cacheReadTokens` 是命中部分，两者互斥且共同构成总量。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_WARMUP_DEFAULTS, type CacheWarmupUsage } from '../src/host/cache-warmup/contracts.ts'
import { cacheWarmupBudget, cacheWarmupSnapshot } from '../src/host/cache-warmup/budget.ts'
import { cacheWarmupHitRatio } from '../src/host/cache-warmup/usage.ts'
import {
  cacheWarmupUsageReports,
  cacheWarmupUsageSessions,
  recordCacheWarmupUsage,
  resetCacheWarmupForTests,
} from '../src/host/cache-warmup/usage.ts'
import * as cacheWarmup from '../src/host/cache-warmup/index.ts'

beforeEach(() => {
  resetCacheWarmupForTests()
})

/** 造一条用量报告：`inputTokens` 是未命中部分，默认 2。 */
function usage(input: {
  sessionId: string
  cached: number
  inputTokens?: number
  at?: number
  driftCause?: string
}): CacheWarmupUsage {
  const inputTokens = input.inputTokens ?? 2
  const report: CacheWarmupUsage = {
    sessionId: input.sessionId,
    inputTokens,
    cacheReadTokens: input.cached,
    outputTokens: 10,
    totalTokens: inputTokens + input.cached,
    at: input.at ?? Date.now(),
  }
  if (input.driftCause !== undefined) report.driftCause = input.driftCause
  return report
}

describe('cacheWarmupHitRatio 定义', () => {
  it('命中率 = cached / (input + cached)，两字段是互斥的两半', () => {
    // 旧公式 cached / input 在这四条上会得到 1 / 32.33 / ∞ / 0，全部是错的。
    expect(cacheWarmupHitRatio({ inputTokens: 50, cacheReadTokens: 50 })).toBeCloseTo(0.5, 10)
    expect(cacheWarmupHitRatio({ inputTokens: 3, cacheReadTokens: 97 })).toBeCloseTo(0.97, 10)
    expect(cacheWarmupHitRatio({ inputTokens: 0, cacheReadTokens: 97 })).toBe(1)
    expect(cacheWarmupHitRatio({ inputTokens: 0, cacheReadTokens: 0 })).toBe(0)
  })

  it('非法/退化输入不会算出超过 1 或负数', () => {
    expect(cacheWarmupHitRatio({ inputTokens: 10, cacheReadTokens: 0 })).toBe(0)
    expect(cacheWarmupHitRatio({ inputTokens: -1, cacheReadTokens: -1 })).toBe(0)
    expect(cacheWarmupHitRatio({ inputTokens: Number.NaN, cacheReadTokens: 5 })).toBe(1)
    expect(cacheWarmupHitRatio({ inputTokens: 1, cacheReadTokens: 99 })).toBeLessThanOrEqual(1)
  })
})

describe('共享导出', () => {
  it('index 暴露宿主 install/result-tool 需要的全部符号', () => {
    for (const name of [
      'CACHE_WARMUP_DEFAULTS',
      'FileResultReferenceStore',
      'projectToolResult',
      'cacheWarmupBudget',
      'cacheWarmupSnapshot',
      'recordCacheWarmupUsage',
      'resetCacheWarmupForTests',
    ]) {
      expect(cacheWarmup).toHaveProperty(name)
    }
    // 零参构造的存储实例必须真的实现了 put/page/release。
    const store = new cacheWarmup.FileResultReferenceStore()
    expect(typeof store.put).toBe('function')
    expect(typeof store.page).toBe('function')
    expect(typeof store.release).toBe('function')
    expect(cacheWarmup.CACHE_WARMUP_DEFAULTS.maxResultBytes).toBe(8 * 1024 * 1024)
    expect(cacheWarmup.CACHE_WARMUP_DEFAULTS.maxSessionBytes).toBe(64 * 1024 * 1024)
  })
})

describe('CACHE_WARMUP_DEFAULTS', () => {
  it('预热期是 512-1024 token 量级的保守字符预算，稳态 8000', () => {
    // 1200 字符在中文/代码混排下约 600-750 token，落在约束要求的区间内。
    expect(CACHE_WARMUP_DEFAULTS.warmupMaxChars).toBeGreaterThanOrEqual(512)
    expect(CACHE_WARMUP_DEFAULTS.warmupMaxChars).toBeLessThanOrEqual(2048)
    expect(CACHE_WARMUP_DEFAULTS.steadyStateMaxChars).toBe(8000)
    expect(CACHE_WARMUP_DEFAULTS.hitRatioThreshold).toBe(0.97)
    expect(CACHE_WARMUP_DEFAULTS.consecutiveHitsRequired).toBe(2)
  })
})

describe('cacheWarmupBudget 预热期判定', () => {
  it('没有任何报告时按最保守的预热预算处理', () => {
    const budget = cacheWarmupBudget('session-none')
    expect(budget.warmup).toBe(true)
    expect(budget.maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
    expect(budget.consecutiveHits).toBe(0)
    expect(budget.hitRatio).toBe(0)
  })

  it('不传 session 也返回预热预算（永远不会更激进）', () => {
    expect(cacheWarmupBudget().maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
    expect(cacheWarmupBudget().warmup).toBe(true)
  })

  it('一次高命中率仍留在预热期', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 99, inputTokens: 1 }))
    const budget = cacheWarmupBudget('s')
    expect(budget.warmup).toBe(true)
    expect(budget.maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
    expect(budget.consecutiveHits).toBe(1)
    expect(budget.hitRatio).toBeCloseTo(0.99, 5)
  })

  it('连续两次命中率 ≥ 0.97 才进入稳态 8000', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 97, inputTokens: 3 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 97, inputTokens: 3 }))
    const budget = cacheWarmupBudget('s')
    expect(budget.warmup).toBe(false)
    expect(budget.maxChars).toBe(8000)
    expect(budget.consecutiveHits).toBe(2)
    expect(budget.hitRatio).toBeCloseTo(0.97, 10)
  })

  it('刚好 0.97 计入，0.969 不计入', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 97, inputTokens: 3 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 97, inputTokens: 3 }))
    expect(cacheWarmupBudget('s').warmup).toBe(false)

    resetCacheWarmupForTests()
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 969, inputTokens: 31 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 969, inputTokens: 31 }))
    const budget = cacheWarmupBudget('s')
    expect(budget.warmup).toBe(true)
    expect(budget.consecutiveHits).toBe(0)
    expect(budget.hitRatio).toBeCloseTo(0.969, 10)
    expect(budget.maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
  })

  it('中间一次低命中率会截断连续计数', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 99, inputTokens: 1 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 50, inputTokens: 50 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 99, inputTokens: 1 }))
    const budget = cacheWarmupBudget('s')
    expect(budget.consecutiveHits).toBe(1)
    expect(budget.warmup).toBe(true)
  })

  it('旧公式会误判的真实形状（未命中多于命中）必须留在预热期', () => {
    // 旧公式 cached / input 会得到 1 与 0.5；正确公式是 0.5 与 1/3。
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 50, inputTokens: 50 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 100, inputTokens: 200 }))
    const budget = cacheWarmupBudget('s')
    expect(budget.consecutiveHits).toBe(0)
    expect(budget.warmup).toBe(true)
    expect(budget.hitRatio).toBeCloseTo(1 / 3, 10)
  })

  it('stable 与 first-request 不是漂移，真实 drift 仍会立即重置', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2, driftCause: 'first-request' }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2, driftCause: 'stable' }))
    const settled = cacheWarmupBudget('s')
    expect(settled.warmup).toBe(false)
    expect(settled.consecutiveHits).toBe(2)
    expect(settled.maxChars).toBe(8000)

    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2, driftCause: 'tools' }))
    expect(cacheWarmupBudget('s').warmup).toBe(true)
    expect(cacheWarmupBudget('s').consecutiveHits).toBe(0)
  })

  it('drift 重置连续计数，下一条请求立刻回落到预热预算', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2 }))
    expect(cacheWarmupBudget('s').warmup).toBe(false)

    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2, driftCause: 'prefix-changed' }))
    const budget = cacheWarmupBudget('s')
    expect(budget.consecutiveHits).toBe(0)
    expect(budget.warmup).toBe(true)
    expect(budget.maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
    expect(cacheWarmupSnapshot('s').usage.driftCauses).toEqual(['prefix-changed'])
  })

  it('预算计算不改写登记表（纯读）', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 99, inputTokens: 1 }))
    const before = JSON.stringify(cacheWarmupUsageReports('s'))
    cacheWarmupBudget('s')
    cacheWarmupBudget('s')
    expect(JSON.stringify(cacheWarmupUsageReports('s'))).toBe(before)
  })
})

describe('recordCacheWarmupUsage 有界与健壮', () => {
  it('会话数有界：写 300 个会话只保留 256 个，最旧的被淘汰', () => {
    for (let index = 0; index < 300; index += 1) {
      recordCacheWarmupUsage(usage({ sessionId: `session-${index}`, cached: 98, inputTokens: 2, at: 1_000 + index }))
    }
    expect(cacheWarmupUsageSessions().length).toBeLessThanOrEqual(CACHE_WARMUP_DEFAULTS.maxUsageSessions)
    expect(cacheWarmupUsageSessions().length).toBe(256)
    // 最早的那个会话已经被淘汰，读回是空的，预算回到预热期。
    expect(cacheWarmupUsageReports('session-0')).toEqual([])
    expect(cacheWarmupBudget('session-0').warmup).toBe(true)
    // 最新的仍在。
    expect(cacheWarmupUsageReports('session-299')).toHaveLength(1)
  })

  it('每会话报告条数有界（32 条环形）', () => {
    for (let index = 0; index < 40; index += 1) {
      recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2, at: 2_000 + index }))
    }
    expect(cacheWarmupUsageReports('s')).toHaveLength(CACHE_WARMUP_DEFAULTS.maxUsageReportsPerSession)
    expect(cacheWarmupSnapshot('s').usage.reports).toBe(32)
    // 保留的是最新的：最后一条 at = 2039。
    expect(cacheWarmupUsageReports('s').at(-1)?.at).toBe(2_039)
  })

  it('坏输入不抛出，返回中性状态', () => {
    expect(() => recordCacheWarmupUsage(null as unknown as CacheWarmupUsage)).not.toThrow()
    expect(recordCacheWarmupUsage(null as unknown as CacheWarmupUsage).reports).toBe(0)
    expect(recordCacheWarmupUsage({} as CacheWarmupUsage).reports).toBe(0)
    expect(recordCacheWarmupUsage(usage({ sessionId: 's', cached: -5 })).hitRatio).toBe(0)
    expect(cacheWarmupBudget('s').warmup).toBe(true)
  })

  it('登记表本身抛异常时也不抛出（finally 路径安全）', () => {
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(() => {
      throw new Error('registry exploded')
    })
    let state
    try {
      state = recordCacheWarmupUsage(usage({ sessionId: 'session-boom', cached: 98, inputTokens: 2 }))
    } finally {
      spy.mockRestore()
    }
    expect(state).toEqual({ sessionId: 'session-boom', reports: 0, consecutiveHits: 0, hitRatio: 0 })

    // 恢复之后登记表仍然可用。
    expect(recordCacheWarmupUsage(usage({ sessionId: 'session-boom', cached: 98, inputTokens: 2 })).reports).toBe(1)
  })

  it('读路径抛异常时预算与快照仍返回保守值（热路径不抛出）', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2 }))
    expect(cacheWarmupBudget('s').warmup).toBe(false)

    const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(() => {
      throw new Error('registry get exploded')
    })
    let budget
    let snapshot
    try {
      budget = cacheWarmupBudget('s')
      snapshot = cacheWarmupSnapshot('s')
    } finally {
      spy.mockRestore()
    }
    expect(budget?.warmup).toBe(true)
    expect(budget?.maxChars).toBe(CACHE_WARMUP_DEFAULTS.warmupMaxChars)
    expect(snapshot?.budget.warmup).toBe(true)
    expect(snapshot?.usage.reports).toBe(0)
    expect(snapshot?.usage.totals.inputTokens).toBe(0)
  })

  it('resetCacheWarmupForTests 清空登记表', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 98, inputTokens: 2 }))
    expect(cacheWarmupUsageSessions()).toHaveLength(1)
    resetCacheWarmupForTests()
    expect(cacheWarmupUsageSessions()).toHaveLength(0)
    expect(cacheWarmupBudget('s').warmup).toBe(true)
  })
})

describe('cacheWarmupSnapshot', () => {
  it('汇总 token、命中率与漂移原因，且两次调用结果一致', () => {
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 500, inputTokens: 500, at: 10 }))
    recordCacheWarmupUsage(usage({ sessionId: 's', cached: 990, inputTokens: 10, at: 20, driftCause: 'toolsets' }))

    const first = cacheWarmupSnapshot('s')
    const second = cacheWarmupSnapshot('s')
    expect(first).toEqual(second)
    expect(first.sessionId).toBe('s')
    expect(first.usage.reports).toBe(2)
    expect(first.usage.lastAt).toBe(20)
    expect(first.usage.totals.inputTokens).toBe(510)
    expect(first.usage.totals.cacheReadTokens).toBe(1490)
    expect(first.usage.totals.outputTokens).toBe(20)
    expect(first.usage.totals.totalTokens).toBe(2000)
    expect(first.usage.hitRatio).toBeCloseTo(0.99, 10)
    expect(first.usage.driftCauses).toEqual(['toolsets'])
    expect(first.defaults).toBe(CACHE_WARMUP_DEFAULTS)
    expect(first.sessions).toBe(1)
  })

  it('不带 session 时给全局快照', () => {
    recordCacheWarmupUsage(usage({ sessionId: 'a', cached: 98, inputTokens: 2 }))
    recordCacheWarmupUsage(usage({ sessionId: 'b', cached: 98, inputTokens: 2 }))
    const snapshot = cacheWarmupSnapshot()
    expect(snapshot.sessions).toBe(2)
    expect(snapshot.sessionId).toBeUndefined()
    expect(snapshot.usage.reports).toBe(0)
    expect(snapshot.budget.warmup).toBe(true)
  })
})
