import { describe, expect, it, vi } from 'vitest'
import { createAntigravitySessionExecutor } from '../src/host/multi-provider-runtime.ts'

describe('Antigravity session transport selection', () => {
  it('uses official agy CLI for active CLI sessions without exported tokens', () => {
    const native = vi.fn(() => 'native')
    const cli = vi.fn(() => 'cli')
    const execute = createAntigravitySessionExecutor(native, cli)

    expect(execute({ invocation: { account: { resources: { sessionSource: 'cli', sessionPersistence: 'active' } } } })).toBe('cli')
    expect(cli).toHaveBeenCalledOnce()
    expect(native).not.toHaveBeenCalled()
  })

  it('uses native OAuth transport for captured and browser sessions', () => {
    const native = vi.fn(() => 'native')
    const cli = vi.fn(() => 'cli')
    const execute = createAntigravitySessionExecutor(native, cli)

    expect(execute({ invocation: { account: { resources: { sessionSource: 'cli', sessionPersistence: 'captured' } } } })).toBe('native')
    expect(execute({ invocation: { account: { resources: { sessionSource: 'browser', sessionPersistence: 'captured' } } } })).toBe('native')
    expect(native).toHaveBeenCalledTimes(2)
    expect(cli).not.toHaveBeenCalled()
  })
})
