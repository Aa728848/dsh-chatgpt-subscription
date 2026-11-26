import { describe, expect, it, vi } from 'vitest'
import {
  CACHE_WAIT_DECISION_MS,
  CACHE_WAIT_MARGIN_MS,
  KimiCacheWaitController,
  cacheWaitDecisionMs,
  type CacheWaitLogger,
  type CacheWaitSession,
  type CacheWaitTimer,
} from '../../src/host/providers/kimi-code/cache-wait.ts'
import type { PromptCacheOverride } from '../../src/host/common/prompt-cache-policy.ts'

const HOUR_MS = 3_600_000
const FIVE_MINUTES_MS = 300_000
/** The 1h tier minus the 5-minute keepalive margin, like every line. */
const CLAUDE_DECISION_MS = 3_300_000
const PARENT = 'parent-cache-wait-jobs'
const CHILD = 'child-cache-wait-jobs'

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

interface MutableActivity {
  lastActiveAt: number
  totalTokens: number
  ttlMs?: number
}

function session(id: string, provider: string): CacheWaitSession {
  return { id, requestHeader: () => ({ config: { provider } }) }
}

function catalog(childId = CHILD) {
  return { type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: 0, mode: 'continuable', label: 'child' } }
}

function childEnd(childId = CHILD) {
  return { type: 'subagent/end', data: { id: childId } }
}

function turn(type: 'turn/start' | 'turn/end', turnNumber = 1) {
  return { type, data: { turn: turnNumber, ...(type === 'turn/end' ? { reason: { kind: 'completed' } } : {}) } }
}

/** The durable shape dsh-jobs-local appends to the OWNER session. */
function jobRegistered(jobId: string) {
  return { type: 'job/registered', data: { jobId, owner: PARENT, kind: 'bash', label: 'build', startedAt: 0 } }
}

function jobSettled(jobId: string) {
  return { type: 'job/settled', data: { jobId, owner: PARENT, kind: 'bash', label: 'build', startedAt: 0, state: 'completed' } }
}

