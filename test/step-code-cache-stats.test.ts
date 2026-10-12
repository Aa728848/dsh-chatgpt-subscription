/**
 * T2 缓存诊断守卫测试：Step Code（Step Plan 订阅）线路的 **缓存浪费诊断**
 * （噪声地板 / 基线可比性 / 合法上下文变化 / 换模型 / 金额维度 / 汇总与两个入口的一致性）。
 *
 * 全部离线：这一层是纯函数（自己不持有任何状态），这里只喂本地构造的
 * `StepCodeCacheEntry` 序列，**不发任何网络请求**、不需要任何凭据。
 *
 * 每条 `it` 的标题就是被断言的那条事实本身，脱离本文件也能读懂「上游 / 契约要求的是什么」。
 */

import { describe, expect, it } from 'vitest'
import {
  CACHE_TTL_MS,
  NOISE_FLOOR_TOKENS,
  asPreviousRequest,
  cacheLikelyExpired,
  collectCacheMisses,
  computeCacheWaste,
  detectCacheMiss,
  detectCacheMissForTurn,
  isCacheWasteCostPriced,
  promptTokensOf,
  type StepCodeCacheEntry,
  type StepCodeCacheTurn,
  type StepCodeCacheUsage,
  type StepCodePreviousRequest,
} from '../src/host/step-code/cache-stats.ts'
import { STEP_CODE_PRICE_PER_MILLION_TOKENS } from '../src/host/step-code/mapper.ts'
import { MODEL_DEFAULTS } from '../src/host/step-code/types.ts'
import { STEP_CODE_PRICING_STATUS } from '../src/shared/step-code-contracts.ts'

// ---------------------------------------------------------------------------
// 本地构造的输入
// ---------------------------------------------------------------------------

const MODEL = 'step-code/step-3'
const OTHER_MODEL = 'step-code/step-3.5'

function usage(overrides: Partial<StepCodeCacheUsage> = {}): StepCodeCacheUsage {
  return { inputTokens: 5_000, outputTokens: 120, ...overrides }
}

function turn(timestamp: number, overrides: Partial<StepCodeCacheTurn> = {}): StepCodeCacheTurn {
  return { usage: usage(), timestamp, modelKey: MODEL, ...overrides }
}

/** 历史里的一条助手回合。 */
const at = (turn_: StepCodeCacheTurn): StepCodeCacheEntry => ({ kind: 'turn', turn: turn_ })

/** 直接构造上一轮基线（诊断内部那一份 shape，测试按真实字段名给）。 */
function previous(promptTokens: number, reportedCache: boolean, timestamp = 0): StepCodePreviousRequest {
  return { promptTokens, modelKey: MODEL, timestamp, reportedCache }
}

// ---------------------------------------------------------------------------
// 1. 噪声地板
// ---------------------------------------------------------------------------

describe('噪声地板：缓存断点的粒度不是浪费', () => {
  it('★ 漏掉的恰好 1024 token 不计（等于地板的量级是重排，不是浪费）', () => {
    // 本次的提示是 1024 token 且一个都没命中，能漏的交集正好落在地板上。
    expect(detectCacheMiss(previous(5_000, true, 1_000), turn(2_000, { usage: usage({ inputTokens: 1_024 }) })))
      .toBeUndefined()
    expect(NOISE_FLOOR_TOKENS).toBe(1024)
  })

  it('★ 漏掉的 1025 token 计：跨过地板的第一次就必须被看见', () => {
    // 前缀缓存断在块边界上，几百 token 的漂移是正常重排；把粒度当浪费，
    // 代价是用户学会忽略这条通知，于是唯一有意义的那次也没人看了。
    const miss = detectCacheMiss(
      previous(5_000, true, 1_000),
      turn(2_000, { usage: usage({ inputTokens: 1_025 }) }),
    )

    expect(miss?.missedTokens).toBe(1_025)
  })

  it('地板是在「可漏的交集」上量的：本次比上次短的那部分不算漏', () => {
    // 上次有 5000，这次只有 800（且一个都没命中）：能漏的交集最多就是 800，落在地板下。
    const miss = detectCacheMiss(previous(5_000, true, 0), turn(1_000, { usage: usage({ inputTokens: 800 }) }))

    expect(miss).toBeUndefined()
    // 同一段历史里把本次提示拉长到 5000，同样的「没命中」就立刻越过地板。
    expect(detectCacheMiss(previous(5_000, true, 0), turn(1_000, { usage: usage({ inputTokens: 5_000 }) }))?.missedTokens)
      .toBe(5_000)
  })
})

