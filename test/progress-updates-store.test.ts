import { describe, expect, it } from 'vitest'
import {
  MAX_UPDATES,
  NUDGE_THRESHOLD,
  capUpdates,
  createProgressUpdateStore,
  nextUpdateId,
  shouldNudge,
} from '../src/host/progress-updates/store.ts'
import type { ProgressUpdate } from '../src/host/progress-updates/store.ts'

/** 造一条进展，只需要 id 唯一就够测环形缓冲。 */
function update(index: number): ProgressUpdate {
  return { id: `u${index}`, message: `message ${index}`, at: 1_000 + index }
}

describe('capUpdates', () => {
  it('短列表原样返回（且不是同一个数组实例）', () => {
    const input = [update(1), update(2)]
    const capped = capUpdates(input)
    expect(capped).toEqual(input)
    expect(capped).not.toBe(input)
  })

  it('达到上限时原样保留', () => {
    const input = Array.from({ length: MAX_UPDATES }, (_, index) => update(index))
    expect(capUpdates(input)).toHaveLength(MAX_UPDATES)
  })

  it('超出上限时丢弃最旧的，只留最新的 MAX_UPDATES 条', () => {
    const input = Array.from({ length: MAX_UPDATES + 12 }, (_, index) => update(index))
    const capped = capUpdates(input)
    expect(capped).toHaveLength(MAX_UPDATES)
    // 保留的是尾部：第一条是被丢到只剩最后 MAX_UPDATES 条之后的那一条。
    expect(capped[0]?.id).toBe(`u${12}`)
    expect(capped[capped.length - 1]?.id).toBe(`u${MAX_UPDATES + 11}`)
  })

  it('不就地修改入参', () => {
    const input = Array.from({ length: MAX_UPDATES + 3 }, (_, index) => update(index))
    const before = input.length
    capUpdates(input)
    expect(input).toHaveLength(before)
  })
})

describe('shouldNudge', () => {
  it('阈值是 8', () => {
    expect(NUDGE_THRESHOLD).toBe(8)
  })

  it('低于阈值不催促', () => {
    for (let rounds = 0; rounds < NUDGE_THRESHOLD; rounds += 1) {
      expect(shouldNudge(rounds), String(rounds)).toBe(false)
    }
  })

  it('达到与超过阈值都催促', () => {
    expect(shouldNudge(NUDGE_THRESHOLD)).toBe(true)
    expect(shouldNudge(NUDGE_THRESHOLD + 100)).toBe(true)
  })
})

describe('createProgressUpdateStore', () => {
  it('初始状态为空且计数归零', () => {
    expect(createProgressUpdateStore().state()).toEqual({ updates: [], roundsSinceUpdate: 0, nudges: 0 })
  })

  it('push 追加进展并按环形缓冲截断', () => {
    const store = createProgressUpdateStore()
    for (let index = 0; index < MAX_UPDATES + 5; index += 1) store.push(update(index))
    const state = store.state()
    expect(state.updates).toHaveLength(MAX_UPDATES)
    expect(state.updates[0]?.id).toBe(`u${5}`)
    expect(state.updates[MAX_UPDATES - 1]?.id).toBe(`u${MAX_UPDATES + 4}`)
  })

  it('bumpRound 累加轮次，markUpdated 归零', () => {
    const store = createProgressUpdateStore()
    expect(store.bumpRound()).toBe(1)
    expect(store.bumpRound()).toBe(2)
    expect(store.state().roundsSinceUpdate).toBe(2)
    store.markUpdated()
    expect(store.state().roundsSinceUpdate).toBe(0)
  })

  it('markNudged 归零轮次并累加催促次数', () => {
    const store = createProgressUpdateStore()
    for (let index = 0; index < NUDGE_THRESHOLD; index += 1) store.bumpRound()
    expect(shouldNudge(store.state().roundsSinceUpdate)).toBe(true)
    store.markNudged()
    expect(store.state().roundsSinceUpdate).toBe(0)
    expect(store.state().nudges).toBe(1)
    store.markNudged()
    expect(store.state().nudges).toBe(2)
  })

  it('归零之后要重新攒满阈值才会再次催促', () => {
    const store = createProgressUpdateStore()
    for (let index = 0; index < NUDGE_THRESHOLD; index += 1) store.bumpRound()
    store.markNudged()
    for (let index = 0; index < NUDGE_THRESHOLD - 1; index += 1) {
      expect(shouldNudge(store.bumpRound())).toBe(false)
    }
    expect(shouldNudge(store.bumpRound())).toBe(true)
  })

  it('reset 清空一切', () => {
    const store = createProgressUpdateStore()
    store.push(update(1))
    store.bumpRound()
    store.markNudged()
    expect(store.reset()).toEqual({ updates: [], roundsSinceUpdate: 0, nudges: 0 })
  })
})

describe('nextUpdateId', () => {
  it('同一毫秒内也保持唯一', () => {
    const ids = new Set(Array.from({ length: 100 }, () => nextUpdateId(1_700_000_000_000)))
    expect(ids.size).toBe(100)
  })

  it('带上时间戳前缀，便于人工辨认', () => {
    expect(nextUpdateId(1_700_000_000_000)).toMatch(/^pu-1700000000000-\d+$/)
  })
})
