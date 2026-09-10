import { describe, expect, it } from 'vitest'
import {
  type AllowedModelRoute,
  type AuthorizationAgent,
  type DelegationGuard,
  type PolicySession,
  type SessionsResolver,
  type SubagentModelSelectionPreference,
  authorizedRoutesFor,
  createSubagentAuthorization,
  delegationDenialReason,
  installSubagentModelAuthorization,
  normalizeDelegationToolNames,
  parseAllowedRoutes,
  policyRoutesOf,
  subagentModelSelectionPreference,
  unauthorizedRouteReason,
  validateAuthorizationScope,
  validateDelegationToolNames,
} from '../src/host/subagent-model-authorization.ts'

const GEMINI: AllowedModelRoute = { provider: 'antigravity', model: 'gemini-3.8-flash' }
const OPUS: AllowedModelRoute = { provider: 'antigravity', model: 'claude-opus-4-6' }
const PREFERENCE: SubagentModelSelectionPreference = { enabled: true, allowedModels: [GEMINI, OPUS] }
const NO_SESSIONS: SessionsResolver = { get: () => undefined }
const DEEPSEEK_OPTIONS = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** Minimal Session double over a dense event list. */
function session(
  events: readonly unknown[],
  header: { origin?: unknown; parentSession?: unknown } = {},
): PolicySession {
  return {
    header,
    eventAt(seq: number) {
      return events[seq] as { type?: unknown; data?: unknown } | undefined
    },
  }
}

/** Session registry double backed by an id map. */
function registry(entries: Record<string, PolicySession>): SessionsResolver {
  return { get: id => entries[id] }
}

function policyEvent(routes: readonly AllowedModelRoute[]): unknown {
  return { type: 'subagent/model-selection-policy', data: { allowedModels: [...routes] } }
}

/** An agent whose Session recorded the allowlist the delegation tool snapshots. */
function recordingAgent(
  routes: readonly AllowedModelRoute[],
  options: { provider?: string; model?: string } = DEEPSEEK_OPTIONS,
): AuthorizationAgent {
  return { options, session: session([policyEvent(routes)]) }
}

/** Settings-provider double serving one resolved namespace value. */
function settingsServing(value: unknown) {
  return {
    register(_namespace: unknown, schema: { (input: unknown): unknown }) {
      return { get: () => schema(value) }
    },
  }
}

const SETTINGS = settingsServing({ enabled: true, allowedModels: [GEMINI, OPUS] })

