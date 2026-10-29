/**
 * 预热预算：预热期保守、连续命中后放大、漂移立刻收回。
 *
 * 控制器是**纯函数**：不发起请求、不改消息、不改登记表。它只回答一个问题 ——
 * 「这一次预览最多能占多少字符」。把决策与执行分开，才能保证预算收紧或放开
 * 都不会悄悄改写已经进入历史的文本（历史里的 preview 是常量）。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/budget
 */

import { CACHE_WARMUP_DEFAULTS, type PreviewBudget } from './contracts.ts'
import {
  cacheWarmupHitRatio,
  cacheWarmupUsageReports,
  cacheWarmupUsageSessions,
  consecutiveWarmupHits,
} from './usage.ts'

/** 预热期的保守预算（构造一次，避免每次读模块常量）。 */
const WARMUP_BUDGET: PreviewBudget = Object.freeze({
  maxChars: CACHE_WARMUP_DEFAULTS.warmupMaxChars,
  warmup: true,
  consecutiveHits: 0,
  hitRatio: 0,
})

export interface CacheWarmupDurableHint {
  /** 持久化的最近活跃时间（毫秒）。 */
  lastActiveAt?: number
  /** 持久化的连续命中次数。 */
  consecutiveHits?: number
  /** 持久化的最近一次命中率（0-1）。 */
  hitRatio?: number
}

/**
 * 当前会话的预览预算。
 *
 * 规则（约束 4）：预热期 `maxChars = 1200`（约 600-750 tokens）；连续
 * `consecutiveHitsRequired`(2) 次命中（比例 ≥ 0.97 或前缀完整延续且新增 ≤ 256 tokens）
 * 且期间没有 drift，才进入稳态 `maxChars = 8000`。任何一次 drift 都清零连续计数，
 * 于是下一条请求立刻回落到预热预算。
 *
 * 空闲 TTL 预判：若距离最近一条报告已超过 `cacheTtlMs`（25 分钟，Kimi 实测缓存
 * 全热上限），说明上游缓存大概率已冷，无需等下一轮请求失败，当场退回预热期保守预算。
 *
 * **不抛出**：没有会话、没有报告、登记表异常，一律返回预热期的保守预算。
 * @param sessionId - 会话 id；不传则按最保守的预热预算处理。
 * @param now - 当前时间戳（毫秒），默认 `Date.now()`；测试可注入。
 * @param durable - 进程重启后尚无内存报告时的持久化回退摘要（可选）。
 * @returns 本次投影可用的预算。
 */
export function cacheWarmupBudget(
  sessionId?: string,
  now: number = Date.now(),
  durable?: CacheWarmupDurableHint,
): PreviewBudget {
  try {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return { ...WARMUP_BUDGET }
    const reports = cacheWarmupUsageReports(sessionId)
    if (reports.length === 0) {
      if (durable !== undefined && durable !== null && typeof durable === 'object') {
        const lastAt = durable.lastActiveAt
        const notExpired =
          typeof lastAt === 'number' &&
          Number.isFinite(lastAt) &&
          Number.isFinite(now) &&
          now - lastAt <= CACHE_WARMUP_DEFAULTS.cacheTtlMs
        const hits =
          notExpired && typeof durable.consecutiveHits === 'number' && Number.isFinite(durable.consecutiveHits) && durable.consecutiveHits > 0
            ? Math.floor(durable.consecutiveHits)
            : 0
        const hitRatio =
          typeof durable.hitRatio === 'number' && Number.isFinite(durable.hitRatio) && durable.hitRatio >= 0
            ? Math.min(1, durable.hitRatio)
            : 0
        const warmup = hits < CACHE_WARMUP_DEFAULTS.consecutiveHitsRequired
        return {
          maxChars: warmup ? CACHE_WARMUP_DEFAULTS.warmupMaxChars : CACHE_WARMUP_DEFAULTS.steadyStateMaxChars,
          warmup,
          consecutiveHits: hits,
          hitRatio,
        }
      }
      return { ...WARMUP_BUDGET }
    }
    const last = reports[reports.length - 1]
    const hitRatio = last === undefined ? 0 : cacheWarmupHitRatio(last)
    const expired =
      last !== undefined &&
      typeof last.at === 'number' &&
      Number.isFinite(last.at) &&
      Number.isFinite(now) &&
      now - last.at > CACHE_WARMUP_DEFAULTS.cacheTtlMs
    const consecutiveHits = expired ? 0 : consecutiveWarmupHits(reports)
    const warmup = consecutiveHits < CACHE_WARMUP_DEFAULTS.consecutiveHitsRequired
    return {
      maxChars: warmup ? CACHE_WARMUP_DEFAULTS.warmupMaxChars : CACHE_WARMUP_DEFAULTS.steadyStateMaxChars,
      warmup,
      consecutiveHits,
      hitRatio,
    }
  } catch {
    return { ...WARMUP_BUDGET }
  }
}

