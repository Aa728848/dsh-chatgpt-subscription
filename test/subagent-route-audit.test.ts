import { describe, expect, it } from 'vitest'
import {
  type AuditedRoute,
  type AuditedSession,
  type AuditedSessions,
  auditChildRoutes,
  auditedRoutesOf,
  childRoutesOf,
  effectiveRouteOf,
  readChildDescriptor,
  violationText,
} from '../src/host/subagent-route-audit.ts'

/**
 * The shapes below are the real durable ones: a parent records one
 * `subagent/catalog` event per continuable child, and the child records one
 * `subagent/descriptor` whose `agentProvider`/`agentModel` are its resolved
 * route. The `kimi-code/k3` parent and `antigravity`-only allowlist reproduce
 * the live fork escape this audit exists to surface.
 */

const GEMINI: AuditedRoute = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const ALLOWED: AuditedRoute[] = [GEMINI, { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' }]

/** A session whose log and header are plain fixtures. */
function session(
  id: string,
  events: unknown[],
  header: { parentSession?: string; origin?: string } = {},
  requestHeader?: { config: { provider?: string; model?: string; reasoningEffort?: string } },
): AuditedSession {
  return {
    id,
    header,
    events: events as { type?: unknown; data?: unknown }[],
    ...requestHeader === undefined ? {} : { requestHeader: () => requestHeader },
  } as AuditedSession
}

/** Registry double backed by an id map, with the listing the audit sweeps. */
function registry(entries: AuditedSession[]): AuditedSessions & { list(): AuditedSession[] } {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  return {
    get: (id: string) => byId.get(id),
    list: () => [...byId.values()],
  }
}

const policyEvent = { type: 'subagent/model-selection-policy', data: { allowedModels: [...ALLOWED] } }
const catalogEvent = (childId: string) => ({ type: 'subagent/catalog', data: { childId } })
const descriptorEvent = (data: unknown) => ({ type: 'subagent/descriptor', data })

describe('subagent route audit', () => {
  it('reads the policy a session recorded, ignoring malformed entries', () => {
    expect(auditedRoutesOf(session('p', [policyEvent]))).toEqual(ALLOWED)
    expect(auditedRoutesOf(session('p', []))).toBeUndefined()
    expect(auditedRoutesOf(session('p', [{ type: 'session' }]))).toBeUndefined()
    expect(auditedRoutesOf(session('p', [
      { type: 'subagent/model-selection-policy', data: { allowedModels: [{ provider: 'a' }, 7] } },
    ]))).toBeUndefined()
  })

  it('parses a descriptor only when it carries something to report', () => {
    expect(readChildDescriptor({ version: 3, mode: 'continuable', provider: 'fork', agentProvider: 'kimi-code', agentModel: 'k3', label: 'L' }))
      .toEqual({ provider: 'fork', childProvider: 'kimi-code', childModel: 'k3', label: 'L' })
    expect(readChildDescriptor({ version: 3, provider: 'spawn' }))
      .toEqual({ provider: 'spawn' })
    expect(readChildDescriptor(undefined)).toBeUndefined()
    expect(readChildDescriptor({ agentModel: '' })).toBeUndefined()
  })

  it('discovers children through the catalog and through the registry sweep', () => {
    const child = session('c1', [descriptorEvent({ provider: 'fork', agentProvider: 'kimi-code', agentModel: 'k3' })],
      { parentSession: 'p', origin: 'subagent' })
    const orphan = session('c2', [descriptorEvent({ provider: 'spawn' })], { parentSession: 'p', origin: 'subagent' })
    const unrelated = session('c3', [descriptorEvent({ provider: 'spawn' })], { parentSession: 'other' })
    const parent = session('p', [policyEvent, catalogEvent('c1')])
    const sessions = registry([parent, child, orphan, unrelated])
    const found = childRoutesOf(parent, sessions).map(entry => entry.childId)
    expect(found).toEqual(['c1', 'c2'])
    // A child whose descriptor never landed is skipped, not reported as a guess.
    expect(childRoutesOf(session('p', [catalogEvent('missing')]), registry([]))).toEqual([])
  })

  it('treats a declared route as declared and an absent one as inherited from the parent', () => {
    const parent = session('p', [policyEvent], {}, { config: { provider: 'kimi-code', model: 'k3' } })
    const sessions = registry([parent])
    expect(effectiveRouteOf({ childId: 'c', childProvider: 'a', childModel: 'b' }, sessions))
      .toEqual({ provider: 'a', model: 'b', sameAsParent: false })
    expect(effectiveRouteOf({ childId: 'c', parentId: 'p' }, sessions))
      .toEqual({ provider: 'kimi-code', model: 'k3', sameAsParent: true })
    // A child on the parent's own route reports equality, even when it declared it.
    expect(effectiveRouteOf({ childId: 'c', parentId: 'p', childProvider: 'kimi-code', childModel: 'k3' }, sessions))
      .toEqual({ provider: 'kimi-code', model: 'k3', sameAsParent: true })
    // An unresolvable parent yields an unresolved route rather than a guess,
    // and two unresolved routes are never reported as equal.
    expect(effectiveRouteOf({ childId: 'c', parentId: 'gone' }, sessions))
      .toEqual({ sameAsParent: false })
    expect(effectiveRouteOf({ childId: 'c' }, sessions)).toEqual({ sameAsParent: false })
  })

  it('reports the fork escape: an inheriting child on an unauthorized parent route', () => {
    const parent = session('p', [policyEvent, catalogEvent('c1')], {}, { config: { provider: 'kimi-code', model: 'k3' } })
    const child = session('c1', [descriptorEvent({ provider: 'fork', label: '实现梁神 preset 重构' })],
      { parentSession: 'p', origin: 'subagent' })
    const sessions = registry([parent, child])
    const violations = auditChildRoutes(parent, sessions, auditedRoutesOf(parent))
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      route: { provider: 'kimi-code', model: 'k3' },
      sameAsParent: true,
    })
    expect(violationText(violations[0]!)).toContain('the same route as its parent')
    expect(violationText(violations[0]!)).toContain('kimi-code/k3')
    expect(violationText(violations[0]!)).toContain('实现梁神 preset 重构')
  })

  it('accepts an inheriting child whose parent route is authorized', () => {
    const parent = session('p', [policyEvent, catalogEvent('c1')], {},
      { config: { provider: 'antigravity', model: 'gemini-3.8-flash' } })
    const child = session('c1', [descriptorEvent({ provider: 'fork' })], { parentSession: 'p', origin: 'subagent' })
    expect(auditChildRoutes(parent, registry([parent, child]), ALLOWED)).toEqual([])
  })

  it('reports a child that declared its own unauthorized route', () => {
    const parent = session('p', [policyEvent, catalogEvent('c1')], {},
      { config: { provider: 'antigravity', model: 'gemini-3.8-flash' } })
    const child = session('c1', [descriptorEvent({ provider: 'spawn', agentProvider: 'codex-chatgpt', agentModel: 'gpt-6-astra' })],
      { parentSession: 'p', origin: 'subagent' })
    const violations = auditChildRoutes(parent, registry([parent, child]), ALLOWED)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.sameAsParent).toBe(false)
    expect(violationText(violations[0]!)).toContain('a route of its own')
  })

  it('reports nothing without an allowlist, and never guesses an unresolved route', () => {
    const parent = session('p', [catalogEvent('c1')], {}, { config: { provider: 'kimi-code', model: 'k3' } })
    const child = session('c1', [descriptorEvent({ provider: 'fork' })], { parentSession: 'p', origin: 'subagent' })
    const sessions = registry([parent, child])
    expect(auditChildRoutes(parent, sessions, undefined)).toEqual([])
    expect(auditChildRoutes(parent, sessions, [])).toEqual([])
    // A header-less parent leaves the route unknown: advisory means no accusation.
    const bare = session('p', [catalogEvent('c1')])
    expect(auditChildRoutes(bare, registry([bare, child]), ALLOWED)).toEqual([])
    expect(violationText({
      finding: { childId: 'c' }, route: {}, sameAsParent: false,
    })).toContain('unresolved route')
  })

  it('tolerates a resolver with no listing', () => {
    const parent = session('p', [policyEvent, catalogEvent('c1')])
    const child = session('c1', [descriptorEvent({ provider: 'fork', agentProvider: 'x', agentModel: 'y' })],
      { parentSession: 'p', origin: 'subagent' })
    const noList: AuditedSessions = { get: id => (id === 'c1' ? child : undefined) }
    expect(childRoutesOf(parent, noList).map(entry => entry.childId)).toEqual(['c1'])
  })
})
