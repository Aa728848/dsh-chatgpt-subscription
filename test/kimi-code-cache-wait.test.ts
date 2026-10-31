import { adoptSessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_WAIT_DECISION_MS,
  CACHE_WAIT_WARMUP_ENV,
  KimiCacheWaitController,
  cacheWaitWarmupEnabled,
  evaluateCacheWait,
  type CacheWaitSession,
  type CacheWaitTimer,
} from '../src/host/kimi-code/cache-wait.ts'
import { CACHE_TTL_MS, MIN_TOKENS_TO_HINT } from '../src/host/kimi-code/cache-hint.ts'

class ManualClock {
  now = 0
  private sequence = 0
  private jobs: Array<{ id: number; at: number; callback: () => void }> = []
  readonly timer: CacheWaitTimer = {
    set: (callback, delayMs) => {
      const id = ++this.sequence
      this.jobs.push({ id, at: this.now + delayMs, callback })
      return id
    },
    clear: (handle) => {
      this.jobs = this.jobs.filter(job => job.id !== handle)
    },
  }

  get pending(): number {
    return this.jobs.length
  }

  get nextAt(): number | undefined {
    return this.jobs.length === 0 ? undefined : Math.min(...this.jobs.map(job => job.at))
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      this.jobs.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.jobs[0]
      if (next === undefined || next.at > target) break
      this.jobs.shift()
      this.now = next.at
      next.callback()
    }
    this.now = target
  }
}

function session(id: string, provider?: string): CacheWaitSession {
  return {
    id,
    requestHeader: () => provider === undefined ? undefined : { config: { provider } },
  }
}

const PARENT = 'parent-cache-wait'
const CHILD = 'child-cache-wait'

function catalog() {
  return { type: 'subagent/catalog', data: { version: 0, childId: CHILD, childCreatedAt: 0, mode: 'continuable', label: 'child' } }
}

function turn(type: 'turn/start' | 'turn/end', turnNumber = 1) {
  return { type, data: { turn: turnNumber, ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}) } }
}

function harness(options: {
  warmup?: boolean
  totalTokens?: number
  provider?: string
  steerError?: Error
} = {}) {
  const clock = new ManualClock()
  const activity = {
    lastActiveAt: 0,
    totalTokens: options.totalTokens ?? MIN_TOKENS_TO_HINT,
  }
  const agent = {
    id: PARENT,
    steer: options.steerError === undefined
      ? vi.fn()
      : vi.fn(() => { throw options.steerError }),
  }
  const controller = new KimiCacheWaitController({
    now: () => clock.now,
    timer: clock.timer,
    warmup: options.warmup,
    agents: { get: id => id === PARENT ? agent : undefined },
    activity: () => activity,
  })
  const parent = session(PARENT, options.provider ?? 'kimi-code')
  return { clock, activity, agent, controller, parent }
}

describe('evaluateCacheWait', () => {
  it('schedules from the parent model activity, never from the child start', () => {
    expect(evaluateCacheWait({
      waiting: true,
      hasChildren: true,
      now: 10 * 60 * 1000,
      lastActiveAt: 0,
      warmupEnabled: false,
      warmupUsed: false,
    })).toEqual({ kind: 'schedule', delayMs: 10 * 60 * 1000 })
  })

  it('does nothing while the parent works or no child is pending', () => {
    expect(evaluateCacheWait({ waiting: false, hasChildren: true, now: 0, lastActiveAt: 0, warmupEnabled: true, warmupUsed: false }).kind).toBe('none')
    expect(evaluateCacheWait({ waiting: true, hasChildren: false, now: 0, lastActiveAt: 0, warmupEnabled: true, warmupUsed: false }).kind).toBe('none')
  })

  it('allows cold recovery by default and after TTL, without treating it as failure', () => {
    expect(evaluateCacheWait({
      waiting: true, hasChildren: true, now: CACHE_WAIT_DECISION_MS, lastActiveAt: 0,
      totalTokens: MIN_TOKENS_TO_HINT, warmupEnabled: false, warmupUsed: false,
    }).kind).toBe('cold')
    expect(evaluateCacheWait({
      waiting: true, hasChildren: true, now: CACHE_TTL_MS, lastActiveAt: 0,
      totalTokens: MIN_TOKENS_TO_HINT, warmupEnabled: true, warmupUsed: false,
    }).kind).toBe('cold')
  })

  it('only offers warmup for an opted-in large context that has not used it', () => {
    const base = {
      waiting: true, hasChildren: true, now: CACHE_WAIT_DECISION_MS, lastActiveAt: 0,
      totalTokens: MIN_TOKENS_TO_HINT, warmupEnabled: true, warmupUsed: false,
    }
    expect(evaluateCacheWait(base).kind).toBe('warmup')
    expect(evaluateCacheWait({ ...base, totalTokens: MIN_TOKENS_TO_HINT - 1 }).kind).toBe('cold')
    expect(evaluateCacheWait({ ...base, warmupUsed: true }).kind).toBe('cold')
  })
})