/** 用量汇总。 */
export interface CacheWarmupUsageTotals {
  /** 输入 token 合计。 */
  inputTokens: number
  /** 命中缓存 token 合计。 */
  cacheReadTokens: number
  /** 输出 token 合计。 */
  outputTokens: number
  /** 总 token 合计。 */
  totalTokens: number
}

/** `cacheWarmupSnapshot()` 的返回形状：一份自足的只读快照。 */
export interface CacheWarmupSnapshot {
  /** 会话 id；全局快照时不存在。 */
  sessionId?: string
  /** 该会话当前的预算。 */
  budget: PreviewBudget
  /** 子包默认值，方便设置页展示「当前处于预热期/稳态」的判据。 */
  defaults: typeof CACHE_WARMUP_DEFAULTS
  /** 该会话的用量汇总。 */
  usage: {
    /** 保留的报告条数。 */
    reports: number
    /** 最近一条报告时刻。 */
    lastAt?: number
    /** 最近一次命中率。 */
    hitRatio: number
    /** token 汇总。 */
    totals: CacheWarmupUsageTotals
    /** 期间观测到的漂移原因（去重，供诊断）。 */
    driftCauses: string[]
  }
  /** 登记表里的会话总数。 */
  sessions: number
}

/**
 * 一份可读快照。**不抛出**，且完全无副作用（只读登记表）。
 * @param sessionId - 会话 id；不传则给全局汇总。
 * @param now - 当前时间戳（毫秒），默认 `Date.now()`。
 * @returns 快照。
 */
export function cacheWarmupSnapshot(sessionId?: string, now: number = Date.now()): CacheWarmupSnapshot {
  const fallback: CacheWarmupSnapshot = {
    budget: { ...WARMUP_BUDGET },
    defaults: CACHE_WARMUP_DEFAULTS,
    usage: {
      reports: 0,
      hitRatio: 0,
      totals: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 },
      driftCauses: [],
    },
    sessions: 0,
  }
  try {
    const budget = cacheWarmupBudget(sessionId, now)
    const reports = typeof sessionId === 'string' && sessionId.trim() !== ''
      ? cacheWarmupUsageReports(sessionId)
      : []
    const totals: CacheWarmupUsageTotals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 }
    const driftCauses: string[] = []
    for (const report of reports) {
      totals.inputTokens += report.inputTokens
      totals.cacheReadTokens += report.cacheReadTokens
      totals.outputTokens += report.outputTokens
      totals.totalTokens += report.totalTokens
      const drift = report.driftCause
      if (typeof drift === 'string' && drift !== '' && !driftCauses.includes(drift)) driftCauses.push(drift)
    }
    const last = reports[reports.length - 1]
    const snapshot: CacheWarmupSnapshot = {
      budget,
      defaults: CACHE_WARMUP_DEFAULTS,
      usage: {
        reports: reports.length,
        hitRatio: last === undefined ? 0 : cacheWarmupHitRatio(last),
        totals,
        driftCauses,
      },
      sessions: cacheWarmupUsageSessions().length,
    }
    if (last !== undefined) snapshot.usage.lastAt = last.at
    if (typeof sessionId === 'string' && sessionId.trim() !== '') snapshot.sessionId = sessionId
    return snapshot
  } catch {
    return fallback
  }
}
