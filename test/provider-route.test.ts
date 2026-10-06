import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { claimProviderRoute } from '../src/host/common/provider-route.ts'

/**
 * The smallest context the helper touches: an `llm` registry that refuses a
 * route another owner holds, a logger, and — when the test wants one — the
 * `llm/adapters-updated` seam.
 */
function fakeContext(options: { watch?: boolean } = {}) {
  const owners = new Set<string>()
  const listeners = new Set<() => void>()
  const registered: string[] = []
  const released: string[] = []
  const info = vi.fn()
  const warn = vi.fn()
  const adapter = { stream: () => { throw new Error('unused') } } as unknown as LlmAdapter
  const ctx = {
    llm: {
      registerAdapter(providers: string[], passed: unknown) {
        expect(passed).toBe(adapter)
        for (const provider of providers) {
          if (owners.has(provider)) {
            const error = new Error(`an adapter for provider "${provider}" is already registered`)
            ;(error as { code?: string }).code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const provider of providers) {
          owners.add(provider)
          registered.push(provider)
        }
        return () => {
          for (const provider of providers) {
            owners.delete(provider)
            released.push(provider)
          }
        }
      },
    },
    logger: { info, warn },
    ...(options.watch === false ? {} : {
      on(event: string, listener: () => void) {
        expect(event).toBe('llm/adapters-updated')
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }),
  }
  return {
    ctx: ctx as unknown as Context,
    adapter,
    info,
    warn,
    owners,
    registered,
    released,
    listenerCount: () => listeners.size,
    emit() { for (const listener of [...listeners]) listener() },
  }
}

describe('claimProviderRoute', () => {
  it('takes a free route without logging a conflict', () => {
    const harness = fakeContext()
    const claim = claimProviderRoute(harness.ctx, { providerId: 'line', label: 'Line', adapter: harness.adapter })

    expect(claim.serving()).toBe(true)
    expect(claim.conflict()).toBeNull()
    expect(harness.registered).toEqual(['line'])
    expect(harness.info).not.toHaveBeenCalled()
    expect(harness.warn).not.toHaveBeenCalled()
  })

  it('reports another owner in the line\'s own words and keeps the route unclaimed', () => {
    const harness = fakeContext()
    harness.owners.add('line')
    const claim = claimProviderRoute(harness.ctx, { providerId: 'line', label: 'Line', adapter: harness.adapter })

    expect(claim.serving()).toBe(false)
    expect(claim.conflict()).toBe('an adapter for provider "line" is already registered')
    expect(harness.warn).toHaveBeenCalledWith(
      '[dsh-chatgpt-subscription] provider route "line" is already owned by another adapter; '
      + 'Line models keep being served by that one until its configuration is removed '
      + '(an adapter for provider "line" is already registered)',
    )
    expect(harness.info).not.toHaveBeenCalled()
  })

  it('claims the route back when the owner releases it, announcing it once', () => {
    const harness = fakeContext()
    harness.owners.add('line')
    const claim = claimProviderRoute(harness.ctx, { providerId: 'line', label: 'Line', adapter: harness.adapter })
    expect(claim.serving()).toBe(false)

    harness.owners.delete('line')
    harness.emit()

    expect(claim.serving()).toBe(true)
    expect(claim.conflict()).toBeNull()
    expect(harness.info).toHaveBeenCalledWith('[dsh-chatgpt-subscription] Line route "line" is now served by this plugin')

    // A second report is a no-op: the registration is held.
    harness.emit()
    expect(harness.info).toHaveBeenCalledTimes(1)
    expect(harness.registered).toEqual(['line'])
  })

  it('releases the watch and then the registration on dispose', () => {
    const harness = fakeContext()
    const claim = claimProviderRoute(harness.ctx, { providerId: 'line', label: 'Line', adapter: harness.adapter })
    expect(harness.listenerCount()).toBe(1)

    claim.dispose()

    expect(harness.listenerCount()).toBe(0)
    expect(harness.released).toEqual(['line'])
    expect(claim.serving()).toBe(false)
    // Disposing twice stays harmless, exactly as the per-line cleanup did.
    expect(() => claim.dispose()).not.toThrow()
  })

  it('still claims on a harness whose context has no event seam', () => {
    const harness = fakeContext({ watch: false })
    const claim = claimProviderRoute(harness.ctx, { providerId: 'line', label: 'Line', adapter: harness.adapter })

    expect(claim.serving()).toBe(true)
    expect(harness.registered).toEqual(['line'])
    claim.dispose()
    expect(harness.released).toEqual(['line'])
  })

  it('never subscribes when the line opts out of the watch', () => {
    const harness = fakeContext()
    const claim = claimProviderRoute(harness.ctx, {
      providerId: 'line',
      label: 'Line',
      adapter: harness.adapter,
      watch: false,
    })

    expect(harness.listenerCount()).toBe(0)
    expect(claim.serving()).toBe(true)
  })
})