describe('KimiCacheWaitController', () => {
  it('arms only when the parent becomes idle with pending children, and cancels on new work', () => {
    const h = harness()
    h.controller.observe(h.parent, catalog())
    expect(h.clock.pending).toBe(0)
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ waiting: true, childCount: 1, scheduled: true })
    expect(h.clock.nextAt).toBe(CACHE_WAIT_DECISION_MS)

    h.controller.observe(h.parent, turn('turn/start'))
    expect(h.clock.pending).toBe(0)
    expect(h.controller.snapshot(PARENT).waiting).toBe(false)
  })

  it('re-arms from later real model activity instead of the original dispatch time', () => {
    const h = harness()
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    h.clock.advance(5 * 60 * 1000)
    h.controller.observe(h.parent, turn('turn/start'))
    h.activity.lastActiveAt = 12 * 60 * 1000
    h.clock.now = h.activity.lastActiveAt
    h.controller.observe(h.parent, turn('turn/end', 2))
    expect(h.clock.nextAt).toBe(h.activity.lastActiveAt + CACHE_WAIT_DECISION_MS)
  })

  it('uses the default cold path without injecting any request or creating another timer', () => {
    const h = harness()
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
    expect(h.controller.snapshot(PARENT)).toMatchObject({ handled: true, lastDecision: 'cold', scheduled: false })
    expect(h.clock.pending).toBe(0)
  })

  it('allows one opt-in warmup and admits its message through the real Session boundary', () => {
    const h = harness({ warmup: true })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    expect(h.controller.snapshot(PARENT)).toMatchObject({ warmupUsed: true, lastDecision: 'warmup' })
    expect(() => adoptSessionEvent({
      type: 'user/message', seq: 0 as never, time: 0, surfaceOp: 'append', data: h.agent.steer.mock.calls[0]![0] as never,
    } as never)).not.toThrow()

    // Replayed catalog facts and the warmup's own turn do not re-arm the
    // one-shot allowance or become a periodic keepalive loop.
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/start', 2))
    h.controller.observe(h.parent, turn('turn/end', 2))
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('does not warm a small context or a session that is no longer on Kimi', () => {
    const small = harness({ warmup: true, totalTokens: MIN_TOKENS_TO_HINT - 1 })
    small.controller.observe(small.parent, catalog())
    small.controller.observe(small.parent, turn('turn/end'))
    small.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(small.agent.steer).not.toHaveBeenCalled()

    const other = harness({ warmup: true, provider: 'codex-chatgpt' })
    other.controller.observe(other.parent, catalog())
    other.controller.observe(other.parent, turn('turn/end'))
    expect(other.clock.pending).toBe(0)
  })

  it('cancels waiting when the child settles, including a durable settlement notice', () => {
    const h = harness()
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(1)
    h.controller.observe(h.parent, {
      type: 'user/message',
      data: { message: { source: { kind: 'subagent-settled', senderSessionId: CHILD } } },
    })
    expect(h.controller.snapshot(PARENT).childCount).toBe(0)
    expect(h.clock.pending).toBe(0)
  })

  it('contains warmup failures and still refuses a second attempt', () => {
    const warn = vi.fn()
    const clock = new ManualClock()
    const agent = { id: PARENT, steer: vi.fn(() => { throw new Error('closed') }) }
    const controller = new KimiCacheWaitController({
      now: () => clock.now, timer: clock.timer, warmup: true,
      agents: { get: () => agent },
      activity: () => ({ lastActiveAt: 0, totalTokens: MIN_TOKENS_TO_HINT }),
      logger: { warn },
    })
    const parent = session(PARENT, 'kimi-code')
    controller.observe(parent, catalog())
    controller.observe(parent, turn('turn/end'))
    clock.advance(CACHE_WAIT_DECISION_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(controller.snapshot(PARENT)).toMatchObject({ warmupUsed: true, lastDecision: 'warmup', scheduled: false })
    expect(clock.pending).toBe(0)
  })

  it('disposes timers and session links', () => {
    const h = harness()
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    h.controller.dispose()
    expect(h.clock.pending).toBe(0)
    expect(h.controller.snapshot(PARENT).childCount).toBe(0)
  })
})

describe('cacheWaitWarmupEnabled', () => {
  it('is opt-in and accepts only explicit truthy values', () => {
    expect(cacheWaitWarmupEnabled({})).toBe(false)
    expect(cacheWaitWarmupEnabled({ [CACHE_WAIT_WARMUP_ENV]: '1' })).toBe(true)
    expect(cacheWaitWarmupEnabled({ [CACHE_WAIT_WARMUP_ENV]: 'off' })).toBe(false)
  })
})
