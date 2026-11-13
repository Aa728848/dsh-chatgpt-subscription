/**
 * The sign-in state cache: short-lived, single-flight, and invalidated exactly
 * when the answer is known to have changed.
 */
import { describe, expect, it } from 'vitest'
import { AcpAuthCache, AUTH_CACHE_TTL_MS } from '../src/host/antigravity-acp/auth-cache.ts'

describe('AcpAuthCache', () => {
  it('probes once inside the window, however many readers ask', async () => {
    let calls = 0
    const cache = new AcpAuthCache(async () => {
      calls += 1
      return { authenticated: true }
    }, () => 0)
    await Promise.all([cache.read(), cache.read(), cache.read()])
    expect(calls).toBe(1)
    await cache.read()
    expect(calls).toBe(1)
  })

  it('probes again once the window has passed', async () => {
    let now = 0
    let calls = 0
    const cache = new AcpAuthCache(async () => {
      calls += 1
      return { authenticated: calls > 1 }
    }, () => now)
    expect((await cache.read()).authenticated).toBe(false)
    now = AUTH_CACHE_TTL_MS + 1
    expect((await cache.read()).authenticated).toBe(true)
    expect(calls).toBe(2)
  })

  it('forgets the answer when a sign-in was started', async () => {
    let calls = 0
    const cache = new AcpAuthCache(async () => {
      calls += 1
      return { authenticated: calls > 1 }
    }, () => 0)
    await cache.read()
    cache.invalidate()
    expect((await cache.read()).authenticated).toBe(true)
    expect(calls).toBe(2)
  })

  it('answers "not signed in" when the probe itself fails, rather than throwing', async () => {
    const cache = new AcpAuthCache(async () => {
      throw new Error('spawn failed')
    })
    await expect(cache.read()).resolves.toEqual({ authenticated: false })
  })
})
