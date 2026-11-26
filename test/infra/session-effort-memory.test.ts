import { describe, expect, it } from 'vitest'
import { SessionEffortMemory } from '../../src/host/common/session-effort-memory.ts'
import type { EffortFollowRequest } from '../../src/host/common/session-effort-memory.ts'

const main = (effort?: string, model = 'm1', sessionId = 's1'): EffortFollowRequest => ({ model, sessionId, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
const aux = (purpose = 'compaction', extra: Record<string, unknown> = {}): EffortFollowRequest => ({ model: 'm1', sessionId: 's1', purpose, ...extra })

describe('SessionEffortMemory', () => {
  it('gives an unnamed auxiliary request the main turn effort', () => {
    const memory = new SessionEffortMemory()
    memory.follow(main('high'))
    for (const purpose of ['compaction', 'timeline-report', 'auto-review']) {
      expect(memory.follow(aux(purpose)).reasoningEffort).toBe('high')
    }
  })

  it('returns the same object when nothing changes', () => {
    const memory = new SessionEffortMemory()
    const first = main('high')
    expect(memory.follow(first)).toBe(first)
    const named = aux('compaction', { reasoningEffort: 'low' })
    expect(memory.follow(named)).toBe(named)
  })

  it('leaves the request unnamed when the main turn named nothing, so the line default applies to both', () => {
    const memory = new SessionEffortMemory()
    memory.follow(main('high'))
    memory.follow(main())
    expect(memory.follow(aux()).reasoningEffort).toBeUndefined()
  })

  it('does not follow across sessions or models, nor without a session', () => {
    const memory = new SessionEffortMemory()
    memory.follow(main('high'))
    expect(memory.follow({ ...aux(), sessionId: 's2' }).reasoningEffort).toBeUndefined()
    expect(memory.follow({ ...aux(), model: 'm2' }).reasoningEffort).toBeUndefined()
    expect(memory.follow<EffortFollowRequest>({ model: 'm1', purpose: 'compaction' }).reasoningEffort).toBeUndefined()
  })

  it('keeps title requests out of the memory in both directions', () => {
    const memory = new SessionEffortMemory()
    memory.follow(main('high'))
    expect(memory.follow(aux('session-title')).reasoningEffort).toBeUndefined()
    memory.follow({ model: 'm1', sessionId: 's1' }, true)
    expect(memory.follow(aux()).reasoningEffort).toBe('high')
  })

  it('is not overwritten by an auxiliary request that names its own effort', () => {
    const memory = new SessionEffortMemory()
    memory.follow(main('high'))
    memory.follow(aux('compaction', { reasoningEffort: 'low' }))
    expect(memory.follow(aux()).reasoningEffort).toBe('high')
  })

  it('drops the least recently used session past the cap', () => {
    const memory = new SessionEffortMemory(2)
    memory.follow(main('high', 'm1', 'a'))
    memory.follow(main('high', 'm1', 'b'))
    memory.follow(main('high', 'm1', 'a'))
    memory.follow(main('high', 'm1', 'c'))
    expect(memory.follow({ ...aux(), sessionId: 'b' }).reasoningEffort).toBeUndefined()
    expect(memory.follow({ ...aux(), sessionId: 'a' }).reasoningEffort).toBe('high')
  })
})
