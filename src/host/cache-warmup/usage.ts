/**
 * 缓存用量登记表 —— 有界、只写不读消息、永不抛出。
 *
 * 为什么「永不抛出」是硬性契约：Kimi adapter 在 finally 路径里调用
 * `recordCacheWarmupUsage`。那个位置抛出的任何东西都会顶掉原始异常、把一次失败
 * 伪装成另一次失败，或者让重试/账号轮换逻辑读到半个状态。所以整个函数体被
 * 一层 catch 包住，坏输入、被污染的属性访问、内部容器异常一律降级成中性返回值。
 *
 * 有界：最多 {@link CACHE_WARMUP_DEFAULTS.maxUsageSessions} 个会话，
 * 每个会话最多 {@link CACHE_WARMUP_DEFAULTS.maxUsageReportsPerSession} 条报告。
 * 超出时淘汰最久未活动的会话 / 最旧的报告 —— 内存里只留「最近发生了什么」。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/usage
 */

import { CACHE_WARMUP_DEFAULTS, type CacheWarmupUsage } from './contracts.ts'

/** 一个会话的用量状态摘要。 */
export interface CacheWarmupUsageState {
  /** 会话 id。 */
  sessionId: string
  /** 当前保留的报告条数。 */
  reports: number
  /** 连续高命中率条数（遇 drift 或低命中率即断）。 */
  consecutiveHits: number
  /** 最近一次报告的命中率（0-1）。 */
  hitRatio: number
  /** 最近一次报告时刻。 */
  lastAt?: number
}

/** 一个会话的登记表条目摘要（供设置页/诊断展示）。 */
export interface CacheWarmupUsageSessionSummary {
  /** 会话 id。 */
  sessionId: string
  /** 报告条数。 */
  reports: number
  /** 最近一条报告时刻。 */
  lastAt: number
  /** 最近一条报告的命中率。 */
  hitRatio: number
}

/** 有界登记表：Map 的插入顺序同时是 LRU 顺序（命中即重新插入到队尾）。 */
const registry = new Map<string, readonly CacheWarmupUsage[]>()

/** 一个中性返回值，异常路径复用（不含任何容器操作）。 */
function neutralState(sessionId: string): CacheWarmupUsageState {
  return { sessionId, reports: 0, consecutiveHits: 0, hitRatio: 0 }
}

/** 非负有限数；其他一律 0。 */
function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 一次请求的缓存命中率 = 命中缓存 token / (未命中 token + 命中 token)。
 *
 * 这里的两个字段是**互斥的两半**，不是整体与部分：Kimi/DSH 上报的
 * `inputTokens` 是这次真正送去计算的未命中部分，`cacheReadTokens` 是命中缓存、
 * 没有重算的部分。所以分母必须是两者之和。
 *
 * 用 `cached / inputTokens` 是错的，而且错得很隐蔽：只要命中数接近或超过未命中数，
 * 比值就会 ≥ 1 并被钳成 1，于是「连续两次 ≥ 0.97」的判据在真实流量的**第一次**请求上
 * 就成立，预热期形同不存在 —— 这正好是这套预算想防的那件事。
 *
 * 也不允许拿 `totalTokens` 当分母：那个字段的构成由上层决定（可能含输出 token、
 * 也可能已经包含缓存部分），用它会让命中率随无关字段漂移。
 *
 * @param usage - 至少含 inputTokens（未命中）与 cacheReadTokens（命中）的用量。
 * @returns 0-1；`input=0` 且 `cached>0` 时为 1；两者都为 0 或非法时为 0。
 */
export function cacheWarmupHitRatio(usage: { inputTokens: number; cacheReadTokens: number }): number {
  try {
    const input = finiteCount(usage.inputTokens)
    const cached = finiteCount(usage.cacheReadTokens)
    if (cached <= 0) return 0
    const total = input + cached
    if (total <= 0) return 0
    return Math.min(1, cached / total)
  } catch {
    return 0
  }
}

/**
 * 从最新一条往回数「连续高命中率」条数。
 *
 * 停止条件（任一）：命中率低于阈值、该条带 driftCause、报告到头。
 * 「连续」是从最近往回数的，所以中间任何一次低命中或漂移都会把计数截断到 0。
 * @param reports - 按时间从旧到新排列的报告。
 * @returns 连续命中条数。
 */
/** Kimi 对每个请求都会报告的生命周期状态；只有其余值才表示真实前缀漂移。 */
const BENIGN_LIFECYCLE_CAUSES = new Set(['stable', 'first-request'])

/**
 * 判断一条报告是否算作「预热命中」（双轨判据）：
 *
 * 1. **第一轨（比例轨）**：`hitRatio >= 0.97`；
 * 2. **第二轨（前缀完整延续轨）**：解决短会话的分母效应（如 `1792 cached + 84 input = 95.52%`）。
 *    当本轮 `cacheReadTokens >= 1024`（已形成实质缓存前缀）、存在紧邻的上一条无真实漂移报告、
 *    本轮命中缓存没有比上一轮缩水（`cacheReadTokens >= previous.cacheReadTokens`），
 *    且本轮新增未命中部分 `inputTokens <= 256`（一个缓存块的正常尾巴）时，同样视为有效命中。
 */
