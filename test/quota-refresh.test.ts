/**
 * Regression tests for the background quota refresh.
 *
 * A status card used to block on the upstream quota request whenever its
 * snapshot had aged past the line's TTL — measured at up to 3.6 s on a real
 * machine. A snapshot that exists answers immediately instead, with the refresh
 * running behind it, and the outcome is remembered so a refresh that keeps
 * failing cannot look like a snapshot that never aged.
 */

import { describe, expect, it, vi } from 'vitest'
import { QuotaRefresh } from '../src/host/common/quota-refresh.ts'

/** A refresh that settles only when the returned resolver is called. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('QuotaRefresh', () => {
  it('reports no refresh in flight before anything starts', () => {
    const refresh = new QuotaRefresh()
    expect(refresh.refreshing).toBe(false)
    expect(refresh.lastError()).toBeNull()
  })

  it('answers while the refresh it started is still running', async () => {
    const refresh = new QuotaRefresh()
    const gate = deferred()
    refresh.start(() => gate.promise)
    // The caller has already answered; the flag is what asks the client to come
    // back when the refresh lands.
    expect(refresh.refreshing).toBe(true)
    gate.resolve()
    await gate.promise
    await Promise.resolve()
    expect(refresh.refreshing).toBe(false)
  })

  it('does not duplicate a refresh that is already running', async () => {
    const refresh = new QuotaRefresh()
    const gate = deferred()
    const work = vi.fn(() => gate.promise)
    refresh.start(work)
    refresh.start(work)
    gate.resolve()
    await gate.promise
    await Promise.resolve()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('remembers a failed background refresh instead of dropping it', async () => {
    const refresh = new QuotaRefresh()
    refresh.start(async () => { throw new Error('quota endpoint unreachable') })
    await vi.waitFor(() => expect(refresh.lastError()).toBe('quota endpoint unreachable'))
    expect(refresh.refreshing).toBe(false)
  })

  it('clears the remembered failure after a successful refresh', async () => {
    const refresh = new QuotaRefresh()
    await refresh.run(async () => { throw new Error('first failure') })
    expect(refresh.lastError()).toBe('first failure')
    await refresh.run(async () => undefined)
    expect(refresh.lastError()).toBeNull()
  })

  it('records the failure of a waited refresh without throwing it', async () => {
    const refresh = new QuotaRefresh()
    await expect(refresh.run(async () => { throw new Error('keyring locked') })).resolves.toBeUndefined()
    expect(refresh.lastError()).toBe('keyring locked')
  })
})