// ---------------------------------------------------------------------------
// 2. 没有可比基线就不计数
// ---------------------------------------------------------------------------

describe('没有上一轮可比时，这一轮不计', () => {
  it('★ 第一轮没有基线：不计数（没有上一轮可比就没有「本该命中」可言）', () => {
    expect(detectCacheMiss(undefined, turn(1_000))).toBeUndefined()
  })

  it('★ promptTokens <= 0 的回合不计数，也成不了下一轮的基线', () => {
    // 聚合提示 token 为 0 的这一轮携带不了任何 prompt，不可能是缓存基线。
    expect(detectCacheMiss(previous(5_000, true, 0), turn(1_000, { usage: usage({ inputTokens: 0 }) })))
      .toBeUndefined()
    expect(asPreviousRequest(turn(1_000, { usage: usage({ inputTokens: 0 }) }), true)).toBeUndefined()
  })

  it('零输入且零缓存读时聚合提示 token 就是 0', () => {
    expect(promptTokensOf(usage({ inputTokens: 0 }))).toBe(0)
    expect(promptTokensOf(usage({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))).toBe(0)
    expect(promptTokensOf(usage({ inputTokens: 100, cacheReadTokens: 900 }))).toBe(1000)
  })

  it('第一轮可以成为后面那一轮的基线，且基线是聚合提示 token（输入 + 两个缓存桶）', () => {
    const first = turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })
    const prev = asPreviousRequest(first, false)

    expect(prev?.promptTokens).toBe(5_000)
    expect(prev?.timestamp).toBe(1_000)
    expect(prev?.modelKey).toBe(MODEL)
  })
})

// ---------------------------------------------------------------------------
// 3. 从未报过缓存活动的厂商
// ---------------------------------------------------------------------------

describe('「没报缓存」与「全 miss」在外部看起来一样，得靠上一轮区分', () => {
  it('★ 本轮零缓存读且上一轮也从未报过：不计数', () => {
    // 不设这一位的话，「端点从不报缓存」会被每一轮都报成一次全 miss。
    expect(detectCacheMiss(previous(5_000, false, 0), turn(1_000, { usage: usage({ inputTokens: 5_000 }) })))
      .toBeUndefined()
  })

  it('★ 上一轮报过缓存活动、这一轮全 miss：要计，而且全额就是漏掉的量', () => {
    const miss = detectCacheMiss(
      previous(5_000, true, 0),
      turn(1_000, { usage: usage({ inputTokens: 5_000 }) }),
    )

    expect(miss?.missedTokens).toBe(5_000)
  })

  it('reportedCache 是黏的：某一轮报过之后，后面每一轮都算作「本该命中」', () => {
    const warm = turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })
    const prev = asPreviousRequest(warm, false)

    expect(prev?.reportedCache).toBe(true)
    // 黏性的反方向也成立：一直全 miss 的端点不会因为「前面一直 miss」而变成报过缓存。
    expect(asPreviousRequest(turn(2_000, { usage: usage({ inputTokens: 5_000 }) }), false)?.reportedCache)
      .toBe(false)
  })

  it('★ 本轮命中了一部分就一定计数（不必再问上一轮）', () => {
    // 本轮报了缓存读，说明它知道自己缓存过：这时全 miss 之前的「从未报过」不再豁免它。
    const miss = detectCacheMiss(
      previous(5_000, false, 0),
      turn(1_000, { usage: usage({ inputTokens: 4_000, cacheReadTokens: 1_000 }) }),
    )

    expect(miss?.missedTokens).toBe(5_000 - 1_000)
  })
})

// ---------------------------------------------------------------------------
// 4. 上下文合法变化
// ---------------------------------------------------------------------------

