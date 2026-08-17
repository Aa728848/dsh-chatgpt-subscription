import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import {
  DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER,
  installSubagentReportDedupCompat,
} from '../src/host/subagent-report-scheduling-compat.ts'

type Message = Parameters<Agent['followup']>[0]
type DeliveryName = 'followup' | 'steer' | 'inject'

function text(value: string) {
  return { type: 'text', text: value }
}

function report(id: string, childId: string, result: string): Message {
  return {
    id,
    role: 'user',
    content: [text('Background subagent ' + childId + ' reported:'), text(result)],
    source: { kind: 'subagent-report', form: 'relay', senderSessionId: childId },
  } as never
}

function settlement(id: string, childId: string, result: string): Message {
  return {
    id,
    role: 'user',
    content: [
      text('Background subagent ' + childId + ' finished and will do no further work unless you send it more.'),
      text('Its closing message:'),
      text(result),
    ],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: childId },
  } as never
}

function createAgent(nextTurn: Message[] = [], nextStep: Message[] = []) {
  const followup = vi.fn()
  const steer = vi.fn()
  const inject = vi.fn()
  const remove = vi.fn((messageId: string) => {
    for (const queue of [nextStep, nextTurn]) {
      const index = queue.findIndex((message) => message.id === messageId)
      if (index >= 0) {
        queue.splice(index, 1)
        return true
      }
    }
    return false
  })
  const agent = {
    id: 'parent',
    status: 'running',
    inbox: { nextTurn, nextStep, remove },
    followup,
    steer,
    inject,
  } as unknown as Agent
  return { agent, nextTurn, nextStep, remove, followup, steer, inject }
}

function createContext(existing: Agent[] = []) {
  const listeners = new Map<string, Set<(payload: { agent: Agent }) => void>>()
  const warn = vi.fn()
  const ctx = {
    logger: { warn },
    agents: { list: () => existing },
    on(name: string, listener: (payload: { agent: Agent }) => void) {
      const named = listeners.get(name) ?? new Set()
      named.add(listener)
      listeners.set(name, named)
      return () => named.delete(listener)
    },
  }
  return {
    ctx,
    warn,
    emit(name: string, agent: Agent) {
      for (const listener of listeners.get(name) ?? []) listener({ agent })
    },
  }
}

describe('DSH subagent report/settlement dedup compatibility', () => {
  it.each(['followup', 'steer', 'inject'] as const)(
    'discards an exact queued report duplicate before %s delivers settlement',
    (delivery) => {
      const duplicate = report('report-1', 'child-1', 'same result')
      const h = createAgent([duplicate])
      const c = createContext([h.agent])
      const dispose = installSubagentReportDedupCompat(c.ctx as never)
      const notice = settlement('settled-1', 'child-1', 'same result')

      h.agent[delivery](notice)

      expect(h.remove).toHaveBeenCalledOnce()
      expect(h.remove).toHaveBeenCalledWith(duplicate.id)
      expect(h.nextTurn).toEqual([])
      expect(h[delivery]).toHaveBeenCalledOnce()
      expect(h[delivery]).toHaveBeenCalledWith(notice)
      dispose()
    },
  )

  it('deduplicates reports pending in the next-step queue too', () => {
    const duplicate = report('report-1', 'child-1', 'same result')
    const h = createAgent([], [duplicate])
    const c = createContext([h.agent])
    const dispose = installSubagentReportDedupCompat(c.ctx as never)

    h.agent.steer(settlement('settled-1', 'child-1', 'same result'))

    expect(h.remove).toHaveBeenCalledWith(duplicate.id)
    expect(h.nextStep).toEqual([])
    dispose()
  })

  it.each([
    ['different child', report('report-1', 'child-2', 'same result')],
    ['different content', report('report-1', 'child-1', 'partial result')],
  ])('keeps a %s report', (_label, pending) => {
    const h = createAgent([pending])
    const c = createContext([h.agent])
    const dispose = installSubagentReportDedupCompat(c.ctx as never)

    h.agent.steer(settlement('settled-1', 'child-1', 'same result'))

    expect(h.remove).not.toHaveBeenCalled()
    expect(h.nextTurn).toEqual([pending])
    dispose()
  })

  it('keeps reports when settlement has no closing message', () => {
    const pending = report('report-1', 'child-1', 'same result')
    const notice = settlement('settled-1', 'child-1', 'same result') as Message & { content: unknown[] }
    notice.content = [notice.content[0], text('It left no closing message.')]
    const h = createAgent([pending])
    const c = createContext([h.agent])
    const dispose = installSubagentReportDedupCompat(c.ctx as never)

    h.agent.steer(notice)

    expect(h.remove).not.toHaveBeenCalled()
    expect(h.nextTurn).toEqual([pending])
    dispose()
  })

  it('does not inspect or mutate queues for non-settlement traffic', () => {
    const pending = report('report-1', 'child-1', 'same result')
    const h = createAgent([pending])
    const c = createContext([h.agent])
    const dispose = installSubagentReportDedupCompat(c.ctx as never)
    const ordinary = { ...settlement('ordinary-1', 'child-1', 'same result'), source: { kind: 'user' } } as Message

    h.agent.followup(ordinary)

    expect(h.remove).not.toHaveBeenCalled()
    expect(h.nextTurn).toEqual([pending])
    expect(h.followup).toHaveBeenCalledWith(ordinary)
    dispose()
  })

  it('patches agents created after installation and restores all delivery methods', () => {
    const pending = report('report-1', 'child-1', 'same result')
    const h = createAgent([pending])
    const originals = { followup: h.agent.followup, steer: h.agent.steer, inject: h.agent.inject }
    const c = createContext()
    const dispose = installSubagentReportDedupCompat(c.ctx as never)

    c.emit('agent/created', h.agent)
    for (const name of Object.keys(originals) as DeliveryName[]) expect(h.agent[name]).not.toBe(originals[name])
    h.agent.steer(settlement('settled-1', 'child-1', 'same result'))
    expect(h.remove).toHaveBeenCalledOnce()

    c.emit('agent/disposed', h.agent)
    for (const name of Object.keys(originals) as DeliveryName[]) expect(h.agent[name]).toBe(originals[name])
    dispose()
  })

  it.each([
    ['newer installation first', 1, 0],
    ['older installation first', 0, 1],
  ] as const)('keeps overlapping installations active when disposing the %s', (_label, first, second) => {
    const firstPending = report('report-1', 'child-1', 'first result')
    const h = createAgent([firstPending])
    const originalFollowup = h.agent.followup
    const firstContext = createContext([h.agent])
    const firstDispose = installSubagentReportDedupCompat(firstContext.ctx as never)
    const sharedWrapper = h.agent.followup
    const secondContext = createContext([h.agent])
    const secondDispose = installSubagentReportDedupCompat(secondContext.ctx as never)
    const disposers = [firstDispose, secondDispose]

    expect((sharedWrapper as never)[DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER]).toMatchObject({ owners: 2 })
    disposers[first]()

    h.agent.steer(settlement('settled-1', 'child-1', 'first result'))
    expect(h.remove).toHaveBeenCalledWith(firstPending.id)
    expect(h.agent.followup).toBe(sharedWrapper)

    disposers[second]()
    expect(h.agent.followup).toBe(originalFollowup)
  })
})
