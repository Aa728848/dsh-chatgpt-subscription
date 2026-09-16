import { describe, expect, it } from 'vitest'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import {
  type AllowedModelRoute,
  type AuthorizationAgent,
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

  it('requires an explicit route even when the parent model is authorized', () => {
    const reason = delegationDenialReason(
      recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' }),
      'subagent',
      {},
      PREFERENCE,
      NO_SESSIONS,
    )
    expect(reason).toContain('requires an explicit child model')
    expect(reason).toContain('list_subagent_models')
    expect(reason).toContain('antigravity/gemini-3.8-flash, antigravity/claude-opus-4-6')
  })

  it('denies a half-specified route and names the missing field', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    const missingProvider = delegationDenialReason(
      agent, 'subagent', { model: 'gemini-3.8-flash' }, PREFERENCE, NO_SESSIONS,
    )
    expect(missingProvider).toContain('requires an explicit child model')
    expect(missingProvider).toContain('model "gemini-3.8-flash"')
    expect(missingProvider).toContain('provider must be named together')

    const missingModel = delegationDenialReason(
      agent, 'subagent', { provider: 'antigravity' }, PREFERENCE, NO_SESSIONS,
    )
    expect(missingModel).toContain('provider "antigravity"')
    expect(missingModel).toContain('model must be named together')

    // Empty strings are not a named pair either: they cannot be authorized.
    expect(delegationDenialReason(agent, 'subagent', { provider: '', model: '' }, PREFERENCE, NO_SESSIONS))
      .toContain('not on the Session allowlist')
  })

  it('stays out of the way for authorized routes, other tools, and disabled authorization', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'gemini-3.8-flash',
    }, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'claude-opus-4-6' },
      PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent_fork', {}, PREFERENCE, NO_SESSIONS)).toBeUndefined()
    expect(delegationDenialReason(agent, 'subagent', {}, { enabled: false, allowedModels: [GEMINI] },
      NO_SESSIONS)).toBeUndefined()
  })

  it('keeps a recorded policy authoritative when the settings service is absent', () => {
    const agent = recordingAgent([GEMINI, OPUS], { provider: 'antigravity', model: 'gemini-3.8-flash' })
    expect(delegationDenialReason(agent, 'subagent', {}, undefined, NO_SESSIONS))
      .toContain('requires an explicit child model')
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'gemini-3.8-flash',
    }, undefined, NO_SESSIONS)).toBeUndefined()
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
      .toContain('requires an explicit child model')
    expect(delegationDenialReason(agent, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS, ['subagent'], 'preference')).toBeUndefined()
  })

  it('denies an explicit route that is not registered rather than resolving it locally', () => {
    const agent = recordingAgent([GEMINI, OPUS])
    expect(delegationDenialReason(agent, 'subagent', { provider: 'not-registered', model: 'some-model' },
      PREFERENCE, NO_SESSIONS)).toContain('is not on the Session allowlist')
    expect(delegationDenialReason(agent, 'subagent', { provider: 'not-registered', model: 'gemini-3.8-flash' },
      PREFERENCE, NO_SESSIONS)).toContain('is not on the Session allowlist')
    expect(unauthorizedRouteReason(undefined, undefined, [GEMINI], false)).toContain('the inherited route')
  })

  it('prefers the recorded Session policy over the current preference', () => {
    const agent = recordingAgent([GEMINI], { provider: 'antigravity', model: 'claude-opus-4-6' })
    // OPUS is authorized by the current preference only, and the Session
    // recorded GEMINI alone, so the recorded list decides both the verdict and
    // the routes the denial names.
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'claude-opus-4-6',
    }, PREFERENCE, NO_SESSIONS)).toContain('antigravity/gemini-3.8-flash')
    expect(delegationDenialReason(agent, 'subagent', {
      provider: 'antigravity', model: 'claude-opus-4-6',
    }, PREFERENCE, NO_SESSIONS)).not.toContain('claude-opus-4-6 with')
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
      .toContain('requires an explicit child model')
    const permissive = createSubagentAuthorization({
      settings: SETTINGS as never,
      sessions: NO_SESSIONS,
      toolNames: ['subagent'],
      scope: 'preference',
    })
    expect(permissive(unrecorded, 'subagent', {})).toContain('requires an explicit child model')
    expect(permissive(unrecorded, 'subagent', { provider: 'antigravity', model: 'gemini-3.8-flash' }))
      .toBeUndefined()
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
    const registered: ToolGuard[] = []
    let disposed = 0
    const ctx = {
      tools: { guard: (guard: ToolGuard) => { registered.push(guard); return () => { disposed += 1 } } },
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
    expect(guard(exec as never)).toContain('requires an explicit child model')
    expect(guard({ ...exec, name: 'read' } as never)).toBeUndefined()
    // An agent without a recorded policy stays on the built-in behavior under
    // session scope, even when its own route would be authorized.
    expect(guard({
      ...exec,
      agent: { options: { provider: 'antigravity', model: 'gemini-3.8-flash' } },
    } as never)).toBeUndefined()
    expect(guard({
      ...exec,
      arguments: { provider: 'antigravity', model: 'gemini-3.8-flash' },
    } as never)).toBeUndefined()
    dispose()
    expect(disposed).toBe(1)
    expect(() => installSubagentModelAuthorization(ctx as never, registry({}), { toolNames: [] }))
      .toThrow(/at least one delegation tool/)
  })
})