describe('压缩与分支摘要要重置基线：那是新内容，不是重复计费', () => {
  it('★ compaction 之后的第一个回合不计数，哪怕它与压缩前的那一轮长得一模一样', () => {
    // 压缩合法地**替换**了提示：这一轮的提示是新内容，不是被重新计费的旧内容。
    const miss = detectCacheMissForTurn([at(turn(1_000)), { kind: 'compaction' }], turn(2_000))

    expect(miss).toBeUndefined()
  })

  it('★ branch-summary 之后的第一轮同样不计数', () => {
    expect(detectCacheMissForTurn([at(turn(1_000)), { kind: 'branch-summary' }], turn(2_000)))
      .toBeUndefined()
  })

  it('★ 压缩之后新的一轮仍然能成为再下一轮的基线（重置的是基线，不是这一段历史）', () => {
    const afterCompaction = turn(2_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })
    const miss = detectCacheMissForTurn(
      [at(turn(1_000)), { kind: 'compaction' }, at(afterCompaction)],
      turn(3_000, { usage: usage({ inputTokens: 5_000 }) }),
    )

    // 该漏的是压缩之后那一轮的 5000 token 全体，而不是压缩前那一轮的 5000。
    expect(miss?.missedTokens).toBe(5_000)
  })

  it('★ 换模型要计：换模型会把整段提示重新计费，它是真损失而不是合法变化', () => {
    const miss = detectCacheMissForTurn(
      [at(turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) }))],
      turn(2_000, { usage: usage({ inputTokens: 5_000 }), modelKey: OTHER_MODEL }),
    )

    expect(miss?.modelChanged).toBe(true)
    expect(miss?.missedTokens).toBe(5_000)
  })

  it('同一个 modelKey（同一段路由）连续几轮不报 modelChanged', () => {
    const miss = detectCacheMissForTurn(
      [at(turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) }))],
      turn(2_000, { usage: usage({ inputTokens: 5_000 }), modelKey: MODEL }),
    )

    expect(miss?.modelChanged).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. 金额维度不存在
// ---------------------------------------------------------------------------

