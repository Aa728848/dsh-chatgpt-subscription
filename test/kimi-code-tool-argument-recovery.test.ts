import { describe, expect, it, vi } from 'vitest'
import {
  createKimiToolArgumentRecoveryMessage,
  installKimiToolArgumentRecovery,
  type RecoveryContext,
} from '../src/host/kimi-code/tool-argument-recovery.ts'
import {
  TOOL_ARGUMENT_BYTES_EXCEEDED_CODE,
  TOOL_ARGUMENT_REPEATED_KEY_CODE,
} from '../src/host/kimi-code/tool-argument-guard.ts'

type Listener = (payload: unknown, next: () => Promise<undefined>) => Promise<{ kind: 'retry' } | undefined>

function host() {
  const listeners = new Map<string, Listener>()
  const ctx = {
    on(event: string, listener: Listener) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  } as unknown as RecoveryContext
  const dispose = installKimiToolArgumentRecovery(ctx)
  return { listeners, dispose }
}

function agent(id = 'session-1', onAppend?: () => void) {
  const appended: unknown[] = []
  return {
    id,
    appended,
    session: {
      id,
      append(type: string, message: unknown, options: unknown) {
        onAppend?.()
        appended.push({ type, message, options })
      },
    },
  }
}

function payload(subject: ReturnType<typeof agent>, code: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: subject,
    turn: 1,
    step: 1,
    provider: 'kimi-code',
    failure: { code, message: 'guard stopped the call' },
    signal: { aborted: false },
    ...overrides,
  }
}

const terminal = async (): Promise<undefined> => undefined

describe('Kimi tool-argument recovery', () => {
  it('appends a repeated-key notice before owning the first retry', async () => {
    const h = host()
    const events: string[] = []
    const subject = agent('session-repeat', () => events.push('append'))
    const next = vi.fn(async () => { events.push('next'); return undefined })
    const listener = h.listeners.get('agent/request-error')!

    const result = await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE), next)
    expect(result).toEqual({ kind: 'retry' })
    expect(events).toEqual(['append'])
    expect(subject.appended).toHaveLength(1)
    expect(subject.appended[0]).toMatchObject({ type: 'user/message', options: { surfaceOp: 'append' } })
    const text = JSON.stringify(subject.appended[0])
    expect(text).toContain('fresh')
    expect(text).toContain('multi_select')
    expect(text).not.toContain('header（可选）')
    h.dispose()
  })

  it('uses a payload-reduction instruction for the byte ceiling', () => {
    const message = createKimiToolArgumentRecoveryMessage(TOOL_ARGUMENT_BYTES_EXCEEDED_CODE)
    expect(JSON.stringify(message)).toContain('smallest sufficient arguments')
    expect(JSON.stringify(message)).toContain('Do not resend the same payload')
  })

  it('hands a second failure in the same step back without another prompt', async () => {
    const h = host()
    const subject = agent()
    const listener = h.listeners.get('agent/request-error')!
    const firstNext = vi.fn(terminal)
    await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE), firstNext)
    expect(firstNext).not.toHaveBeenCalled()

    const secondNext = vi.fn(terminal)
    const result = await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE), secondNext)
    expect(result).toBeUndefined()
    expect(secondNext).toHaveBeenCalledTimes(1)
    expect(subject.appended).toHaveLength(1)
    h.dispose()
  })

  it('keeps different steps independent', async () => {
    const h = host()
    const subject = agent()
    const listener = h.listeners.get('agent/request-error')!
    await listener(payload(subject, TOOL_ARGUMENT_BYTES_EXCEEDED_CODE, { step: 1 }), terminal)
    await listener(payload(subject, TOOL_ARGUMENT_BYTES_EXCEEDED_CODE, { step: 2 }), terminal)
    expect(subject.appended).toHaveLength(2)
    h.dispose()
  })

  it('does not recover other providers, other errors, or a cancelled step', async () => {
    const h = host()
    const subject = agent()
    const listener = h.listeners.get('agent/request-error')!
    for (const value of [
      payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE, { provider: 'minimax-code' }),
      payload(subject, 'PROVIDER_ERROR'),
      payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE, { signal: { aborted: true } }),
    ]) {
      const next = vi.fn(terminal)
      expect(await listener(value, next)).toBeUndefined()
      expect(next).toHaveBeenCalledTimes(1)
    }
    expect(subject.appended).toHaveLength(0)
    h.dispose()
  })

  it('never invokes a failing downstream twice', async () => {
    const h = host()
    const subject = agent()
    const listener = h.listeners.get('agent/request-error')!
    const next = vi.fn(async () => { throw new Error('downstream failed') })
    await expect(listener(payload(subject, 'PROVIDER_ERROR'), next as never)).rejects.toThrow('downstream failed')
    expect(next).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('does not retry when the recovery notice cannot be appended', async () => {
    const h = host()
    const subject = agent('session-append-failure', () => { throw new Error('append failed') })
    const listener = h.listeners.get('agent/request-error')!
    const next = vi.fn(terminal)
    expect(await listener(payload(subject, TOOL_ARGUMENT_BYTES_EXCEEDED_CODE), next)).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it('clears a disposed session and bounds remembered recovery steps', async () => {
    const h = host()
    const subject = agent('session-dispose')
    const listener = h.listeners.get('agent/request-error')!
    await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE), terminal)
    h.listeners.get('agent/disposed')?.({ agent: subject }, terminal)
    await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE), terminal)
    expect(subject.appended).toHaveLength(2)

    for (let step = 2; step <= 302; step += 1) {
      await listener(payload(subject, TOOL_ARGUMENT_BYTES_EXCEEDED_CODE, { step }), terminal)
    }
    // The original key has been evicted by this bounded sequence and may recover once more.
    await listener(payload(subject, TOOL_ARGUMENT_REPEATED_KEY_CODE, { step: 1 }), terminal)
    expect(subject.appended).toHaveLength(304)
    h.dispose()
  })
})