describe('subagent model authorization', () => {
  it('parses only well-formed routes out of a policy payload', () => {
    expect(parseAllowedRoutes({ allowedModels: [GEMINI, { provider: 'x' }, { provider: '', model: 'm' },
      { provider: 'a', model: '' }, 7] })).toEqual([GEMINI])
    expect(parseAllowedRoutes({ allowedModels: [] })).toBeUndefined()
    expect(parseAllowedRoutes({ allowedModels: 'nope' })).toBeUndefined()
    expect(parseAllowedRoutes(undefined)).toBeUndefined()
  })

  it('reads the policy a Session recorded and tolerates gaps and failing accessors', () => {
    expect(policyRoutesOf(session([{ type: 'session' }, policyEvent([GEMINI])]))).toEqual([GEMINI])
    expect(policyRoutesOf(session([{ type: 'session' }]))).toBeUndefined()
    expect(policyRoutesOf(undefined)).toBeUndefined()
    expect(policyRoutesOf({})).toBeUndefined()
    expect(policyRoutesOf({ eventAt() { throw new Error('log unavailable') } })).toBeUndefined()
  })

  it('inherits an ancestor policy only through a subagent lineage', () => {
    const child = session([{ type: 'session' }], { origin: 'subagent', parentSession: 'parent' })
    const root = session([policyEvent([GEMINI])])
    expect(authorizedRoutesFor({ session: child }, registry({ parent: root }))).toEqual([GEMINI])
    expect(authorizedRoutesFor(
      { session: session([], { parentSession: 'parent' }) },
      registry({ parent: root }),
    )).toBeUndefined()
    expect(authorizedRoutesFor(
      { session: session([], { origin: 'subagent', parentSession: 'missing' }) },
      registry({}),
    )).toBeUndefined()
    expect(authorizedRoutesFor({}, registry({}))).toBeUndefined()
  })

  it('reads the Host preference and refuses an unusable settings service', () => {
    expect(subagentModelSelectionPreference(settingsServing({ enabled: true, allowedModels: [GEMINI] }) as never))
      .toEqual({ enabled: true, allowedModels: [GEMINI] })
    expect(subagentModelSelectionPreference(undefined)).toBeUndefined()
    expect(subagentModelSelectionPreference({} as never)).toBeUndefined()
    expect(subagentModelSelectionPreference({
      register() { throw new Error('namespace unavailable') },
    } as never)).toBeUndefined()
  })

  it('denies an explicit route outside the allowlist with the authorized routes', () => {
    const reason = delegationDenialReason(
      recordingAgent([GEMINI, OPUS]),
      'subagent',
      { provider: 'codex-chatgpt', model: 'gpt-6-astra' },
      PREFERENCE,
      NO_SESSIONS,
    )
    expect(reason).toContain('codex-chatgpt/gpt-6-astra')
    expect(reason).toContain('antigravity/gemini-3.8-flash, antigravity/claude-opus-4-6')
  })

  it('denies the inherited parent route when the parent model is not authorized', () => {
    const reason = delegationDenialReason(recordingAgent([GEMINI, OPUS]), 'subagent', {}, PREFERENCE, NO_SESSIONS)
    expect(reason).toContain('inherit from the parent')
    expect(reason).toContain('deepseek-official/deepseek-flash')
  })

  it('stays out of the way for authorized routes, other tools, and disabled authorization', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'claude-opus-4-6' },
      PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, { enabled: false, allowedModels: [GEMINI] },
      NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, { enabled: true, allowedModels: [] },
      NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, undefined, NO_SESSIONS)).toBeUndefined()
  })

  it('leaves a Session that recorded no policy on the built-in behavior', () => {
    const agent: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(delegationDenialReason(agent, 'subagent', { provider: 'codex-chatgpt', model: 'gpt-6-astra' },
      PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason({}, 'subagent', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
  })

  it('governs an unrecorded Session only under preference scope', () => {
    const agent: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS, ['subagent'], 'preference'))
      .toContain('deepseek-official/deepseek-flash')
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'preference')).toBeUndefined()
  })

  it('leaves an incompletely resolvable route to the delegation tool', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    expect(delegationDenialReason(agent, 'subagent', { provider: 'not-registered' }, PREFERENCE, NO_SESSIONS))
      .toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', { model: 'some-model' }, PREFERENCE, NO_SESSIONS))
      .toBeUndefined()
    expect(unauthorizedRouteReason(undefined, undefined, [GEMINI], false)).toContain('the inherited route')
  })

  it('prefers the recorded Session policy over the current preference', () => {
    const agent = recordingAgent([GEMINI], { provider: 'antigravity', model: 'claude-opus-4-6' })
    expect(delegationDenialReason(agent, 'subagent', {}, PREFERENCE, NO_SESSIONS))
      .toContain('antigravity/claude-opus-4-6')
  })

  it('binds the guard to the Session policy, the preference, and the configured names', () => {
    const authorize = createSubagentAuthorization({
      settings: SETTINGS as never,
      sessions: NO_SESSIONS,
      toolNames: ['delegate'],
    })
    const unrecorded: AuthorizationAgent = { options: DEEPSEEK_OPTIONS }
    expect(authorize(unrecorded, 'subagent', {})).toBeUndefined()
    expect(authorize(unrecorded, 'delegate', {})).toBeUndefined()
    expect(authorize(recordingAgent([GEMINI, OPUS]), 'delegate', {}))
      .toContain('deepseek-official/deepseek-flash')
    const permissive = createSubagentAuthorization({
      settings: SETTINGS as never,
      sessions: NO_SESSIONS,
      toolNames: ['subagent'],
      scope: 'preference',
    })
    expect(permissive(unrecorded, 'subagent', {})).toContain('deepseek-official/deepseek-flash')
  })

  it('normalizes and validates delegation names and scope at the configuration boundary', () => {
    expect(normalizeDelegationToolNames(undefined)).toEqual(['subagent'])
    expect(normalizeDelegationToolNames([])).toEqual(['subagent'])
    expect(normalizeDelegationToolNames([' subagent ', 'subagent', 'delegate']))
      .toEqual(['subagent', 'delegate'])
    expect(validateDelegationToolNames(['subagent'])).toEqual(['subagent'])
    expect(() => { validateDelegationToolNames([]) }).toThrow(/at least one delegation tool/)
    expect(() => { validateDelegationToolNames([' delegate']) }).toThrow(/non-empty trimmed string/)
    expect(validateAuthorizationScope('session')).toBe('session')
    expect(validateAuthorizationScope('preference')).toBe('preference')
    expect(() => { validateAuthorizationScope('everything') }).toThrow(/must be "session" or "preference"/)
  })

  it('registers one monotonic guard on the Host tool registry', () => {
    const registered: DelegationGuard[] = []
    let disposed = 0
    const ctx = {
      tools: { guard: (guard: DelegationGuard) => { registered.push(guard); return () => { disposed += 1 } } },
      get: (name: string) => name === 'settings' ? SETTINGS : undefined,
    }
    const dispose = installSubagentModelAuthorization(
      ctx as never,
      registry({}),
      { toolNames: ['subagent'] },
    )
    expect(registered).toHaveLength(1)
    const guard = registered[0]!
    const exec = { name: 'subagent', arguments: {}, agent: recordingAgent([GEMINI, OPUS]), signal: new AbortController().signal }
    expect(guard(exec as never)).toContain('deepseek-official/deepseek-flash')
    expect(guard({ ...exec, name: 'read' } as never)).toBeUndefined()
    expect(guard({ ...exec, agent: { options: { provider: 'antigravity', model: 'gemini-3.8-flash' } } } as never))
      .toBeUndefined()
    dispose()
    expect(disposed).toBe(1)
    expect(() => installSubagentModelAuthorization(ctx as never, registry({}), { toolNames: [] }))
      .toThrow(/at least one delegation tool/)
  })
})