export function isWarmupHitReport(
  report: CacheWarmupUsage,
  previous?: CacheWarmupUsage,
): boolean {
  if (cacheWarmupHitRatio(report) >= CACHE_WARMUP_DEFAULTS.hitRatioThreshold) return true
  if (previous === undefined || previous === null) return false
  const prevDrift = previous.driftCause
  if (typeof prevDrift === 'string' && prevDrift.trim() !== '' && !BENIGN_LIFECYCLE_CAUSES.has(prevDrift)) {
    return false
  }
  const cached = finiteCount(report.cacheReadTokens)
  const prevCached = finiteCount(previous.cacheReadTokens)
  const fresh = finiteCount(report.inputTokens)
  if (cached < CACHE_WARMUP_DEFAULTS.retainedPrefixMinCachedTokens) return false
  if (prevCached < CACHE_WARMUP_DEFAULTS.retainedPrefixMinCachedTokens) return false
  if (cached < prevCached) return false
  return fresh <= CACHE_WARMUP_DEFAULTS.retainedPrefixMaxFreshTokens
}

export function consecutiveWarmupHits(reports: readonly CacheWarmupUsage[]): number {
  try {
    if (!Array.isArray(reports)) return 0
    let hits = 0
    for (let index = reports.length - 1; index >= 0; index -= 1) {
      const report = reports[index]
      if (report === undefined || report === null) break
      const drift = report.driftCause
      if (typeof drift === 'string' && drift.trim() !== '' && !BENIGN_LIFECYCLE_CAUSES.has(drift)) break
      const previous = index > 0 ? reports[index - 1] : undefined
      if (!isWarmupHitReport(report, previous)) break
      hits += 1
    }
    return hits
  } catch {
    return 0
  }
}

/** 把任意输入归一成一条用量报告；形状不对返回 undefined（绝不抛）。 */
function normalizeUsage(input: CacheWarmupUsage | null | undefined): CacheWarmupUsage | undefined {
  if (input === null || input === undefined || typeof input !== 'object') return undefined
  const sessionId = input.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  const driftCause = typeof input.driftCause === 'string' && input.driftCause.trim() !== '' ? input.driftCause : undefined
  const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now()
  const normalized: CacheWarmupUsage = {
    sessionId,
    inputTokens: finiteCount(input.inputTokens),
    cacheReadTokens: finiteCount(input.cacheReadTokens),
    outputTokens: finiteCount(input.outputTokens),
    totalTokens: finiteCount(input.totalTokens),
    at,
  }
  if (driftCause !== undefined) normalized.driftCause = driftCause
  return normalized
}

/** 由一份报告列表算出状态摘要。 */
function stateOf(sessionId: string, reports: readonly CacheWarmupUsage[]): CacheWarmupUsageState {
  const last = reports[reports.length - 1]
  return {
    sessionId,
    reports: reports.length,
    consecutiveHits: consecutiveWarmupHits(reports),
    hitRatio: last === undefined ? 0 : cacheWarmupHitRatio(last),
    lastAt: last?.at,
  }
}

/**
 * 登记一次用量报告。
 *
 * **total function**：任何输入、任何内部异常都不抛出，最差返回一份中性状态。
 * 有副作用（更新有界登记表），但不触碰消息、不发起请求、不改变请求参数。
 * @param input - 用量报告。
 * @returns 该会话登记之后的状态摘要。
 */
export function recordCacheWarmupUsage(input: CacheWarmupUsage): CacheWarmupUsageState {
  let sessionId = ''
  try {
    const usage = normalizeUsage(input)
    if (usage === undefined) return neutralState('')
    sessionId = usage.sessionId
    const previous = registry.get(usage.sessionId)
    const kept = previous === undefined ? [] : [...previous]
    kept.push(Object.freeze({ ...usage }) as CacheWarmupUsage)
    while (kept.length > CACHE_WARMUP_DEFAULTS.maxUsageReportsPerSession) kept.shift()
    // 命中即移到队尾，保持 Map 的插入顺序就是 LRU 顺序。
    if (previous !== undefined) registry.delete(usage.sessionId)
    registry.set(usage.sessionId, Object.freeze(kept))
    while (registry.size > CACHE_WARMUP_DEFAULTS.maxUsageSessions) {
      const oldest = registry.keys().next()
      if (oldest.done === true) break
      registry.delete(oldest.value)
    }
    return stateOf(usage.sessionId, kept)
  } catch {
    try {
      if (sessionId !== '') registry.delete(sessionId)
    } catch {
      // 登记表本身不可用：放弃这次状态更新，绝不影响请求路径。
    }
    return neutralState(sessionId)
  }
}

/**
 * 读一个会话的报告（从旧到新），不抛出。
 * @param sessionId - 会话 id。
 * @returns 报告副本；没有或读不到时为空数组。
 */
export function cacheWarmupUsageReports(sessionId: string): readonly CacheWarmupUsage[] {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const reports = registry.get(sessionId)
    return reports === undefined ? [] : [...reports]
  } catch {
    return []
  }
}

/**
 * 列出所有有报告的会话，按最近活动倒序；不抛出。
 * @returns 会话摘要数组。
 */
export function cacheWarmupUsageSessions(): CacheWarmupUsageSessionSummary[] {
  try {
    const summaries: CacheWarmupUsageSessionSummary[] = []
    for (const [sessionId, reports] of registry.entries()) {
      if (reports.length === 0) continue
      const last = reports[reports.length - 1]!
      summaries.push({ sessionId, reports: reports.length, lastAt: last.at, hitRatio: cacheWarmupHitRatio(last) })
    }
    summaries.sort((left, right) => right.lastAt - left.lastAt)
    return summaries
  } catch {
    return []
  }
}

/**
 * 清空登记表。**只用于测试**：生产路径没有任何调用点。
 */
export function resetCacheWarmupForTests(): void {
  try {
    registry.clear()
  } catch {
    // 清不掉也不该让测试之外的世界受影响。
  }
}
