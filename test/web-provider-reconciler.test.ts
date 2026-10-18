import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEB_PROVIDER_RECONCILE_INTERVAL_MS,
  startWebProviderReconciler,
} from '../src/host/web-provider-reconciler.ts'

describe('startWebProviderReconciler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('re-checks the selection on every interval', () => {
    const reconcile = vi.fn()
    const stop = startWebProviderReconciler({ reconcile, intervalMs: 1_000 })
    try {
      expect(reconcile).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1_000)
      expect(reconcile).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2_000)
      expect(reconcile).toHaveBeenCalledTimes(3)
    } finally { stop() }
  })

  it('uses the shipped interval when none is given', () => {
    const reconcile = vi.fn()
    const stop = startWebProviderReconciler({ reconcile })
    try {
      vi.advanceTimersByTime(WEB_PROVIDER_RECONCILE_INTERVAL_MS - 1)
      expect(reconcile).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(reconcile).toHaveBeenCalledTimes(1)
    } finally { stop() }
  })

  it('stops checking once the disposer runs', () => {
    const reconcile = vi.fn()
    const stop = startWebProviderReconciler({ reconcile, intervalMs: 1_000 })
    vi.advanceTimersByTime(1_000)
    expect(reconcile).toHaveBeenCalledTimes(1)
    stop()
    vi.advanceTimersByTime(10_000)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  // A pass runs while the loader may be restarting the very entry it reads, and a
  // store that throws must not cost every later pass its turn.
  it('keeps checking after a pass throws', () => {
    const reconcile = vi.fn(() => { throw new Error('entry mid-restart') })
    const stop = startWebProviderReconciler({ reconcile, intervalMs: 1_000 })
    try {
      expect(() => vi.advanceTimersByTime(3_000)).not.toThrow()
      expect(reconcile).toHaveBeenCalledTimes(3)
    } finally { stop() }
  })
})