describe('★ 本线路不展示金额：上游单价表全为 0', () => {
  it('isCacheWasteCostPriced() 恒为 false', () => {
    // 拿 0 当单价算出「省了 0 元」是正确但无用；拿编的费率算出「省了 N 元」是撒谎。
    // 所以这条决定由本层断言，而不是靠渲染层自觉。
    expect(isCacheWasteCostPriced()).toBe(false)
    expect(STEP_CODE_PRICE_PER_MILLION_TOKENS).toBe(0)
    expect(MODEL_DEFAULTS.cost.input).toBe(0)
    expect(STEP_CODE_PRICING_STATUS).toBe('undocumented-zero')
  })

  it('missedCost 恒为 0，汇总的 missedCost 也恒为 0', () => {
    const miss = detectCacheMiss(
      previous(5_000, true, 0),
      turn(1_000, { usage: usage({ inputTokens: 5_000 }) }),
    )

    expect(miss?.missedCost).toBe(0)
    expect(computeCacheWaste([
      at(turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })),
      at(turn(2_000, { usage: usage({ inputTokens: 5_000 }) })),
    ]).missedCost).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. idle 与 TTL
// ---------------------------------------------------------------------------

describe('空闲时长是这条诊断唯一拿得到的证据', () => {
  it('★ idleMs 就是这一条与上一轮的时间差', () => {
    const miss = detectCacheMiss(
      previous(5_000, true, 1_000),
      turn(1_000 + 90_000, { usage: usage({ inputTokens: 5_000 }) }),
    )

    expect(miss?.idleMs).toBe(90_000)
  })

  it('时间戳倒挂时不给出负的空闲时长（时钟回拨不是一条负的空闲）', () => {
    const miss = detectCacheMiss(
      previous(5_000, true, 2_000),
      turn(1_000, { usage: usage({ inputTokens: 5_000 }) }),
    )

    expect(miss?.idleMs).toBe(0)
  })

  it('cacheLikelyExpired 严格大于 TTL 才是 true：刚好活到 TTL 的条目还没过期', () => {
    expect(cacheLikelyExpired(CACHE_TTL_MS)).toBe(false)
    expect(cacheLikelyExpired(CACHE_TTL_MS + 1)).toBe(true)
    expect(cacheLikelyExpired(0)).toBe(false)
    // 官方客户端对同一条提示用的也是 5 分钟 TTL。
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('空闲超过 TTL 的那次 miss 会被标成「很可能是缓存过期了」', () => {
    const miss = detectCacheMiss(
      previous(50_000, true, 0),
      turn(CACHE_TTL_MS + 1, { usage: usage({ inputTokens: 50_000 }) }),
    )

    expect(cacheLikelyExpired(miss?.idleMs ?? 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. 汇总与两个入口的一致性
// ---------------------------------------------------------------------------

describe('computeCacheWaste 的一次遍历结论与逐条计数一致', () => {
  /** 一段正常会话：只有第二轮是真 miss，其余各有不计入的理由。 */
  const warmTurn = turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })
  const totalMissTurn = turn(2_000, { usage: usage({ inputTokens: 5_000 }) })
  /** 漏掉 500：命中了大部分，落在地板以下。 */
  const belowFloorTurn = turn(3_000, { usage: usage({ inputTokens: 5_000, cacheReadTokens: 4_500 }) })
  /** 换了模型：换模型重新计费整段提示，必须计入。 */
  const switchedModelTurn = turn(4_000, { usage: usage({ inputTokens: 5_000 }), modelKey: OTHER_MODEL })
  /** 压缩之后的第一轮：没有基线，不计；它报了缓存读，所以压缩后的这一段是「报过缓存」的。 */
  const afterCompactionTurn = turn(5_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 19_000 }) })
  /** 压缩之后的第二轮：基线是 20000，一次 20000 的全 miss。 */
  const postCompactionMissTurn = turn(6_000, { usage: usage({ inputTokens: 20_000 }) })

  const HISTORY: StepCodeCacheEntry[] = [
    at(warmTurn),
    at(totalMissTurn),
    at(belowFloorTurn),
    at(switchedModelTurn),
    { kind: 'compaction' },
    at(afterCompactionTurn),
    at(postCompactionMissTurn),
  ]

  it('missCount 与 collectCacheMisses 的条数相等', () => {
    const totals = computeCacheWaste(HISTORY)
    const misses = collectCacheMisses(HISTORY)

    expect(totals.missCount).toBe(misses.size)
    // 三次：全 miss、换模型、压缩后的全 miss。地板以下的那次与压缩后第一轮都不计。
    expect(totals.missCount).toBe(3)
    expect(totals.missedTokens).toBe(5_000 + 5_000 + 20_000)
  })

  it('missedTokens 等于逐条相加，且每一条都能按它那一轮查到（以引用为键）', () => {
    const misses = collectCacheMisses(HISTORY)
    const summed = [...misses.values()].reduce((total, miss) => total + miss.missedTokens, 0)

    expect(computeCacheWaste(HISTORY).missedTokens).toBe(summed)
    // 键就是那一轮的对象本身，所以重建 transcript 的调用方不必再发明第二个身份。
    expect(misses.get(totalMissTurn)).toMatchObject({ missedTokens: 5_000 })
    expect(misses.get(switchedModelTurn)).toMatchObject({ missedTokens: 5_000, modelChanged: true })
    expect(misses.get(belowFloorTurn)).toBeUndefined()
    expect(misses.get(afterCompactionTurn)).toBeUndefined()
  })

  it('汇总与逐条计的是同一条数（两套 API 从一次遍历里出来，不可能互相矛盾）', () => {
    expect(computeCacheWaste(HISTORY).missCount)
      .toBe([...collectCacheMisses(HISTORY).values()].length)
  })

  it('★ detectCacheMissForTurn 与 detectCacheMiss 对同一输入给同一结论', () => {
    // 它们是一对入口：一个从历史收尾处自己收出基线，一个收调用方给的基线。
    const next = turn(7_000, { usage: usage({ inputTokens: 20_000 }) })
    const entries = HISTORY.slice(0, 6)
    // 末轮是压缩后第二轮，它的基线是压缩后第一轮（20_000，本段里报过缓存活动）。
    const prev = asPreviousRequest(afterCompactionTurn, true)

    expect(prev?.reportedCache).toBe(true)
    expect(detectCacheMissForTurn(entries, next)).toEqual(detectCacheMiss(prev, next))
  })

  it('★ detectCacheMissForTurn 要求历史不含这一轮：含了就是拿自己跟自己比', () => {
    // 拿自己跟自己比，聚合提示与缓存读都相同，可漏量恒为 0——诊断会永远报不出东西。
    const warmBefore = turn(1_000, { usage: usage({ inputTokens: 1_000, cacheReadTokens: 4_000 }) })
    const current = turn(9_000, { usage: usage({ inputTokens: 5_000 }) })
    const withoutIt: StepCodeCacheEntry[] = [at(warmBefore)]

    // 正确的用法：历史是「这一轮之前」的，于是问的是它对上一轮漏了多少。
    expect(detectCacheMissForTurn(withoutIt, current)?.missedTokens).toBe(5_000)
    // 传进去的历史已经含这一轮，它就拿自己跟自己比——空闲为 0、漏量是它自己的全部提示。
    // 这正是调用方必须传「这一轮之前」的历史的原因，所以这里把它钉成一个可观测的形状。
    const selfCompared = detectCacheMissForTurn([...withoutIt, at(current)], current)

    expect(selfCompared?.missedTokens).toBe(5_000)
    expect(selfCompared?.idleMs).toBe(0)
  })

  it('空历史给出零汇总，而且一次都没有 miss', () => {
    expect(computeCacheWaste([])).toEqual({ missedTokens: 0, missedCost: 0, missCount: 0 })
    expect(collectCacheMisses([]).size).toBe(0)
    expect(detectCacheMissForTurn([], turn(1_000))).toBeUndefined()
  })
})
