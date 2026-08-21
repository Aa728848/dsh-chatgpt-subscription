import { describe, expect, it } from 'vitest'
import { activeDescendantCount, installSubagentPolicy, subagentTreeRoot } from '../src/host/subagent-policy.ts'

interface TestAgent {
  id: string
  options: { subagentDepth?: number }
  session: { header: { origin?: 'subagent'; parentSession?: string; delegationDepth?: number } }
}

function agent(id: string, parentSession?: string, depth = 0): TestAgent {
  return {
    id,
    options: { subagentDepth: depth },
    session: { header: {
      ...(parentSession === undefined ? {} : { origin: 'subagent' as const, parentSession }),
      delegationDepth: depth,
    } },
  }
}

describe('global subagent policy', () => {
  it('counts the complete live descendant tree and resolves its root', () => {
    const root = agent('root')
    const child = agent('child', root.id, 1)
    const grandchild = agent('grandchild', child.id, 2)
    const unrelated = agent('unrelated')
    const agents = [root, child, grandchild, unrelated]
    const ctx = { agents: { list: () => agents, get: (id: string) => agents.find(candidate => candidate.id === id) } }

    expect(activeDescendantCount(ctx as never, root.id)).toBe(2)
    expect(activeDescendantCount(ctx as never, child.id)).toBe(1)
    expect(activeDescendantCount(ctx as never, unrelated.id)).toBe(0)
    expect(subagentTreeRoot(ctx as never, grandchild as never)).toBe(root)
  })

  it('preflights built-in delegation tools with dynamic global limits', async () => {
    const root = agent('root')
    const child = agent('child', root.id, 1)
    const agents = [root, child]
    let preExecute: ((exec: { name: string; agent?: TestAgent }, next: () => Promise<{ kind: 'allow' }>) => Promise<{ kind: string; reason?: string }>) | undefined
    const ctx = {
      agents: {
        list: () => agents,
        get: (id: string) => agents.find(candidate => candidate.id === id),
      },
      on(name: string, callback: unknown) {
        if (name === 'tools/pre-execute') preExecute = callback as typeof preExecute
        return () => undefined
      },
    }
    let limits = { subagentMaxDepth: 1, subagentMaxAgents: 1 }
    installSubagentPolicy(ctx as never, { status: () => limits } as never)
    const allow = async () => ({ kind: 'allow' as const })

    await expect(preExecute!({ name: 'subagent', agent: child }, allow)).resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('nesting depth limit') })
    await expect(preExecute!({ name: 'subagent_fork', agent: root }, allow)).resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('Subagent limit reached') })
    await expect(preExecute!({ name: 'read', agent: root }, allow)).resolves.toEqual({ kind: 'allow' })

    limits = { subagentMaxDepth: 3, subagentMaxAgents: 2 }
    await expect(preExecute!({ name: 'subagent', agent: root }, allow)).resolves.toEqual({ kind: 'allow' })
  })

  it('vetoes over-limit child publication for all in-process creation paths', () => {
    const root = agent('root')
    const child = agent('child', root.id, 1)
    const agents = [root, child]
    let createdListener: ((payload: { agent: TestAgent }) => void) | undefined
    const ctx = {
      agents: {
        list: () => agents,
        get: (id: string) => agents.find(candidate => candidate.id === id),
      },
      on(name: string, callback: unknown) {
        if (name === 'agent/created') createdListener = callback as typeof createdListener
        return () => undefined
      },
    }
    let limits = { subagentMaxDepth: 1, subagentMaxAgents: 1 }
    installSubagentPolicy(ctx as never, { status: () => limits } as never)

    const tooDeep = agent('too-deep', child.id, 2)
    agents.push(tooDeep)
    expect(() => createdListener!({ agent: tooDeep })).toThrow('nesting depth limit reached')
    agents.pop()

    limits = { subagentMaxDepth: 3, subagentMaxAgents: 1 }
    const tooMany = agent('too-many', root.id, 1)
    agents.push(tooMany)
    expect(() => createdListener!({ agent: tooMany })).toThrow('Subagent limit reached')
    agents.pop()

    limits = { subagentMaxDepth: 3, subagentMaxAgents: 2 }
    agents.push(tooMany)
    expect(() => createdListener!({ agent: tooMany })).not.toThrow()
  })
})
