/**
 * Regression tests for the client follow-up poll.
 *
 * The host answers a status card from the snapshot it already has and refreshes
 * the quota behind that answer, so the card renders immediately. The refreshed
 * numbers would otherwise only appear on the next 60 s poll, so an answer that
 * reports a refresh in flight schedules one short follow-up — bounded, so a
 * refresh that keeps failing cannot make the client poll forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuotaFollowUp } from '../src/client/common/quota-follow-up.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createQuotaFollowUp', () => {
  it('asks again shortly after an answer that refreshed behind itself', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000 })
    followUp.observe(true, reload)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after a settled answer', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000 })
    followUp.observe(false, reload)
    vi.advanceTimersByTime(10_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('never stacks a second follow-up on one that is still pending', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000 })
    followUp.observe(true, reload)
    followUp.observe(true, reload)
    followUp.observe(true, reload)
    vi.advanceTimersByTime(1_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('stops after a few consecutive follow-ups', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000, maxAttempts: 3 })
    // A refresh that keeps failing leaves every answer stale; the chain must end
    // and leave the surface to its ordinary polling.
    for (let round = 0; round < 10; round += 1) {
      followUp.observe(true, reload)
      vi.advanceTimersByTime(1_000)
    }
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('starts a fresh chain once an answer settles', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000, maxAttempts: 1 })
    followUp.observe(true, reload)
    vi.advanceTimersByTime(1_000)
    expect(reload).toHaveBeenCalledTimes(1)

    // The cap is reached, so nothing more is scheduled...
    followUp.observe(true, reload)
    vi.advanceTimersByTime(1_000)
    expect(reload).toHaveBeenCalledTimes(1)

    // ...until an answer settles, which resets the chain.
    followUp.observe(false, reload)
    followUp.observe(true, reload)
    vi.advanceTimersByTime(1_000)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('drops a pending follow-up when the surface goes away', () => {
    const reload = vi.fn()
    const followUp = createQuotaFollowUp({ delayMs: 1_000 })
    followUp.observe(true, reload)
    followUp.cancel()
    vi.advanceTimersByTime(10_000)
    expect(reload).not.toHaveBeenCalled()
  })
})