function harness(options: {
  provider?: string
  ttlMs?: number
  warmup?: boolean
  overrides?: Readonly<Record<string, PromptCacheOverride>>
  logger?: CacheWaitLogger
} = {}) {
  const clock = new ManualClock()
  const activity: MutableActivity = {
    lastActiveAt: 0,
    totalTokens: 4_096,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  }
  const agent = { id: PARENT, steer: vi.fn() }
  const controller = new KimiCacheWaitController({
    now: () => clock.now,
    timer: clock.timer,
    warmup: options.warmup ?? true,
    agents: { get: id => id === PARENT ? agent : undefined },
    activity: () => activity,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  const parent = session(PARENT, options.provider ?? 'kimi-code')
  return { clock, activity, agent, controller, parent }
}

/** End the keepalive turn the way a real main turn does: activity refreshes, then turn/end. */
function keepaliveTurnEnded(h: ReturnType<typeof harness>, turnNumber: number): void {
  h.controller.observe(h.parent, turn('turn/start', turnNumber))
  h.activity.lastActiveAt = h.clock.now
  h.controller.observe(h.parent, turn('turn/end', turnNumber))
}

describe('cacheWaitDecisionMs', () => {
  it('decides five minutes before expiry, and nothing at or below the margin', () => {
    expect(cacheWaitDecisionMs(60 * 60_000)).toBe(55 * 60_000)
    expect(cacheWaitDecisionMs(25 * 60_000)).toBe(20 * 60_000)
    expect(cacheWaitDecisionMs(10 * 60_000)).toBe(5 * 60_000)
    expect(cacheWaitDecisionMs(6 * 60_000)).toBe(60_000)
    expect(cacheWaitDecisionMs(5 * 60_000)).toBeUndefined()
    expect(cacheWaitDecisionMs(60_000)).toBeUndefined()
    expect(cacheWaitDecisionMs(CACHE_WAIT_MARGIN_MS)).toBeUndefined()
    expect(cacheWaitDecisionMs(CACHE_WAIT_MARGIN_MS + 1)).toBe(1)
    expect(cacheWaitDecisionMs(CACHE_WAIT_DECISION_MS + CACHE_WAIT_MARGIN_MS)).toBe(CACHE_WAIT_DECISION_MS)
  })
})

describe('cache wait while background jobs run', () => {
  it('keeps a claude-api 1h session warm every 55 minutes while a subagent runs, then stops', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    expect(h.clock.pending).toBe(0)
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)

    keepaliveTurnEnded(h, 2)
    expect(h.clock.nextAt).toBe(2 * CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)

    h.controller.observe(h.parent, childEnd())
    expect(h.clock.pending).toBe(0)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
  })

  it('keeps a claude-api 1h session warm for a background job alone, with no subagent', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    expect(h.clock.pending).toBe(0)
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ childCount: 0, jobCount: 1, scheduled: true })
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)

    keepaliveTurnEnded(h, 2)
    expect(h.clock.nextAt).toBe(2 * CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)

    h.controller.observe(h.parent, jobSettled('job-1'))
    expect(h.controller.snapshot(PARENT).jobCount).toBe(0)
    expect(h.clock.pending).toBe(0)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
  })

  it('keeps a kimi-code session warm for a background job alone at its own 20-minute point', () => {
    const h = harness({ provider: 'kimi-code' })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ childCount: 0, jobCount: 1, scheduled: true })
    expect(h.clock.nextAt).toBe(CACHE_WAIT_DECISION_MS)
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)

    keepaliveTurnEnded(h, 2)
    expect(h.clock.nextAt).toBe(2 * CACHE_WAIT_DECISION_MS)
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)

    h.controller.observe(h.parent, jobSettled('job-1'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
  })

  it('decides five minutes before the ttl when an override enables waitJobs on another line', () => {
    const h = harness({
      provider: 'step-code',
      overrides: { 'step-code': { waitWarmup: true, waitJobs: true, ttlMs: 600_000 } },
    })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.nextAt).toBe(300_000)
    h.clock.advance(300_000)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    // One keepalive per idle window: nothing re-arms itself until a turn finishes.
    h.clock.advance(600_000)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    expect(h.clock.pending).toBe(0)
  })

  it('follows the same ttl-minus-margin rule on kimi-code when its ttl is overridden', () => {
    const h = harness({ provider: 'kimi-code', overrides: { 'kimi-code': { ttlMs: HOUR_MS } } })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.nextAt).toBe(55 * 60_000)
    h.clock.advance(55 * 60_000)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('never schedules or warms a ttl with no margin, and warns once per provider', () => {
    const warn = vi.fn()
    const overrides: Readonly<Record<string, PromptCacheOverride>> = {
      qoder: { mode: 'automatic', waitWarmup: true, waitJobs: true, ttlMs: FIVE_MINUTES_MS },
    }
    const h = harness({ provider: 'qoder', overrides, logger: { warn } })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(HOUR_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
    expect(h.controller.snapshot(PARENT)).toMatchObject({ scheduled: false, warmupUsed: false, handled: false })
    expect(warn).toHaveBeenCalledTimes(1)
    // A second session of the same provider must not warn again in this process.
    const other = session('another-qoder-session', 'qoder')
    h.controller.observe(other, catalog())
    h.controller.observe(other, turn('turn/end'))
    h.clock.advance(HOUR_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(h.clock.pending).toBe(0)
  })

  it('never warms for jobs alone on a line that has waitWarmup but no waitJobs', () => {
    const h = harness({
      provider: 'step-code',
      overrides: { 'step-code': { waitWarmup: true, ttlMs: 600_000 } },
    })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(5_000)
    expect(h.agent.steer).not.toHaveBeenCalled()

    // The same override still warms for a real subagent: only the job opt-in is missing.
    h.activity.lastActiveAt = h.clock.now
    h.controller.observe(h.parent, catalog())
    expect(h.clock.nextAt).toBe(h.clock.now + 300_000)
    h.clock.advance(300_000)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('keeps a child-less job session armed when the child settles first', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(1)
    h.controller.observe(h.parent, childEnd())
    expect(h.controller.snapshot(PARENT)).toMatchObject({ childCount: 0, jobCount: 1 })
    expect(h.clock.pending).toBe(1)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('re-arms the batch when a new job registers, exactly like a new child', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    expect(h.controller.snapshot(PARENT)).toMatchObject({ handled: true, warmupCount: 1 })

    h.activity.lastActiveAt = h.clock.now
    h.controller.observe(h.parent, jobRegistered('job-2'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ handled: false, warmupUsed: false, warmupCount: 0, jobCount: 1 })
    expect(h.clock.nextAt).toBe(h.clock.now + CLAUDE_DECISION_MS)
  })

  it('ignores job/settled for an unknown id and for an unknown session', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    h.controller.observe(h.parent, jobSettled('job-unknown'))
    expect(h.controller.snapshot(PARENT).jobCount).toBe(1)
    expect(h.clock.pending).toBe(1)
    expect(() => h.controller.observe(session('other-session', 'claude-api'), jobSettled('job-1'))).not.toThrow()
    expect(h.clock.pending).toBe(1)
    h.controller.observe(h.parent, jobSettled('job-1'))
    expect(h.clock.pending).toBe(0)
  })

  it('bounds the per-session job set at 256 and drops it with the session state', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    for (let index = 0; index < 300; index += 1) h.controller.observe(h.parent, jobRegistered('job-' + index))
    expect(h.controller.snapshot(PARENT).jobCount).toBe(256)
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(1)
    h.controller.disposeAgent({ id: PARENT })
    expect(h.controller.snapshot(PARENT)).toMatchObject({ jobCount: 0, childCount: 0, scheduled: false })
    expect(h.clock.pending).toBe(0)
  })
})

describe('cache wait on the claude subscription line', () => {
  it('keeps a claude 1h session warm every 55 minutes while a subagent runs, then stops', () => {
    const h = harness({ provider: 'claude', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    keepaliveTurnEnded(h, 2)
    expect(h.clock.nextAt).toBe(2 * CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
    h.controller.observe(h.parent, childEnd())
    expect(h.clock.pending).toBe(0)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
  })

  it('keeps a claude 1h session warm for a background job alone, and stops on job/settled', () => {
    const h = harness({ provider: 'claude', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ childCount: 0, jobCount: 1, scheduled: true })
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
    keepaliveTurnEnded(h, 2)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
    h.controller.observe(h.parent, jobSettled('job-1'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(2)
  })

  it('never schedules a claude session whose last request wrote the 5m tier', () => {
    const h = harness({ provider: 'claude', ttlMs: FIVE_MINUTES_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(HOUR_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
  })
})

describe('cache wait tier gating by the last written cache lifetime', () => {
  it('never schedules or warms a claude-api session whose last request wrote 5m', () => {
    const h = harness({ provider: 'claude-api', ttlMs: FIVE_MINUTES_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(HOUR_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
    expect(h.controller.snapshot(PARENT)).toMatchObject({ warmupUsed: false, scheduled: false })
  })

  it('clears the armed timer when the session switches from the 1h tier to the 5m tier', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(1)
    h.activity.ttlMs = FIVE_MINUTES_MS
    h.controller.observe(h.parent, turn('turn/end', 2))
    expect(h.clock.pending).toBe(0)
    h.clock.advance(HOUR_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('behaves as before when the activity record carries no ttlMs at all', () => {
    const kimi = harness({ provider: 'kimi-code' })
    kimi.controller.observe(kimi.parent, catalog())
    kimi.controller.observe(kimi.parent, turn('turn/end'))
    expect(kimi.clock.nextAt).toBe(CACHE_WAIT_DECISION_MS)
    kimi.clock.advance(CACHE_WAIT_DECISION_MS)
    expect(kimi.agent.steer).toHaveBeenCalledTimes(1)
    expect(kimi.controller.snapshot(PARENT).jobCount).toBe(0)

    const claude = harness({ provider: 'claude-api' })
    claude.controller.observe(claude.parent, catalog())
    claude.controller.observe(claude.parent, turn('turn/end'))
    expect(claude.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    claude.clock.advance(CLAUDE_DECISION_MS)
    expect(claude.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('still obeys the global cacheWaitWarmup switch on the 1h tier', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS, warmup: false })
    h.controller.observe(h.parent, jobRegistered('job-1'))
    h.controller.observe(h.parent, turn('turn/end'))
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).not.toHaveBeenCalled()
    expect(h.controller.snapshot(PARENT)).toMatchObject({ handled: true, lastDecision: 'cold', scheduled: false })
  })
})

describe('deployment overrides on an opted-in line', () => {
  it('schedules a claude-subscription session by default', () => {
    const h = harness({ provider: 'claude-subscription', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end', 1))
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
  })

  it('lets an override keyed by the line id switch the keepalive off for its route id', () => {
    const h = harness({ provider: 'claude-subscription', ttlMs: HOUR_MS, overrides: { claude: { waitWarmup: false } } })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end', 1))
    h.clock.advance(HOUR_MS)
    expect(h.clock.pending).toBe(0)
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('accepts a Kimi override that only turns waitWarmup off', () => {
    const h = harness({ overrides: { 'kimi-code': { waitWarmup: false } } })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end', 1))
    h.clock.advance(HOUR_MS)
    expect(h.clock.pending).toBe(0)
    expect(h.agent.steer).not.toHaveBeenCalled()
  })
})

describe('cache wait re-attaches children it stopped tracking', () => {
  /** The durable shape the current host appends for a child's completion notice. */
  function settled(childId = CHILD) {
    return { type: 'user/message', data: { content: [{ type: 'text', text: 'finished' }], source: { kind: 'subagent-settled', senderSessionId: childId } } }
  }

  /** A controller whose activity only the claude-api store knows, like a real claude-api session. */
  function claudeApiHarness() {
    const clock = new ManualClock()
    const activity: MutableActivity = { lastActiveAt: 0, totalTokens: 4_096, ttlMs: HOUR_MS }
    const agent = { id: PARENT, steer: vi.fn() }
    const controller = new KimiCacheWaitController({
      now: () => clock.now,
      timer: clock.timer,
      warmup: true,
      agents: { get: id => id === PARENT ? agent : undefined },
      activity: (_id, provider) => provider === 'claude-api' ? activity : undefined,
    })
    return { clock, activity, agent, controller }
  }

  it('re-tracks a settled child the parent reuses through send_message (no new catalog)', () => {
    const h = harness({ provider: 'claude-api', ttlMs: HOUR_MS })
    h.controller.observe(h.parent, catalog())
    h.controller.observe(h.parent, turn('turn/end'))
    expect(h.clock.pending).toBe(1)

    // The child reports back; the parent's next turn reuses it with send_message.
    h.clock.advance(10 * 60_000)
    h.controller.observe(h.parent, turn('turn/start', 2))
    h.controller.observe(h.parent, settled())
    expect(h.controller.snapshot(PARENT).childCount).toBe(0)
    h.activity.lastActiveAt = h.clock.now
    h.controller.observe({ id: CHILD }, turn('turn/start'))
    expect(h.controller.snapshot(PARENT).childCount).toBe(1)
    expect(h.clock.pending).toBe(0)
    h.controller.observe(h.parent, turn('turn/end', 2))

    expect(h.clock.nextAt).toBe(h.activity.lastActiveAt + CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('adopts an idle parent after a host restart when its child resumes', () => {
    const h = claudeApiHarness()
    // The restarted host replays nothing: the parent only appends a seed marker.
    h.clock.advance(40 * 60_000)
    h.controller.observe({ id: PARENT }, { type: 'session/end-seed', data: {} })
    h.controller.observe(
      { id: CHILD, header: { parentSession: PARENT, origin: 'subagent' } },
      turn('turn/start'),
    )
    expect(h.controller.snapshot(PARENT)).toMatchObject({ waiting: true, childCount: 1, scheduled: true })
    // Scheduled from the persisted issue time, not from the restart.
    expect(h.clock.nextAt).toBe(CLAUDE_DECISION_MS)
    h.clock.advance(CLAUDE_DECISION_MS - 40 * 60_000)
    expect(h.agent.steer).toHaveBeenCalledTimes(1)
  })

  it('does not adopt a parent it has seen start a turn that has not ended', () => {
    const h = claudeApiHarness()
    h.controller.observe({ id: PARENT }, turn('turn/start'))
    h.controller.observe(
      { id: CHILD, header: { parentSession: PARENT, origin: 'subagent' } },
      turn('turn/start'),
    )
    expect(h.controller.snapshot(PARENT)).toMatchObject({ waiting: false, childCount: 1, scheduled: false })
  })

  it('ignores a turn from a session that is nobody\'s child', () => {
    const h = claudeApiHarness()
    h.controller.observe({ id: 'lonely', header: { origin: 'user' } }, turn('turn/start'))
    h.controller.observe({ id: 'forked', header: { parentSession: PARENT, origin: 'fork' } }, turn('turn/start'))
    expect(h.controller.snapshot(PARENT)).toMatchObject({ childCount: 0, scheduled: false })
  })
})
