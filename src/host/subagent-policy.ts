import type { Context } from '@deepseek-ai/cordis'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubscriptionPreferenceStore } from './preferences.ts'

const MANAGED_DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])

/**
 * Enforce global limits with a user-facing preflight on built-in delegation
 * tools and an authoritative synchronous Agent-publication gate. The latter
 * also covers workflows, Ralph, and nested subagents without depending on the
 * parent's provider or model. Throwing from `agent/created` vetoes and rolls
 * back the new child before its loop starts; already-running children remain.
 */
export function installSubagentPolicy(ctx: Context, preferences: SubscriptionPreferenceStore): () => void {
  const disposePreflight = ctx.on('tools/pre-execute', async (exec, next) => {
    const parent = exec.agent
    if (parent === undefined || !MANAGED_DELEGATION_TOOLS.has(exec.name)) return next()
    const { subagentMaxDepth, subagentMaxAgents } = preferences.status()
    const attemptedDepth = delegationDepthOf(parent) + 1
    if (attemptedDepth > subagentMaxDepth) {
      return { kind: 'deny', reason: `Subagent nesting depth limit reached: attempted depth ${attemptedDepth}, configured maximum ${subagentMaxDepth}.` }
    }
    const root = subagentTreeRoot(ctx, parent)
    const activeAgents = activeDescendantCount(ctx, root.id)
    if (activeAgents >= subagentMaxAgents) {
      return { kind: 'deny', reason: `Subagent limit reached: ${activeAgents} active descendants in the Agent tree, configured maximum ${subagentMaxAgents}. Wait for one to finish or raise the global limit in Subagents settings.` }
    }
    return next()
  })

  const disposePublicationGate = ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return

    const { subagentMaxDepth, subagentMaxAgents } = preferences.status()
    const depth = delegationDepthOf(agent)
    if (depth > subagentMaxDepth) {
      throw new Error(`Subagent nesting depth limit reached: attempted depth ${depth}, configured maximum ${subagentMaxDepth}.`)
    }

    const root = subagentTreeRoot(ctx, agent)
    const activeAgents = activeDescendantCount(ctx, root.id)
    if (activeAgents > subagentMaxAgents) {
      throw new Error(`Subagent limit reached: attempted ${activeAgents} active descendants in the Agent tree, configured maximum ${subagentMaxAgents}. Wait for one to finish or raise the global limit in Subagents settings.`)
    }
  })

  return () => {
    disposePublicationGate()
    disposePreflight()
  }
}

/** Return the highest currently live ancestor that owns this subagent tree. */
export function subagentTreeRoot(ctx: Pick<Context, 'agents'>, agent: Agent): Agent {
  let current = agent
  const visited = new Set<string>([agent.id])
  while (current.session.header.origin === 'subagent') {
    const parentId = current.session.header.parentSession
    if (parentId === undefined || visited.has(parentId)) break
    const parent = ctx.agents.get(parentId)
    if (parent === undefined) break
    visited.add(parent.id)
    current = parent
  }
  return current
}

/** Return currently live descendants in one caller's subagent tree. */
export function activeDescendantIds(ctx: Pick<Context, 'agents'>, parentId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const agent of ctx.agents.list()) {
    if (agent.session.header.origin !== 'subagent') continue
    const directParent = agent.session.header.parentSession
    if (directParent === undefined) continue
    const children = childrenByParent.get(directParent) ?? []
    children.push(agent.id)
    childrenByParent.set(directParent, children)
  }

  const descendants = new Set<string>()
  const pending = [...(childrenByParent.get(parentId) ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (descendants.has(id)) continue
    descendants.add(id)
    pending.push(...(childrenByParent.get(id) ?? []))
  }
  return descendants
}

export function activeDescendantCount(ctx: Pick<Context, 'agents'>, parentId: string): number {
  return activeDescendantIds(ctx, parentId).size
}

